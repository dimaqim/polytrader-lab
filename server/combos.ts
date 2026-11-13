import { comboMinimum, type ComboStatus } from "../lib/combos.ts";
import { hiddenMarket } from "../lib/market-scope.ts";
import { walletPattern } from "../lib/strategies.ts";
import { database, date, log } from "./db.ts";
import { page, UpstreamError, type ComboActivity, type ComboPosition, type Leader } from "./polymarket.ts";
import { recordSignal } from "./signals.ts";

const statuses: ComboStatus[] = ["OPEN", "RESOLVED_WIN", "RESOLVED_LOSS"];
const discoveryInterval = 60 * 60_000;
const notificationAge = 30 * 60_000;
const positionId = (wallet: string, position: string) => wallet + ":" + position;

async function discoverComboWallets() {
  const sql = database();
  const [last] = await sql`select max(ranked_at) as ranked_at from lab.combo_watch`;
  if (last.ranked_at && Date.now() - +new Date(last.ranked_at) < discoveryInterval) return;
  const result = await page<Leader>("/leaderboard", { category: "combos", time_period: "week", limit: "12" });
  const ranked = result.data.filter(row => walletPattern.test(row.user_id))
    .map(row => ({ address: row.user_id.toLowerCase(), name: (row.user_name || row.name || row.user_id.slice(0, 10)).slice(0, 100) }));
  if (!ranked.length) throw new Error("Polymarket combo leaderboard returned no tracked wallets");
  await sql.transaction([
    sql`insert into lab.wallets(address,name,source)
      select distinct on (r.address) r.address,r.name,'combos' from jsonb_to_recordset(${JSON.stringify(ranked)}::jsonb)
      r(address text,name text) on conflict(address) do update set name=excluded.name`,
    sql`insert into lab.combo_watch(wallet,ranked_at)
      select distinct r.address,now() from jsonb_to_recordset(${JSON.stringify(ranked)}::jsonb) r(address text)
      on conflict(wallet) do update set ranked_at=excluded.ranked_at`,
  ]);
}

function validPosition(row: ComboPosition, wallet: string, observed: number) {
  const entered = Date.parse(row.first_entry_at);
  return row.proxy_wallet?.toLowerCase() === wallet && /^\d{1,80}$/.test(row.combo_position_id)
    && Number.isFinite(entered) && entered <= observed && row.entry_cost_usdc >= comboMinimum
    && Number.isFinite(row.entry_cost_usdc) && Array.isArray(row.legs) && row.legs.length >= 2
    && row.legs.every(leg => typeof leg.market?.title === "string"
      && !hiddenMarket(leg.market.question ?? leg.market.title, leg.market.slug ?? leg.market.event?.event_slug));
}

async function storePositions(wallet: string, positions: ComboPosition[], notify: boolean) {
  const sql = database();
  const observed = Date.now();
  const rows = positions.filter(row => validPosition(row, wallet, observed))
    .map(row => ({ id: positionId(wallet, row.combo_position_id), stake: row.entry_cost_usdc, at: row.first_entry_at, payload: row }));
  if (!rows.length) return;

  const saved = await sql`with input as (
    select distinct on (id) id, stake, at, payload from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      r(id text, stake numeric, at timestamptz, payload jsonb)
      order by id,(payload->>'updated_at_micros')::bigint desc nulls last
  ) insert into lab.combos(id,wallet,stake,event_at,detected_at,payload)
    select id,${wallet},stake,at,${date(observed)},payload from input
    on conflict(id) do update set stake=excluded.stake,event_at=excluded.event_at,payload=excluded.payload
    where (lab.combos.payload->>'status'='OPEN' or excluded.payload->>'status'<>'OPEN')
      and coalesce((excluded.payload->>'updated_at_micros')::bigint,0)>=coalesce((lab.combos.payload->>'updated_at_micros')::bigint,0)
    returning id,detected_at,payload`;

  if (!notify) return;
  for (const { id, detected_at, payload } of saved) {
    const row = payload as ComboPosition;
    const entered = Date.parse(row.first_entry_at);
    if (row.status !== "OPEN" || observed - entered > notificationAge || +new Date(detected_at) !== observed) continue;
    const key = "combo:" + id;
    const label = row.legs.map(leg => leg.leg_outcome_label).join(" / ").slice(0, 220);
    await recordSignal({ key, strategy: "combo", wallet, label, targetAt: observed, observedAt: observed,
      expiresAt: observed + 60_000, reason: "combo_rfq_depth_unavailable", evidence: { stake: row.entry_cost_usdc, entered } });
    const amount = row.gross_entry_cost_usdc ?? row.entry_cost_usdc;
    const text = `Новое комбо\nПоставлено: $${amount.toFixed(2)}${row.gross_entry_cost_usdc == null ? " без комиссии" : " с комиссией"}\n${label}`;
    await sql`insert into lab.outbox(key,chat_id,payload)
      select ${key}::text||':'||id,chat_id,jsonb_build_object('text',${text}::text,'section','combos')
      from lab.users where alerts and chat_id is not null on conflict do nothing`;
  }
}

async function saveRedemptions(wallet: string, rows: ComboActivity[]) {
  const confirmed = rows.filter(row => row.type === "REDEEM" && row.proxy_wallet?.toLowerCase() === wallet
    && typeof row.id === "string" && /^[0-9]+$/.test(row.combo_position_id)
    && typeof row.payout_usdc === "number" && Number.isFinite(row.payout_usdc) && row.payout_usdc > 0
    && Number.isFinite(row.timestamp) && row.timestamp > 0 && row.timestamp * 1000 <= Date.now()
    && /^0x[\da-f]{64}$/i.test(row.transaction_hash))
    .map(row => ({ id: row.id, combo: positionId(wallet, row.combo_position_id), at: date(row.timestamp * 1000),
      amount: row.payout_usdc, hash: row.transaction_hash }));
  if (!confirmed.length) return;
  await database()`insert into lab.combo_redemptions(id,combo_id,paid_at,amount,tx_hash)
    select r.id,r.combo,r.at,r.amount,r.hash
    from jsonb_to_recordset(${JSON.stringify(confirmed)}::jsonb)
      r(id text,combo text,at timestamptz,amount numeric,hash text)
    on conflict(id) do nothing`;
}

type History = Partial<Record<ComboStatus | "activity", string | null>>;
type Watched = { wallet: string; history_cursor: History };

async function updateWallet(watch: Watched) {
  const { wallet, history_cursor: cursors } = watch;
  const sql = database();
  const synced = new Date().toISOString();
  await sql`update lab.combo_watch set checked_at=now() where wallet=${wallet}`;

  async function scan<T>(kind: ComboStatus | "activity", path: string, params: Record<string, string>,
    save: (rows: T[], notify: boolean) => Promise<void>) {
    const filters = { user: wallet, limit: "100", ...params };
    const fresh = await page<T>(path, filters);
    await save(fresh.data, true);
    if (cursors[kind] === null) return null;
    const cursor = cursors[kind];
    if (!cursor) return fresh.pagination.has_more ? fresh.pagination.next_cursor : null;
    try {
      const older = await page<T>(path, { ...filters, cursor });
      await save(older.data, false);
      return older.pagination.has_more ? older.pagination.next_cursor : null;
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 400) return fresh.pagination.next_cursor;
      throw error;
    }
  }

  const [positionCursors, activityCursor] = await Promise.all([
    Promise.all(statuses.map(status => scan<ComboPosition>(status, "/positions/combos",
      { status, sort_by: "UPDATED", sort_direction: "DESC" }, (rows, notify) => storePositions(wallet, rows, notify)))),
    scan<ComboActivity>("activity", "/activity/combos", {}, rows => saveRedemptions(wallet, rows)),
  ]);
  const next = { OPEN: positionCursors[0], RESOLVED_WIN: positionCursors[1], RESOLVED_LOSS: positionCursors[2], activity: activityCursor };
  await sql`update lab.combo_watch set synced_at=${synced},history_cursor=${JSON.stringify(next)} where wallet=${wallet}`;
}

export async function scanCombos() {
  const sql = database();
  try { await discoverComboWallets(); }
  catch (error) { await log("combo_discovery", error); }
  await sql`insert into lab.combo_watch(wallet)
    select distinct c.wallet from lab.combos c join lab.wallets w on w.address=c.wallet
    where c.payload->>'status'='OPEN' or (c.payload->>'status'='RESOLVED_WIN'
      and not exists(select 1 from lab.combo_redemptions r where r.combo_id=c.id))
    on conflict(wallet) do nothing`;

  const rows = await sql`select watch.wallet,watch.history_cursor from lab.combo_watch watch
    where watch.ranked_at>now()-interval '2 hours' or watch.history_cursor<>'{"OPEN":null,"activity":null,"RESOLVED_WIN":null,"RESOLVED_LOSS":null}'::jsonb
      or exists(select 1 from lab.combos c where c.wallet=watch.wallet
        and (c.payload->>'status'='OPEN' or (c.payload->>'status'='RESOLVED_WIN'
          and not exists(select 1 from lab.combo_redemptions r where r.combo_id=c.id)
          and (c.payload->>'resolved_at')::timestamptz>now()-interval '30 days')))
    order by watch.checked_at nulls first,watch.wallet limit 6` as Watched[];

  const results = await Promise.allSettled(rows.map(updateWallet));
  for (const result of results) if (result.status === "rejected") await log("combo_feed", result.reason);
  await sql`insert into lab.heartbeats(source,at,details)
    select 'combos',now(),jsonb_build_object('ok',${rows.length>0 && results.every(result => result.status === "fulfilled")}::boolean,
      'lastSuccess',max(synced_at),'ranked',count(*) filter(where ranked_at>now()-interval '2 hours')::int)
    from lab.combo_watch on conflict(source) do update set at=excluded.at,details=excluded.details`;
  if (!rows.length || results.some(result => result.status === "rejected")) throw new Error("Combo scan incomplete");
}
