import { btcRule, seedWallet, strategies, strategyIds, walletPattern, type Strategy } from "../lib/strategies.ts";
import { wilson } from "../lib/metrics.ts";
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
  const [markets, wallets, combos, health, runs, trades, equity, errors, userRows, collectorWindows] = await sql.transaction([
    sql`select condition,slug,title,ends_at,interval_minutes,outcomes,prices,seen_at,fee from lab.markets
      where open and ends_at>now() and seen_at>now()-interval '5 minutes' order by ends_at limit 32`,
    sql`select w.address,w.name,w.source,w.public_pnl::float8,w.volume_shares::float8,w.history_complete,
      h.records,h.buys,h.sells,h.redeems,h.first_at,h.last_at
      from lab.wallets w left join lateral (select count(*)::int records,
        count(*) filter(where payload->>'type'='TRADE' and payload->>'side'='BUY')::int buys,
        count(*) filter(where payload->>'type'='TRADE' and payload->>'side'='SELL')::int sells,
        count(*) filter(where payload->>'type'='REDEEM')::int redeems,min(event_at) first_at,max(event_at) last_at
        from lab.wallet_activity where wallet=w.address) h on true order by case when address=${seedWallet} then 0 when source='research' then 1 else 2 end,public_pnl desc nulls last limit 48`,
    sql`select c.id,c.wallet,c.stake::float8,c.event_at,c.detected_at,c.payload,w.name,
      coalesce(w.public_pnl::float8,null) as author_pnl from lab.combos c left join lab.wallets w on w.address=c.wallet
      order by detected_at desc limit 60`,
    sql`select source,at,details from lab.heartbeats where source in ('neon','collector','polymarket','telegram')`,
    sql`select e.id,e.strategy,e.version,e.mode,e.rules,e.bank::float8,e.cash::float8,e.stake::float8,e.starts_at,e.ends_at,e.paused,e.risk_blocked,
      e.worst_drawdown::float8 as drawdown,e.wallet, coalesce(s.fills,0) as fills,coalesce(s.settled,0) as settled,
      coalesce(s.wins,0) as wins,coalesce(s.pnl,0) as pnl,coalesce(s.fees,0) as fees,s.slippage,q.value::float8 as equity,
      (select count(*)::int from lab.decisions d where d.experiment=e.id and d.status in ('unfilled','skipped')) as missed,
      (select percentile_cont(0.95) within group(order by abs((s.evidence->>'timingErrorMs')::float8))
        from lab.decisions d join lab.signals s on s.id=d.signal where d.experiment=e.id and coalesce(s.reason,'') not in ('missing_collector_window','missing_catalog_window')) as timing_p95,
      (select count(*)::int from lab.decisions d join lab.signals s on s.id=d.signal where d.experiment=e.id and s.reason in ('missing_collector_window','missing_catalog_window')) as timing_missing,
      (select coalesce(sum(p.pnl),0)::float8 from lab.positions p where p.experiment=e.id and p.settled_at>now()-interval '7 days') as weekly_pnl,
      (select count(*)::int from lab.positions p where p.experiment=e.id and p.settled_at>now()-interval '7 days') as weekly_settled,
      (select count(*)::int from lab.positions p where p.experiment=e.id and p.settled_at>now()-interval '7 days' and p.pnl>0) as weekly_wins
      from lab.experiments e
      left join lateral (select count(*)::int fills,count(*) filter(where settled_at is not null)::int settled,
        count(*) filter(where pnl>0)::int wins,sum(pnl)::float8 pnl,sum(fee)::float8 fees,avg(slippage)::float8 slippage
        from lab.positions where experiment=e.id) s on true
      left join lateral (select value from lab.equity where experiment=e.id order by at desc limit 1) q on true
      where e.user_id=${user} order by e.starts_at desc limit 100`,
    sql`select d.id,d.status,d.reason,d.updated_at,s.strategy,s.label,s.observed_at,s.target_at,
      jsonb_build_object('timingErrorMs',s.evidence->'timingErrorMs','detectionDelayMs',s.evidence->'detectionDelayMs',
        'modeledShares',s.evidence->'modeledShares','modeledSpread',s.evidence->'modeledSpread') as evidence,
      d.execution,p.shares::float8,p.price::float8,p.cost::float8,p.fee::float8,p.pnl::float8,p.settled_at,p.opened_at,p.slippage::float8,m.slug,q.outcome,
      (p.shares*q.mark-p.cost)::float8 as unrealized_pnl,e.mode,e.version
      from lab.decisions d join lab.signals s on s.id=d.signal join lab.experiments e on e.id=d.experiment
      left join lab.positions p on p.decision=d.id left join lab.markets m on m.condition=s.condition
      left join lateral (select m.outcomes->>(t.ord::int-1) as outcome,
        case when p.settled_at is null and m.open and m.ends_at>now() and m.seen_at>now()-interval '3 minutes'
          then (m.prices->>(t.ord::int-1))::numeric end as mark
        from jsonb_array_elements_text(m.tokens) with ordinality t(token,ord) where t.token=s.token) q on true
      where e.user_id=${user} order by s.observed_at desc,d.id desc limit 5`,
    sql`select experiment,bucket as at,value::float8 from (
      select distinct on (q.experiment,date_trunc('hour',q.at))
        q.experiment,date_trunc('hour',q.at) bucket,q.value
      from lab.equity q join lab.experiments e on e.id=q.experiment
      where e.user_id=${user} and q.at>now()-interval '90 days'
      order by q.experiment,date_trunc('hour',q.at),q.at desc
      ) points order by bucket limit 15000`,
    sql`select area,max(at) as at,count(*)::int as count from lab.logs where at>now()-interval '24 hours' group by area order by at desc limit 12`,
    sql`select name,alerts,chat_id is not null as linked from lab.users where id=${user}`,
    sql`select strategy,
      count(*) filter(where coalesce(evidence->>'windowObserved', 'true')='true'
        and coalesce(reason,'') not in ('missing_collector_window','missing_catalog_window'))::int as observed,
      count(*) filter(where evidence->>'windowObserved'='false'
        or reason in ('missing_collector_window','missing_catalog_window'))::int as missed
      from lab.signals where strategy in ('btc5','btc15') and observed_at>=now()-interval '24 hours'
        and target_at<=now() group by strategy`,
  ]);
  return { markets, wallets, combos, health, trades, equity, errors, collectorWindows, user: userRows[0] ?? null,
    runs: runs.map(r => ({ ...r, winRate: r.settled ? r.wins / r.settled : null,
      interval95: wilson(r.wins, r.settled), weeklyInterval95: wilson(r.weekly_wins, r.weekly_settled), roi: r.pnl / r.bank })),
    bot: process.env.TELEGRAM_BOT_USERNAME || null, asOf: new Date().toISOString() };
}
async function startRun(user: string, payload: Record<string, unknown>) {
  const strategy = payload.strategy as Strategy;
  const { mode, bank, stake, days, drawdown, exposure, slippage, requestId } = payload;
  if (!strategyIds.includes(strategy) || (mode !== "auto" && mode !== "confirm" && mode !== "both")
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
  const rules = JSON.stringify({ ...strategies[strategy], bank, stake, days, drawdown, exposure, slippage, wallet,
    ...(strategy === "btc15" || strategy === "btc5" ? btcRule(strategy === "btc15" ? 15 : 5, 0) : {}) });
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
  if (!["all","filled","partial","unfilled","pending","processing","queued","skipped"].includes(filter)) return json({ error: "invalid_request" }, 400);
  const [time, id] = cursor?.split("|") ?? [];
  if (cursor && (!time || !id || !Number.isFinite(Date.parse(time)) || !uuidPattern.test(id))) return json({ error: "invalid_request" }, 400);
  const rows = await database()`select d.id,d.status,d.reason,d.updated_at,s.strategy,s.label,s.observed_at,s.target_at,
      jsonb_build_object('timingErrorMs',s.evidence->'timingErrorMs','detectionDelayMs',s.evidence->'detectionDelayMs',
        'modeledShares',s.evidence->'modeledShares','modeledSpread',s.evidence->'modeledSpread') as evidence,
    d.execution,p.shares::float8,p.price::float8,p.cost::float8,p.fee::float8,p.pnl::float8,p.settled_at,p.opened_at,p.slippage::float8,m.slug,q.outcome,
      (p.shares*q.mark-p.cost)::float8 as unrealized_pnl,e.mode,e.version
    from lab.decisions d join lab.signals s on s.id=d.signal join lab.experiments e on e.id=d.experiment
    left join lab.positions p on p.decision=d.id left join lab.markets m on m.condition=s.condition
      left join lateral (select m.outcomes->>(t.ord::int-1) as outcome,
        case when p.settled_at is null and m.open and m.ends_at>now() and m.seen_at>now()-interval '3 minutes'
          then (m.prices->>(t.ord::int-1))::numeric end as mark
        from jsonb_array_elements_text(m.tokens) with ordinality t(token,ord) where t.token=s.token) q on true
      where e.user_id=${user} and (${filter}='all' or d.status=${filter})
    and (${time ?? null}::timestamptz is null or (s.observed_at,d.id)<(${time ?? null}::timestamptz,${id ?? null}::uuid))
    order by s.observed_at desc,d.id desc limit 51`;
  const visible = rows.slice(0,50);
  const last = visible.at(-1);
  const next = rows.length > 50 && last ? new Date(last.observed_at).toISOString() + "|" + last.id : null;
  return json({ rows: visible, next });
}

export async function web(req: Request, route: string[]) {
  const action = route.join("/");
  try {
    if (req.method === "GET" && action === "health") {
      if (!process.env.DATABASE_URL) return json({ ok: false, database: "unconfigured" }, 503);
      await database()`select 1 from lab.markets limit 1`;
      return json({ ok: true, database: "connected" });
    }
    const user = sessionUser(req);
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
    if (action === "experiments") return await startRun(user, input);
    if (action === "experiments/pause") {
      if (typeof input.id !== "string" || !uuidPattern.test(input.id) || typeof input.paused !== "boolean") {
        return json({ error: "invalid_request" }, 400);
      }
      const result = await sql`update lab.experiments set paused=${input.paused}
        where id=${input.id} and user_id=${user} and ends_at>now() and not risk_blocked returning id`;
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
