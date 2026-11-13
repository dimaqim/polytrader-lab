import { database, log } from "./db.ts";
import { equal, pairingHash } from "./auth.ts";
import { executeDecision } from "./signals.ts";
import { systemHealth, tradingReports } from "./reporting.ts";

type Message = { text: string; reply_markup?: object };
type TelegramUser = { id: number; first_name?: string };
type Update = {
  update_id: number;
  message?: { from?: TelegramUser; chat: { id: number; type: string }; text?: string };
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: Update["message"] };
};

export async function telegram(method: string, body: object) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("telegram_unconfigured");
  const result = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const payload = await result.json();
  if (!result.ok || !payload.ok) throw new Error(`Telegram ${method} HTTP ${result.status} retry=${Number(payload.parameters?.retry_after ?? 0)}`);
  return payload.result;
}
function appButton(text: string, section = "") {
  const url = process.env.APP_URL;
  return url ? [{ text, web_app: { url: new URL(section ? "#" + section : "/", url).href } }] : [];
}
const menu = () => ({
  inline_keyboard: [
    appButton("Открыть журнал сделок", "history"),
    appButton("Начать копировать", "start"),
    [...appButton("Трейдеры", "copy"), ...appButton("Комбо", "combos")],
    [{ text: "Мои тесты", callback_data: "tests" }, { text: "Помощь", callback_data: "help" }],
  ].filter(row => row.length),
});
async function reply(chatId: string, text: string) {
  return telegram("sendMessage", { chat_id: chatId, text, reply_markup: menu() });
}

export async function deliverNotifications(signalId?: string, urgentOnly = false) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const sql = database();
  for (let i = 0; i < 12; i++) {
    const rows = await sql`with candidate as (
      select o.key from lab.outbox o where sent_at is null and next_at<=now() and attempts<6
        and (lease_at is null or lease_at<now()-interval '30 seconds')
        and (payload->>'expires_at' is null or (payload->>'expires_at')::timestamptz>now())
        and (${signalId ?? null}::text is null or payload->>'signal_id'=${signalId ?? null})
        and (not ${urgentOnly}::boolean or key like 'signal:%')
        and key not like 'health:%' and key not like 'collector:%'
        and not exists (
          select 1 from lab.decisions d join lab.signals s on s.id=d.signal left join lab.markets m on m.condition=s.condition
          where d.id=case when o.key ~ '^(signal|result):[0-9a-f-]{36}$' then split_part(o.key,':',2)::uuid end
          and (s.strategy not in ('copy','combo') or lab.hidden_market(s.label,coalesce(m.slug,s.evidence->>'slug'))
            or (o.key like 'signal:%' and (d.status<>'pending' or s.expires_at<=now())))
        )
        and not exists (
          select 1 from lab.positions p join lab.markets m on m.condition=p.condition
          where p.id=case when o.key ~ '^settle:[0-9a-f-]{36}$' then split_part(o.key,':',2)::uuid end
          and lab.hidden_market(m.title,m.slug)
        )
      order by (payload->>'expires_at')::timestamptz nulls last,next_at limit 1 for update skip locked
    ) update lab.outbox o set lease_at=now(),attempts=attempts+1 from candidate c where o.key=c.key returning o.*`;
    const row = rows[0];
    if (!row) return;
    const payload = row.payload as Message & { expires_at?: string; section?: string };
    try {
      if (payload.expires_at && Date.parse(payload.expires_at) <= Date.now()) continue;
      const section = payload.section ?? "history";
      const actions = { inline_keyboard: [appButton(section === "combos" ? "Открыть комбо" : "Открыть журнал", section)] };
      await telegram("sendMessage", { chat_id: row.chat_id, text: payload.text, reply_markup: payload.reply_markup ?? actions });
      await sql`update lab.outbox set sent_at=now() where key=${row.key}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const wait = Math.max(2 ** row.attempts * 15, Number(/retry=(\d+)/.exec(message)?.[1] ?? 0));
      await sql`update lab.outbox set lease_at=null,next_at=now()+${wait}*interval '1 second',
        attempts=case when ${message.includes("HTTP 403")} then 6 else attempts end where key=${row.key}`;
      await log("telegram_delivery", error);
      if (message.includes("HTTP 429")) return;
    }
  }
}

async function commandReply(action: string, user: string) {
  const sql = database();
  switch (action) {
    case "start": return "В журнале видно, кого вы копируете, когда вошли и чем закончилась сделка. Для первого теста выберите «Начать копировать». Все суммы виртуальные.";
    case "help": return "Выберите трейдера и сумму на одну сделку. Бот замечает его покупки и проверяет текущую цену, доступный объём и лимиты вашего теста.\n\nВ режиме «С подтверждением» бот спросит перед покупкой. Позиция закрывается после официального расчёта рынка. Продажи трейдера не копируются.";
    case "status": return systemHealth();
    case "strategies":
    case "tests": {
      const rows = await sql`select e.strategy,e.mode,e.paused,e.risk_blocked,e.ends_at,w.name
        from lab.experiments e left join lab.wallets w on w.address=e.wallet
        where e.user_id=${user} and e.strategy in ('copy','combo') and e.ends_at>now()
        order by e.starts_at desc limit 10`;
      return rows.length ? ["Ваши тесты", ...rows.map(row =>
        `${row.name ?? (row.strategy === "combo" ? "Наблюдение за комбо" : "Копирование")} · ${row.mode === "auto" ? "Авто" : "С подтверждением"}\n` +
        `${row.risk_blocked ? "Остановлен лимитом риска" : row.paused ? "На паузе" : "Работает"} до ${new Date(row.ends_at).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" })}`)
      ].join("\n\n") : "У вас пока нет текущих тестов. Нажмите «Начать копировать», чтобы создать первый.";
    }
    case "stats":
    case "portfolio": return (await tradingReports(user, action === "portfolio" ? "portfolio" : "stats"))[0]?.message
      ?? "Статистика появится после запуска теста.";
    case "pause":
    case "resume": {
      const paused = action === "pause";
      const changed = await sql`update lab.experiments set paused=${paused} where user_id=${user}
        and strategy in ('copy','combo') and paused<>${paused} and ends_at>now() and not risk_blocked returning id`;
      return paused ? `Тестов поставлено на паузу: ${changed.length}` : `Тестов возобновлено: ${changed.length}`;
    }
    default: return null;
  }
}
export async function webhook(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !equal(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = await req.json() as Update;
  if (!Number.isSafeInteger(update.update_id)) return Response.json({ ok: true });
  const sql = database();
  const lease = await sql`insert into lab.telegram_updates(id) values(${update.update_id})
    on conflict(id) do update set lease_at=now() where not lab.telegram_updates.done and lab.telegram_updates.lease_at<now()-interval '15 seconds'
    returning id`;
  if (!lease.length) {
    const [existing] = await sql`select done from lab.telegram_updates where id=${update.update_id}`;
    return Response.json({ ok: !!existing?.done }, { status: existing?.done ? 200 : 503 });
  }
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  const user = callback?.from ?? message?.from;
  try {
    if (message?.chat.type === "private" && user && user.id === message.chat.id) {
      const userId = String(user.id);
      await sql`insert into lab.users(id,name,chat_id) values(${userId},${(user.first_name ?? "Telegram").slice(0,100)},${userId})
        on conflict(id) do update set chat_id=excluded.chat_id,name=excluded.name`;
      if (callback) {
        const action = callback.data ?? "";
        let answer = "Действие недоступно";
        let acceptedId: string | undefined;
        const response = await commandReply(action, userId);
        if (response) answer = "Готово";
        else {
          const match = /^(yes|no):([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/.exec(action);
          if (match) {
            const confirm = match[1] === "yes";
            const rows = await sql`update lab.decisions d set status=${confirm ? "queued" : "skipped"},
              reason=${confirm ? null : "user_skipped"},ready_at=greatest(clock_timestamp(),d.ready_at),updated_at=now()
              from lab.experiments e,lab.signals s where d.id=${match[2]} and d.experiment=e.id and d.signal=s.id and e.user_id=${userId}
              and s.strategy='copy' and not lab.hidden_market(s.label,coalesce(s.evidence->>'slug',(select m.slug from lab.markets m where m.condition=s.condition)))
              and d.status='pending' and e.ends_at>now() and s.expires_at>now() and not e.paused and not e.risk_blocked returning d.id,s.strategy`;
            if (rows.length) {
              answer = confirm ? "Подтверждено. Проверяю стакан." : "Сигнал пропущен";
              if (confirm) acceptedId = rows[0].id;
            } else answer = "Вход уже обработан или недоступен. Проверьте журнал.";
          }
        }
        try { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: answer }); }
        catch (error) { await log("telegram_callback", error); }
        if (response) await reply(userId, response);
        if (acceptedId) {
          try { await executeDecision(acceptedId); await deliverNotifications(); }
          catch (error) { await log("telegram_execution", error); }
        }
      } else if (message.text?.trim()) {
        const [input, code] = message.text.trim().split(/\s+/, 2);
        const [command, bot] = input.toLowerCase().split("@", 2);
        const ownCommand = !bot || bot === process.env.TELEGRAM_BOT_USERNAME?.toLowerCase();
        if (ownCommand && command === "/start" && /^lab_[\w-]{32}$/.test(code ?? "")) {
          const rows = await sql`update lab.pairings set user_id=${userId}
            where code_hash=${pairingHash(code.slice(4))} and user_id is null and expires_at>now() returning user_id`;
          await reply(userId, rows.length ? "Вход подтверждён. Вернитесь в браузер." : "Код входа истёк или уже использован.");
        } else if (ownCommand && command.startsWith("/")) {
          const response = await commandReply(command.slice(1), userId);
          if (response) await reply(userId, response);
        }
      }
    }
    await sql`update lab.telegram_updates set done=true where id=${update.update_id}`;
    return Response.json({ ok: true });
  } catch (error) {
    await log("telegram_webhook", error);
    await sql`update lab.telegram_updates set lease_at=now()-interval '16 seconds' where id=${update.update_id} and not done`;
    return Response.json({ error: "retry" }, { status: 503 });
  }
}
