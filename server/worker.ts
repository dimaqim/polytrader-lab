import { createHash } from "node:crypto";
import { database, date, log } from "./db.ts";
import { marketBySlug, marketByCondition, page, type Activity, type Page, type ComboPosition, type Leader } from "./polymarket.ts";
import { btcRule, walletPattern } from "../lib/strategies.ts";
import { distributeSignals, executeDecision, recordSignal, upsertMarket } from "./signals.ts";
import { deliverNotifications } from "./telegram.ts";

const minute = 60_000;
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
async function backfillHistory() {
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
  for (const category of ["crypto", "combos"]) {
    const result = await page<Leader>("/leaderboard", { category, time_period: "week", limit: "12" });
    const rows = result.data.filter(r => walletPattern.test(r.user_id) && Number.isFinite(r.pnl) && Number.isFinite(r.volume))
      .map(r => ({ address: r.user_id.toLowerCase(), name: (r.user_name || r.name || r.user_id.slice(0, 10)).slice(0, 100), pnl: r.pnl, volume: r.volume }));
    await database()`insert into lab.wallets(address,name,source,public_pnl,volume_shares)
      select r.address,r.name,${category},r.pnl,r.volume
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(address text,name text,pnl numeric,volume numeric)
      on conflict(address) do update set public_pnl=excluded.public_pnl,volume_shares=excluded.volume_shares,
      source=case when excluded.source='combos' and lab.wallets.source<>'research' then 'combos' else lab.wallets.source end`;
  }
}

async function scanCopy(wallet: string) {
  const now = Date.now();
  const params = { user: wallet, type: "TRADE", start: String(Math.floor((now - 3 * minute) / 1000)),
    end: String(Math.floor(now / 1000)), limit: "100" };
  let cursor: string | null = null;
  let complete = false;
  const collected: { trade: Activity; observed: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const result: Page<Activity> = await page<Activity>("/activity", { ...params, ...(cursor ? { cursor } : {}) });
    const observed = Date.now();
    await archive(wallet, result.data);
    collected.push(...result.data.map(trade => ({ trade, observed })));
    cursor = result.pagination.next_cursor;
    if (!result.pagination.has_more) { complete = true; break; }
  }
  if (!complete) await log("copy_coverage", new Error("Полная выборка окна не поместилась в один запуск"));
  const markets = new Map<string, Awaited<ReturnType<typeof marketBySlug>>>();
  for (const { trade: a, observed } of collected.reverse()) {
    if (a.type !== "TRADE" || !Number.isFinite(a.timestamp) || a.timestamp * 1000 > observed) continue;
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
    await recordSignal({ key, strategy: "copy", wallet, condition: market?.condition, token, label: a.title || "Copy Trading",
      targetAt: observed, observedAt: observed, expiresAt: Math.min(observed + 90_000, market?.endsAt ?? Infinity),
      reference: a.price > 0 && a.price < 1 ? a.price : undefined, reason,
      evidence: { upstreamAt: a.timestamp * 1000, detectionDelayMs: observed - a.timestamp * 1000, side: a.side, complete } });
  }
}

async function scanCombos() {
  const sql = database();
  const wallets = await sql`select address from lab.wallets where source='combos' order by public_pnl desc nulls last limit 6`;
  for (const wallet of wallets) await protect("combo_feed", async () => {
    const positions = await page<ComboPosition>("/positions/combos", { user: wallet.address, limit: "30" });
    const observed = Date.now();
    for (const c of positions.data) {
      const entered = Date.parse(c.first_entry_at);
      if (!(c.entry_cost_usdc >= 2000) || !Number.isFinite(entered) || entered > observed || !c.legs?.length) continue;
      const id = c.proxy_wallet + ":" + c.combo_position_id;
      await sql`insert into lab.combos(id,wallet,stake,event_at,detected_at,payload)
        values(${id},${c.proxy_wallet},${c.entry_cost_usdc},${date(entered)},${date(observed)},${JSON.stringify(c)})
        on conflict(id) do update set stake=excluded.stake,payload=excluded.payload`;
      if (observed - entered > 30 * minute || c.status !== "OPEN") continue;
      const key = "combo:" + id;
      const label = c.legs.map(l => l.market.title + " · " + l.leg_outcome_label).join(" / ").slice(0, 220);
      await recordSignal({ key, strategy: "combo", label, targetAt: observed, observedAt: observed,
        expiresAt: observed + minute, reason: "combo_rfq_depth_unavailable", evidence: { stake: c.entry_cost_usdc, entered } });
      await sql`insert into lab.outbox(key,chat_id,payload)
        select ${key}||':'||id,chat_id,jsonb_build_object('text',${"Комбо от $" + Math.round(c.entry_cost_usdc) + "\n" + label})
        from lab.users where alerts and chat_id is not null on conflict do nothing`;
    }
  });
}

async function marketCoverage(now: number) {
  const rows = await database()`select condition,slug,title,ends_at,interval_minutes from lab.markets where interval_minutes is not null
    and ends_at>now()-interval '3 minutes' and ends_at<now()+interval '65 seconds'`;
  for (const m of rows) {
    const end = +new Date(m.ends_at);
    const rule = btcRule(m.interval_minutes, end);
    if (now <= rule.target + 5000) continue;
    await recordSignal({ key: rule.strategy + ":" + m.slug, strategy: rule.strategy, label: m.title, condition: m.condition,
      targetAt: rule.target, observedAt: now, expiresAt: end, reason: "missing_collector_window", evidence: { timingErrorMs: now - rule.target } });
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

export async function runWorker(slot: number, daily = false) {
  const sql = database();
  const job = daily ? "daily" : "monitor";
  const slots = await sql`insert into lab.job_runs(job,slot) values(${job},${date(slot)})
    on conflict(job,slot) do update set lease_at=now() where not lab.job_runs.done and lab.job_runs.lease_at<now()-interval '75 seconds'
    returning slot`;
  if (!slots.length) return;
  if (daily) {
    await protect("wallet_discovery", discoverWallets);
    await sql`insert into lab.outbox(key,chat_id,payload)
      select 'daily:'||u.id||':'||${date(slot)},u.chat_id,jsonb_build_object('text',
        'PolyTrader Lab · Дневной отчёт'||E'\n'||'Активных тестов: '||
        (select count(*) from lab.experiments e where e.user_id=u.id and not e.paused and e.ends_at>now())||
        E'\n'||'Рассчитанный PnL за 24 ч: $'||coalesce((select round(sum(p.pnl),2) from lab.positions p
        join lab.experiments e on e.id=p.experiment where e.user_id=u.id and p.settled_at>now()-interval '24 hours'),0))
      from lab.users u where u.alerts and u.chat_id is not null on conflict do nothing`;
  } else {
    const now = Date.now();
    const jobs = [
      protect("btc_catalog", async () => {
        for (const interval of [5, 15]) {
          const duration = interval * minute;
          const start = Math.floor(now / duration) * duration;
          const results = await Promise.allSettled([start - duration, start, start + duration].map(async t => {
            const m = await marketBySlug(`btc-updown-${interval}m-${t / 1000}`);
            if (m) await upsertMarket(m);
          }));
          for (const result of results) if (result.status === "rejected") await log("btc_catalog", result.reason);
        }
        await marketCoverage(Date.now());
      }),
      protect("copy", async () => {
        const wallets = await sql`select distinct wallet from lab.experiments where strategy='copy' and ends_at>now() and wallet is not null limit 8`;
        for (const { wallet } of wallets) await protect("copy_wallet", () => scanCopy(wallet));
      }),
      protect("portfolio", settleAndMark),
      protect("wallet_history", backfillHistory),
    ];
    if (Math.floor(slot / minute) % 5 === 0) jobs.push(protect("combo", scanCombos));
    const health = await Promise.all(jobs);
    await distributeSignals();
    await sql`update lab.decisions d set status='unfilled',reason='expired',updated_at=now()
      from lab.signals s,lab.experiments e where d.signal=s.id and d.experiment=e.id and d.status in ('queued','pending')
      and least(s.expires_at,e.ends_at)<=now()`;
    for (let i = 0; i < 12; i++) if (!await executeDecision(undefined, "copy")) break;
    await sql`insert into lab.heartbeats(source,at,details) values('neon',now(),${JSON.stringify({ sections: health })})
      on conflict(source) do update set at=excluded.at,details=excluded.details`;
  }
  await deliverNotifications();
  await sql`update lab.job_runs set done=true where job=${job} and slot=${date(slot)}`;
}
