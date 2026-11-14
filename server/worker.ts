import { createHash } from "node:crypto";
import { database, date, log } from "./db.ts";
import { marketBySlug, marketByCondition, page, request, type Activity, type Page, type Leader } from "./polymarket.ts";
import { walletPattern } from "../lib/strategies.ts";
import { hiddenMarket } from "../lib/market-scope.ts";
import { distributeSignals, executeDecision, recordSignal, upsertMarket } from "./signals.ts";
import { deliverNotifications, telegram } from "./telegram.ts";
import { tradingReports } from "./reporting.ts";
import { scanCombos } from "./combos.ts";

const minute = 60_000;
// Large historical wallet backfills must be explicitly opted into. The live copy
// scanner remains functional without writing every historical activity to Neon.
const neonWalletHistoryArchive = process.env.NEON_WALLET_ACTIVITY_ARCHIVE === "true";
const activityId = (a: Activity) => String(a.id ?? a.sequence_id ?? createHash("sha256").update(JSON.stringify([
  a.transaction_hash, a.type, a.condition_id, a.token_id ?? a.asset, a.side, a.timestamp, a.price, a.size, a.usdc_size,
])).digest("hex"));

async function protect(area: string, work: () => Promise<unknown>) {
  try { await work(); return true; }
  catch (error) { await log(area, error); return false; }
}
async function archive(wallet: string, rows: Activity[]) {
  const entries = rows.filter(a => Number.isFinite(a.timestamp) && a.transaction_hash)
    .map(a => ({ id: activityId(a), at: date(a.timestamp * 1000), payload: a }));
  if (!entries.length) return;
  await database()`insert into lab.wallet_activity(wallet,id,event_at,payload)
    select ${wallet},x.id,x.at,x.payload from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
    as x(id text,at timestamptz,payload jsonb) on conflict do nothing`;
}
async function archiveHasSpace() {
  const [storage] = await database()`select pg_total_relation_size('lab.wallet_activity')::float8 as bytes`;
  return storage.bytes < 750 * 1024 ** 2;
}

async function backfillHistory() {
  if (!await archiveHasSpace()) return;
  const sql = database();
  const [wallet] = await sql`select address,history_cursor,history_end from lab.wallets where not history_complete
    order by case when source='research' then 0 else 1 end,updated_at limit 1`;
  if (!wallet) return;
  const end = wallet.history_end ?? Math.floor(Date.now() / 1000);
  const result = await page<Activity>("/activity", { user: wallet.address, start: "1", end: String(end),
    limit: "500", exclude_deposits_withdrawals: "false", ...(wallet.history_cursor ? { cursor: wallet.history_cursor } : {}) });
  await archive(wallet.address, result.data);
  await sql`update lab.wallets set history_cursor=${result.pagination.next_cursor},history_complete=${!result.pagination.has_more},
    history_end=${end},updated_at=now() where address=${wallet.address}`;
}

async function discoverWallets() {
  const result = await page<Leader>("/leaderboard", { category: "crypto", time_period: "week", limit: "12" });
  const rows = result.data.filter(r => walletPattern.test(r.user_id) && Number.isFinite(r.pnl) && Number.isFinite(r.volume))
    .map(r => ({ address: r.user_id.toLowerCase(), name: (r.user_name || r.name || r.user_id.slice(0, 10)).slice(0, 100), pnl: r.pnl, volume: r.volume }));
  await database()`insert into lab.wallets(address,name,source,public_pnl,volume_shares)
    select r.address,r.name,'crypto',r.pnl,r.volume
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(address text,name text,pnl numeric,volume numeric)
    on conflict(address) do update set public_pnl=excluded.public_pnl,volume_shares=excluded.volume_shares`;
}

async function scanCopy(wallet: string, saveArchive: boolean) {
  const now = Date.now();
  const params = { user: wallet, type: "TRADE", start: String(Math.floor((now - 3 * minute) / 1000)),
    end: String(Math.floor(now / 1000)), limit: "100" };
  let cursor: string | null = null;
  let complete = false;
  const collected: { trade: Activity; observed: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const result: Page<Activity> = await page<Activity>("/activity", { ...params, ...(cursor ? { cursor } : {}) });
    const observed = Date.now();
    if (saveArchive) await archive(wallet, result.data);
    collected.push(...result.data.map(trade => ({ trade, observed })));
    cursor = result.pagination.next_cursor;
    if (!result.pagination.has_more) { complete = true; break; }
  }
  if (!complete) await log("copy_coverage", new Error("Полная выборка окна не поместилась в один запуск"));
  const markets = new Map<string, Awaited<ReturnType<typeof marketBySlug>>>();
  for (const { trade: a, observed } of collected.reverse()) {
    if (a.type !== "TRADE" || !Number.isFinite(a.timestamp) || a.timestamp * 1000 > observed || hiddenMarket(a.title, a.slug)) continue;
    const key = "copy:" + wallet + ":" + activityId(a);
    const token = a.token_id ?? a.asset;
    let reason = a.side === "BUY" ? undefined : "source_sell_outside_v1";
    let market;
    if (!reason && (a.price <= 0 || a.price >= 1 || !/^\d+$/.test(token))) reason = "invalid_source_trade";
    if (!reason) {
      const cached = await database()`select 1 from lab.signals where key=${key}`;
      if (cached.length) continue;
      if (!markets.has(a.slug)) {
        if (markets.size >= 6) reason = "market_lookup_budget";
        else {
          try { markets.set(a.slug, a.slug ? await marketBySlug(a.slug) : await marketByCondition(a.condition_id)); }
          catch (error) { await log("copy_market", error); markets.set(a.slug, null); }
        }
      }
      market = markets.get(a.slug);
      if (!market || market.condition !== a.condition_id || !market.tokens.includes(token)) reason = reason ?? "missing_market";
      else await upsertMarket(market);
    }
    if (market && hiddenMarket(market.title, market.slug)) continue;
    await recordSignal({ key, strategy: "copy", wallet, condition: market?.condition, token, label: a.title || "Copy Trading",
      targetAt: observed, observedAt: observed, expiresAt: Math.min(observed + 90_000, market?.endsAt ?? Infinity),
      reference: a.price > 0 && a.price < 1 ? a.price : undefined, reason,
      evidence: { upstreamAt: a.timestamp * 1000, detectionDelayMs: observed - a.timestamp * 1000, side: a.side, slug: a.slug, outcome: a.outcome, complete } });
  }
}

async function settleAndMark() {
  const sql = database();
  const markets = await sql`select distinct m.slug,m.condition from lab.markets m join lab.positions p on p.condition=m.condition
    where p.settled_at is null order by m.slug limit 16`;
  for (const m of markets) await protect("market_refresh", async () => {
    const next = await marketBySlug(m.slug);
    if (next && next.condition === m.condition) await upsertMarket(next);
  });
  const positions = await sql`select p.id, (m.payout->>(select ord::int-1 from jsonb_array_elements_text(m.tokens)
    with ordinality as t(token,ord) where token=p.token))::numeric as payout
    from lab.positions p join lab.markets m on m.condition=p.condition where p.settled_at is null and m.payout is not null limit 200`;
  for (const p of positions) if (p.payout !== null) await sql`select lab.settle_position(${p.id},${p.payout})`;
  await sql`with valuation as (
    select e.id,e.cash, case when count(p.id)=count(q.mark) then e.cash+coalesce(sum(p.shares*q.mark),0) end as value
    from lab.experiments e left join lab.positions p on p.experiment=e.id and p.settled_at is null
    left join lab.markets m on m.condition=p.condition
    left join lateral (select (m.prices->>(ord::int-1))::numeric as mark from jsonb_array_elements_text(m.tokens) with ordinality t(token,ord)
      where t.token=p.token and m.open and m.ends_at>now() and m.seen_at>now()-interval '3 minutes') q on true
    where (e.ends_at>now()-interval '10 minutes' or p.id is not null)
    group by e.id
  ), inserted as (
    insert into lab.equity(experiment,at,value,cash,coverage)
    select id,date_trunc('minute',now()),value,cash,value is not null from valuation
    on conflict(experiment,at) do update set value=excluded.value,cash=excluded.cash,coverage=excluded.coverage returning *
  ) update lab.experiments e set
    peak=greatest(e.peak,i.value),
    worst_drawdown=case when i.value is null then e.worst_drawdown else greatest(e.worst_drawdown,1-i.value/e.peak) end,
    risk_blocked=e.risk_blocked or (i.value is not null and 1-i.value/e.peak>=e.drawdown),
    marked_at=now()
    from inserted i where i.experiment=e.id`;
}

async function checkServices() {
  const [gamma, clob, data, bot] = await Promise.all([
    protect("health_gamma", () => request("https://gamma-api.polymarket.com/markets?limit=1", fetch, 1)),
    protect("health_clob", () => request("https://clob.polymarket.com/time", fetch, 1)),
    protect("health_data", () => page<Leader>("/leaderboard", { category: "crypto", time_period: "week", limit: "1" })),
    protect("health_telegram", () => telegram("getMe", {})),
  ]);
  const sql = database();
  await sql`insert into lab.heartbeats(source,at,details) values
    ('polymarket',now(),${JSON.stringify({ gamma, clob, data })}),
    ('telegram',now(),${JSON.stringify({ bot })})
    on conflict(source) do update set at=excluded.at,details=excluded.details`;
}

async function experimentNotifications() {
  const sql = database();
  const rows = await sql`select e.id,e.strategy,e.mode,u.chat_id, coalesce(sum(p.pnl),0)::float8 as pnl,
      count(p.id) filter(where p.settled_at is null)::int as open
    from lab.experiments e join lab.users u on u.id=e.user_id left join lab.positions p on p.experiment=e.id
    where e.strategy in ('copy','combo') and e.ends_at<=now() and e.ends_at>now()-interval '24 hours' and u.alerts and u.chat_id is not null
      and not exists(select 1 from lab.outbox o where o.key='completed:'||e.id)
    group by e.id,u.chat_id`;
  for (const e of rows) {
    const message = `Тест завершён. ${e.strategy === "copy" ? "Копирование сделок" : "Наблюдение за комбо"} (${e.mode === "auto" ? "авто" : "с подтверждением"})\nИтог закрытых сделок: $${e.pnl.toFixed(2)}`
      + (e.open ? `\nОжидают расчёта: ${e.open}` : "");
    await sql`insert into lab.outbox(key,chat_id,payload) values(${"completed:" + e.id},${e.chat_id},${JSON.stringify({ text: message })})
      on conflict do nothing`;
  }

}

export async function runWorker(slot: number, daily = false) {
  const sql = database();
  const job = daily ? "daily" : "monitor";
  const slots = await sql`insert into lab.job_runs(job,slot) values(${job},${date(slot)})
    on conflict(job,slot) do update set lease_at=now() where not lab.job_runs.done and lab.job_runs.lease_at<now()-interval '75 seconds'
    returning slot`;
  if (!slots.length) return;
  if (daily) {
    await protect("wallet_discovery", discoverWallets);
    for (const report of await tradingReports(null, "daily")) {
      await sql`insert into lab.outbox(key,chat_id,payload)
        values(${"daily:" + report.id + ":" + date(slot)},${report.chat},${JSON.stringify({ text: report.message })})
        on conflict do nothing`;
    }
  } else {
    const jobs = [
      protect("copy", async () => {
        const wallets = await sql`select distinct wallet from lab.experiments where strategy='copy' and not paused and not risk_blocked and ends_at>now() and wallet is not null limit 8`;
        const saveArchive = neonWalletHistoryArchive && wallets.length > 0 && await archiveHasSpace();
        let failed = 0;
        for (const { wallet } of wallets) if (!await protect("copy_wallet", () => scanCopy(wallet, saveArchive))) failed++;
        if (failed) throw new Error("Some watched wallets could not be checked");
      }),
      protect("portfolio", settleAndMark),
    ];
    if (Math.floor(slot / minute) % 5 === 0) jobs.push(protect("combo", scanCombos));
    const health = await Promise.all(jobs);
    await distributeSignals();
    await deliverNotifications(undefined, true);
    await sql`update lab.decisions d set status='unfilled',reason='expired',updated_at=now()
      from lab.signals s,lab.experiments e where d.signal=s.id and d.experiment=e.id
      and s.strategy in ('copy','combo')
      and (d.status in ('queued','pending') or (d.status='processing' and d.lease_at<now()-interval '45 seconds'))
      and least(s.expires_at,e.ends_at)<=now()`;
    for (let i = 0; i < 12; i++) if (!await executeDecision(undefined, "copy")) break;
    if (Math.floor(slot / minute) % 5 === 0) {
      await protect("service_health", checkServices);
      if (neonWalletHistoryArchive) await protect("wallet_history", backfillHistory);
    }
    await protect("experiment_notifications", experimentNotifications);
    await sql`insert into lab.heartbeats(source,at,details) values('neon',now(),${JSON.stringify({ sections: health })})
      on conflict(source) do update set at=excluded.at,details=excluded.details`;
  }
  await deliverNotifications();
  await sql`update lab.job_runs set done=true where job=${job} and slot=${date(slot)}`;
}
