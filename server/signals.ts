import { database, date, log } from "./db.ts";
import { orderBook, type Market } from "./polymarket.ts";
import { freshBook, marketBuy, type Book, type Fee } from "../lib/simulator.ts";
import type { Strategy } from "../lib/strategies.ts";

export async function upsertMarket(m: Market) {
  await database()`insert into lab.markets(condition,slug,title,ends_at,interval_minutes,tokens,outcomes,prices,fee,payout,open,seen_at)
    values(${m.condition},${m.slug},${m.title},${date(m.endsAt)},${m.interval},${JSON.stringify(m.tokens)},${JSON.stringify(m.outcomes)},
    ${JSON.stringify(m.prices)},${m.fee ? JSON.stringify(m.fee) : null},${m.payout ? JSON.stringify(m.payout) : null},${m.open},${date(m.seenAt)})
    on conflict(condition) do update set prices=excluded.prices, fee=excluded.fee, open=excluded.open, seen_at=excluded.seen_at,
    payout=coalesce(lab.markets.payout,excluded.payout) where lab.markets.seen_at<=excluded.seen_at`;
}
export type Signal = {
  key: string; strategy: Strategy; label: string; condition?: string; token?: string; wallet?: string;
  targetAt: number; observedAt: number; expiresAt: number; reference?: number; reason?: string;
  evidence: object; delayMs?: number; version?: number;
};
export async function recordSignal(s: Signal) {
  const rows = await database()`insert into lab.signals(key,strategy,label,condition,token,wallet,target_at,observed_at,expires_at,reference,reason,evidence,delay_ms,version)
    values(${s.key},${s.strategy},${s.label},${s.condition ?? null},${s.token ?? null},${s.wallet ?? null},
      ${date(s.targetAt)},${date(s.observedAt)},${date(s.expiresAt)},${s.reference ?? null},${s.reason ?? null},${JSON.stringify(s.evidence)},${s.delayMs ?? 0},${s.version ?? 1})
    on conflict(key) do nothing returning id`;
  return rows[0]?.id as string | undefined;
}
export async function distributeSignals() {
  await database()`with new_decisions as (
    insert into lab.decisions(experiment,signal,status,reason,ready_at)
    select e.id,s.id,case when e.paused or e.risk_blocked or s.reason is not null or s.expires_at<=now() then 'unfilled'
      when e.mode='confirm' then 'pending' else 'queued' end,
      case when e.paused or e.risk_blocked then 'risk_or_pause' else coalesce(s.reason,case when s.expires_at<=now() then 'expired' end) end,
      greatest(now(),s.observed_at+s.delay_ms*interval '1 ms')
    from lab.signals s join lab.experiments e on e.strategy=s.strategy and e.version=s.version and e.starts_at<=s.target_at and e.ends_at>s.target_at
      and (s.strategy<>'copy' or e.wallet=s.wallet)
    where s.observed_at>now()-interval '2 days'
    on conflict(experiment,signal) do nothing returning *
  ) insert into lab.outbox(key,chat_id,payload)
    select 'signal:'||d.id,u.chat_id,jsonb_build_object('text','Paper · '||s.label||
      case when d.status='pending' then E'\nПодтвердить до '||to_char(s.expires_at at time zone 'Europe/Kyiv','HH24:MI:SS')||' (Киев)' else E'\nАвтоматическая проверка исполнения' end,
      'reply_markup',case when d.status='pending' then jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(
        jsonb_build_object('text','Подтвердить','callback_data','yes:'||d.id),
        jsonb_build_object('text','Пропустить','callback_data','no:'||d.id)))) end)
    from new_decisions d join lab.experiments e on e.id=d.experiment join lab.users u on u.id=e.user_id
    join lab.signals s on s.id=d.signal where d.status in ('pending','queued') and u.chat_id is not null and u.alerts
    on conflict do nothing`;
}
export async function claimDecision(id?: string, strategy?: Strategy) {
  const rows = await database()`with work as (
    select d.id from lab.decisions d join lab.signals s on s.id=d.signal
    where (${id ?? null}::uuid is null or d.id=${id ?? null}::uuid)
      and (${strategy ?? null}::text is null or s.strategy=${strategy ?? null})
      and ((d.status='queued' and d.ready_at<=now()) or (d.status='processing' and d.lease_at<now()-interval '45 seconds'))
    order by d.ready_at limit 1 for update of d skip locked
  ), claimed as (
    update lab.decisions d set status='processing',lease_at=date_trunc('milliseconds',clock_timestamp()) from work where d.id=work.id returning d.*
  ) select d.id,d.lease_at,s.id as signal_id,s.strategy,s.token,s.reference,s.expires_at,s.observed_at,
      m.fee,m.open,m.ends_at as market_ends,e.stake,e.slippage,s.evidence
      from claimed d join lab.signals s on s.id=d.signal join lab.experiments e on e.id=d.experiment
      left join lab.markets m on m.condition=s.condition`;
  return rows[0];
}
export async function executeDecision(id?: string, strategy?: Strategy, liveBook?: Book) {
  const d = await claimDecision(id, strategy);
  if (!d) return false;
  let reason: string | null = null;
  let fill = null;
  let book: Book | undefined;
  try {
    const btc = d.strategy === "btc5" || d.strategy === "btc15";
    const expires = +new Date(d.expires_at);
    if (!d.open || Date.now() >= Math.min(expires, +new Date(d.market_ends))) reason = "expired_or_closed";
    else if (!d.fee || !d.token || !(Number(d.reference) > 0)) reason = "missing_market_parameters";
    else {
      const quote = btc && liveBook && liveBook.asset === d.token
        ? { book: liveBook, minimum: Number(d.evidence?.minimum ?? 1) }
        : await orderBook(d.token);
      book = quote?.book;
      const received = +new Date(d.observed_at);
      if (!quote || !freshBook(quote.book, Date.now(), btc ? 4_000 : 15_000)
        || quote.book.receivedAt < Math.max(received, +new Date(d.lease_at) - (btc ? 1_500 : 0))) reason = "missing_fresh_depth";
      else {
        fill = marketBuy(quote.book, Number(d.stake), Number(d.reference), d.slippage, d.fee as Fee, quote.minimum);
        if (!fill) reason = "insufficient_liquidity_or_slippage";
      }
    }
  } catch (error) {
    reason = "quote_api_error";
    await log("execution", error);
  }
  if (book) await database()`insert into lab.book_evidence(signal,stage,token,observed_at,book)
    values(${d.signal_id},'execution',${book.asset},${date(book.receivedAt)},${JSON.stringify(book)}) on conflict do nothing`;
  const evidence = { bookAt: book?.sourceAt, receivedAt: book?.receivedAt, delayMs: book ? book.receivedAt - +new Date(d.observed_at) : null, fill };
  await database()`select lab.finish_decision(${d.id},${d.lease_at},${fill ? JSON.stringify(fill) : null},${reason},${JSON.stringify(evidence)})`;
  return true;
}
