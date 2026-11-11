import { database, log } from "./db.ts";
import { equal, pairingHash } from "./auth.ts";
import { executeDecision } from "./signals.ts";

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
const menu = () => ({
  inline_keyboard: [
    ...(process.env.APP_URL ? [[{ text: "Открыть Mini App", web_app: { url: process.env.APP_URL } }]] : []),
    [{ text: "Пауза", callback_data: "pause" }, { text: "Статистика", callback_data: "stats" }],
  ],
});
async function reply(chatId: string, text: string) {
  return telegram("sendMessage", { chat_id: chatId, text, reply_markup: menu() });
}

export async function deliverNotifications() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const sql = database();
  for (let i = 0; i < 12; i++) {
    const rows = await sql`with candidate as (
      select key from lab.outbox where sent_at is null and next_at<=now() and attempts<6
        and (lease_at is null or lease_at<now()-interval '30 seconds') order by next_at limit 1 for update skip locked
    ) update lab.outbox o set lease_at=now(),attempts=attempts+1 from candidate c where o.key=c.key returning o.*`;
    const row = rows[0];
    if (!row) return;
    const payload = row.payload as Message;
    try {
      await telegram("sendMessage", { chat_id: row.chat_id, ...payload, reply_markup: payload.reply_markup ?? menu() });
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

async function statistics(user: string) {
  const [row] = await database()`select count(*) filter(where e.ends_at>now() and not e.paused) as active,
    coalesce(sum((select sum(p.pnl) from lab.positions p where p.experiment=e.id)),0)::float8 as pnl
    from lab.experiments e where e.user_id=${user}`;
  return `PolyTrader Lab · Статистика\nАктивных тестов: ${row.active}\nРассчитанный PnL: $${Number(row.pnl).toFixed(2)}`;
}
async function pause(user: string) {
  const changed = await database()`update lab.experiments set paused=true where user_id=${user} and not paused and ends_at>now() returning id`;
  return `Тестов поставлено на паузу: ${changed.length}`;
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
        if (action === "pause") answer = await pause(userId);
        else if (action === "stats") { await reply(userId, await statistics(userId)); answer = "Отчёт открыт"; }
        else {
          const match = /^(yes|no):([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/.exec(action);
          if (match) {
            const confirm = match[1] === "yes";
            const rows = await sql`update lab.decisions d set status=${confirm ? "queued" : "skipped"},
              reason=${confirm ? null : "user_skipped"},ready_at=greatest(now(),d.ready_at),updated_at=now()
              from lab.experiments e,lab.signals s where d.id=${match[2]} and d.experiment=e.id and d.signal=s.id and e.user_id=${userId}
              and d.status='pending' and e.ends_at>now() and s.expires_at>now() and not e.paused and not e.risk_blocked returning d.id`;
            if (rows.length) {
              answer = confirm ? "Подтверждено. Проверяю стакан." : "Сигнал пропущен";
              if (confirm) acceptedId = rows[0].id;
            } else answer = "Сигнал уже обработан или истёк";
          }
        }
        try { await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: answer }); }
        catch (error) { await log("telegram_callback", error); }
        if (acceptedId) {
          await executeDecision(acceptedId);
          await deliverNotifications();
        }
      } else if (message.text) {
        const [command, code] = message.text.trim().split(/\s+/, 2);
        if (command === "/start" && /^lab_[\w-]{32}$/.test(code ?? "")) {
          const rows = await sql`update lab.pairings set user_id=${userId}
            where code_hash=${pairingHash(code.slice(4))} and user_id is null and expires_at>now() returning user_id`;
          await reply(userId, rows.length ? "Вход подтверждён. Вернитесь в браузер." : "Код входа истёк или уже использован.");
        } else if (command === "/stats") await reply(userId, await statistics(userId));
        else if (command === "/pause") await reply(userId, await pause(userId));
        else if (command === "/start" || command === "/help") await reply(userId, "PolyTrader Lab · Лаборатория виртуальных стратегий Polymarket. Откройте Mini App, чтобы запустить тест.");
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
