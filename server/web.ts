import { weatherDashboard } from "./weather/web.ts";
import { changeExperiment, startExperiment } from "./weather/ledger.ts";
import { notificationDefaults, saveWeatherNotifications } from "./weather/notifications.ts";
import { seedWallet, strategies, walletPattern } from "../lib/strategies.ts";
import { comboMoney, comboStates, type ComboRecord } from "../lib/combos.ts";
import { activeStrategies } from "../lib/market-scope.ts";
import { createPairing, pairingHash, sessionCookie, sessionUser, telegramIdentity } from "./auth.ts";
import { database, log } from "./db.ts";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const noStore = { "cache-control": "no-store" };
const json = (data: unknown, status = 200, cookie?: string) => Response.json(data, {
  status, headers: { ...noStore, ...(cookie ? { "set-cookie": cookie } : {}) },
});
const allowedNumber = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;

async function dataFor(user: string | null) {
  const sql = database();
  const [wallets, health, runs, userRows] = await sql.transaction([
    sql`select address,name,source,public_pnl::float8 from lab.wallets
      order by case when address=${seedWallet} then 0 when source='research' then 1 else 2 end,public_pnl desc nulls last limit 55`,
    sql`select source,at,details from lab.heartbeats where source in ('neon','polymarket','telegram')`,
    sql`select e.id,e.strategy,e.mode,e.bank::float8,e.cash::float8,e.stake::float8,e.starts_at,e.ends_at,e.paused,e.risk_blocked,
      e.wallet,w.name as wallet_name, (e.exposure*100)::float8 as max_exposure,
      (e.drawdown*100)::float8 as max_drawdown, e.slippage, count(t.id) filter(where t.opened_at is not null)::int as fills,
      count(t.id) filter(where t.settled_at is not null)::int as settled,coalesce(sum(t.pnl),0)::float8 as pnl
      from lab.experiments e left join lab.wallets w on w.address=e.wallet
      left join lab.visible_trades t on t.experiment=e.id
      where e.user_id=${user} and e.strategy in ('copy','combo')
      group by e.id,w.name order by e.starts_at desc limit 100`,
    sql`select name,alerts,chat_id is not null as linked from lab.users where id=${user}`,
  ]);
  return { wallets, health, runs, user: userRows[0] ?? null,
    bot: process.env.TELEGRAM_BOT_USERNAME || null, asOf: new Date().toISOString() };
}
async function startRun(user: string, payload: Record<string, unknown>) {
  const strategy = payload.strategy as typeof activeStrategies[number];
  const { mode, bank, stake, days, drawdown, exposure, slippage, requestId } = payload;
  if (!activeStrategies.includes(strategy) || (mode !== "auto" && mode !== "confirm" && mode !== "both")
    || typeof requestId !== "string" || !uuidPattern.test(requestId)
    || !allowedNumber(bank, 10, 1_000_000) || !allowedNumber(stake, 1, bank)
    || !allowedNumber(days, 1 / 24, 365) || !allowedNumber(drawdown, 1, 100)
    || !allowedNumber(exposure, 1, 100) || !allowedNumber(slippage, 0, 5000) || !Number.isInteger(slippage)
    || stake > bank * exposure / 100) return json({ error: "invalid_parameters" }, 400);
  const wallet = strategy === "copy" ? String(payload.wallet ?? seedWallet).toLowerCase() : null;
  if (wallet && !walletPattern.test(wallet)) return json({ error: "invalid_wallet" }, 400);
  const sql = database();
  if (wallet) await sql`insert into lab.wallets(address,name,source) values(${wallet},${wallet.slice(0,10)},'manual') on conflict do nothing`;
  const modes = mode === "both" ? ["auto", "confirm"] : [mode];
  const [account] = await sql`select chat_id from lab.users where id=${user}`;
  if (modes.includes("confirm") && !account?.chat_id) return json({ error: "telegram_chat_required" }, 409);
  const version = strategies[strategy].version;
  const rules = JSON.stringify({ ...strategies[strategy], bank, stake, days, drawdown, exposure, slippage, wallet });
  const result = await sql`with inserted as (
    insert into lab.experiments(user_id,strategy,version,mode,rules,bank,cash,stake,drawdown,exposure,slippage,wallet,starts_at,ends_at,peak,request_id)
    select ${user},${strategy},${version},m,${rules},${bank},${bank},${stake},${drawdown / 100},${exposure / 100},${slippage},${wallet},
      now(),now()+${Math.round(days * 86400)}*interval '1 second',${bank} ,${requestId} from unnest(${modes}::text[]) m
    on conflict(user_id,request_id,mode) where request_id is not null do nothing returning *
    ) insert into lab.equity(experiment,at,value,cash,coverage) select id,starts_at,bank,cash,true from inserted returning experiment`;
  if (result.length) return json({ ids: result.map(r => r.experiment) }, 201);
  const prior = await sql`select id from lab.experiments where user_id=${user} and request_id=${requestId} order by mode`;
  return json({ ids: prior.map(r => r.id) });
}

async function historyFor(user: string, url: URL) {
  const filter = url.searchParams.get("status") ?? "all";
  const cursor = url.searchParams.get("cursor");
  if (!["trades","settled","open","pending","skipped","all","filled","partial","unfilled","processing","queued"].includes(filter)) {
    return json({ error: "invalid_request" }, 400);
  }
  const [time, id] = cursor?.split("|") ?? [];
  if (cursor && (!time || !id || !Number.isFinite(Date.parse(time)) || !uuidPattern.test(id))) return json({ error: "invalid_request" }, 400);
  const rows = await database()`select id,status,reason,strategy,label,observed_at,opened_at,settled_at,expires_at,slug,outcome,mode,
      wallet,wallet_name,source_at,source_side,source_price,price,shares,cost,fee,pnl,payout,unrealized_pnl
    from lab.visible_trades where user_id=${user} and (
      ${filter}='all' or (${filter}='trades' and opened_at is not null) or (${filter}='settled' and settled_at is not null)
      or (${filter}='open' and opened_at is not null and settled_at is null)
      or (${filter}='skipped' and status in ('unfilled','skipped')) or (status=${filter} and (status<>'pending' or expires_at>now()))
    ) and (${time ?? null}::timestamptz is null or (observed_at,id)<(${time ?? null}::timestamptz,${id ?? null}::uuid))
    order by observed_at desc,id desc limit 51`;
  const visible = rows.slice(0,50);
  const last = visible.at(-1);
  const next = rows.length > 50 && last ? new Date(last.observed_at).toISOString() + "|" + last.id : null;
  return json({ rows: visible, next });
}

async function combosFor(url: URL) {
  const filter = url.searchParams.get("status") ?? "all";
  const cursor = url.searchParams.get("cursor");
  const wallet = url.searchParams.get("wallet");
  const [time, id] = cursor?.split("|") ?? [];
  if ((filter !== "all" && !Object.hasOwn(comboStates, filter)) || (wallet && !walletPattern.test(wallet))
    || (cursor && (!time || !id || !Number.isFinite(Date.parse(time)) || !/^0x[0-9a-f]{40}:\d{1,80}$/i.test(id)))) {
    return json({ error: "invalid_request" }, 400);
  }

  const sql = database();
  const [rows, status] = await sql.transaction([
    sql`with page as (
      select c.id,c.wallet,c.stake::float8 as entry,c.event_at,c.detected_at,c.payload,w.name
      from lab.combos c left join lab.wallets w on w.address=c.wallet
      where (${filter}='all' or c.payload->>'status'=${filter}) and (${wallet}::text is null or c.wallet=${wallet})
        and (${time ?? null}::timestamptz is null or (c.event_at,c.id)<(${time ?? null}::timestamptz,${id ?? null}::text))
        and not exists (select 1 from jsonb_array_elements(c.payload->'legs') leg
          where lab.hidden_market(coalesce(leg->'market'->>'question',leg->'market'->>'title'),
            coalesce(leg->'market'->>'slug',leg->'market'->'event'->>'event_slug')))
      order by c.event_at desc,c.id desc limit 26
    )
    select c.*,r.received,r.paid_at,r.tx_hash from page c left join lateral (
      select sum(amount)::float8 as received,max(paid_at) as paid_at,
        case when count(*)=1 then min(tx_hash) end as tx_hash
      from lab.combo_redemptions where combo_id=c.id
    ) r on true order by c.event_at desc,c.id desc`,
    sql`select at,details from lab.heartbeats where source='combos'`,
  ]);

  const visible = rows.slice(0,25).map((row): ComboRecord => {
    const { payload } = row;
    return {
      id: row.id, wallet: row.wallet, name: row.name, entry: row.entry, event_at: row.event_at,
      detected_at: row.detected_at, paid_at: row.paid_at, tx_hash: row.tx_hash,
      ...comboMoney(row.entry, payload.gross_entry_cost_usdc ?? null, payload.entry_fees_usdc ?? null,
        payload.status, payload.realized_payout_usdc ?? null, row.received, payload.redeemable === true),
      fee: payload.entry_fees_usdc ?? null, status: payload.status, redeemable: payload.redeemable === true,
      resolved_at: payload.resolved_at ?? null, legs: payload.legs,
    };
  });
  const last = visible.at(-1);
  return json({ rows: visible,
    next: rows.length > 25 && last ? new Date(last.event_at).toISOString() + "|" + last.id : null,
    monitor: status[0] ? { ...status[0].details, checkedAt: status[0].at } : null });
}

export async function web(req: Request, route: string[]) {
  const action = route.join("/");
  try {
    if (req.method === "GET" && action === "health") {
      if (!process.env.DATABASE_URL) return json({ ok: false, database: "unconfigured" }, 503);
      await database()`select 1 from lab.markets limit 1`;
      return json({ ok: true, database: "connected" });
    }
    if (req.method === "GET" && action === "combos") return await combosFor(new URL(req.url));
    const user = sessionUser(req);
    if (req.method === "GET" && action === "weather") return json(await weatherDashboard(user));
    if (req.method === "GET" && action === "workspace") {
      if (!process.env.DATABASE_URL) return json({ error: "database_unconfigured" }, 503);
      return json(await dataFor(user));
    }
    if (req.method === "GET" && action === "history") return user ? await historyFor(user, new URL(req.url)) : json({ error: "login_required" }, 401);
    if (req.method !== "POST") return json({ error: "not_found" }, 404);
    if (req.headers.get("origin") !== new URL(req.url).origin && req.headers.get("origin") !== process.env.APP_URL) {
      return json({ error: "origin_rejected" }, 403);
    }
    if (!req.headers.get("content-type")?.includes("application/json") || Number(req.headers.get("content-length")) > 12000) {
      return json({ error: "invalid_request" }, 400);
    }
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "invalid_request" }, 400);
    const sql = database();
    if (action === "auth/telegram") {
      const identity = telegramIdentity(String(input.initData ?? ""), process.env.TELEGRAM_BOT_TOKEN ?? "");
      if (!identity) return json({ error: "invalid_telegram_identity" }, 401);
      await sql`insert into lab.users(id,name) values(${identity.id},${identity.name}) on conflict(id) do update set name=excluded.name`;
      return json({ ok: true }, 200, sessionCookie(identity.id));
    }
    if (action === "auth/pair") {
      if (!process.env.TELEGRAM_BOT_USERNAME) return json({ error: "telegram_unconfigured" }, 503);
      const pair = await createPairing();
      return json({ ...pair, url: "https://t.me/" + process.env.TELEGRAM_BOT_USERNAME + "?start=lab_" + pair.code });
    }
    if (action === "auth/claim") {
      if (![input.code,input.secret].every(s => typeof s === "string" && /^[\w-]{32}$/.test(s))) return json({ error: "invalid_pairing" }, 400);
      const rows = await sql`update lab.pairings set consumed_at=now() where code_hash=${pairingHash(input.code)}
        and proof_hash=${pairingHash(input.secret)} and user_id is not null and consumed_at is null and expires_at>now() returning user_id`;
      return rows.length ? json({ ok: true }, 200, sessionCookie(rows[0].user_id)) : json({ pending: true }, 202);
    }
    if (!user) return json({ error: "login_required" }, 401);
    if (action === "weather/notifications") {
      if (!Object.keys(notificationDefaults).every(key => typeof input[key] === "boolean")) return json({ error: "invalid_request" }, 400);
      await saveWeatherNotifications(user,input);
      return json({ ok:true });
    }
    if (action === "weather/start") {
      const id = await startExperiment(user);
      return id ? json({ id }, 201) : json({ error: "weather_not_ready_or_active" }, 409);
    }
    if (action === "weather/control") {
      if (typeof input.id !== "string" || !uuidPattern.test(input.id)
        || !["running","paused","stopped"].includes(input.status)) return json({ error: "invalid_request" }, 400);
      return await changeExperiment(user, input.id, input.status) ? json({ ok: true }) : json({ error: "experiment_inactive" }, 409);
    }
    if (action === "experiments") return await startRun(user, input);
    if (action === "experiments/pause") {
      if (typeof input.id !== "string" || !uuidPattern.test(input.id) || typeof input.paused !== "boolean") {
        return json({ error: "invalid_request" }, 400);
      }
      const result = await sql`update lab.experiments set paused=${input.paused}
        where id=${input.id} and user_id=${user} and strategy in ('copy','combo') and ends_at>now() and not risk_blocked returning id`;
      return result.length ? json({ ok: true }) : json({ error: "experiment_inactive" }, 409);
    }
    if (action === "settings" && typeof input.alerts === "boolean") {
      await sql`update lab.users set alerts=${input.alerts} where id=${user}`;
      return json({ ok: true });
    }
    if (action === "auth/logout") return json({ ok: true }, 200, "polytrader_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return json({ error: "not_found" }, 404);
  } catch (error) {
    await log("web_api", error);
    return json({ error: "service_unavailable" }, 503);
  }
}
