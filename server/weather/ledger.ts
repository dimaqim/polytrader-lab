import { database, date } from "../db.ts";
import { hash } from "./sources.ts";
import type { WeatherEvent } from "../../lib/weather/types.ts";
import { risk, strategyKeys, weatherStrategies, type WeatherStrategy } from "../../lib/weather/strategies.ts";
import type { PaperFill } from "../../lib/weather/execution.ts";
import { enqueueWeather } from "./notifications.ts";

export async function state(key: string, payload: object) {
  await database()`insert into weather.state(key,payload) values(${key},${JSON.stringify(payload)})
    on conflict(key) do update set payload=excluded.payload,checked_at=now()`;
}

export async function startExperiment(user: string) {
  const sql = database();
  const config = { version: 2, strategies: strategyKeys, execution: ["WEBSOCKET_L2","REST_VERIFIED_PAPER"], ...risk };
  const [result] = await sql`select weather.start_experiment(${user},${JSON.stringify(config)},${strategyKeys}::text[]) as experiment`;
  return result?.experiment as string | undefined;
}

export async function changeExperiment(user: string, id: string, status: string) {
  const rows = await database()`update weather.experiments set status=${status}
    where user_id=${user} and id=${id} and status<>'stopped' and ends_at>now() returning id`;
  return rows.length > 0;
}

export async function archiveEvents(events: WeatherEvent[]) {
  if (!events.length) return;
  const sql = database();
  await sql`insert into weather.markets(id,payload,checked_at)
    select r.id,r.payload,now() from jsonb_to_recordset(${JSON.stringify(events.map(event => ({ id: event.id, payload: event })))}::jsonb)
      r(id text,payload jsonb)
    on conflict(id) do update set payload=excluded.payload,checked_at=excluded.checked_at
    where weather.markets.checked_at<=excluded.checked_at`;
}

export async function archiveInputs(kind: string, rows: { station: string; receivedAt: number; id: string; payload: object }[]) {
  if (!rows.length) return;
  await database()`insert into weather.inputs(kind,id,station,received_at,payload)
    select ${kind}::text,r.id,r.station,to_timestamp(r.at/1000),r.payload
    from jsonb_to_recordset(${JSON.stringify(rows.map(row => ({ ...row, at: row.receivedAt })))}::jsonb)
      r(id text,station text,at float8,payload jsonb) on conflict do nothing`;
}

// The original execution evidence is retained in weather.fills. The high-volume
// audit table stores a compact, searchable explanation instead of duplicating
// full forecast series and entire L2 order books on every SKIP/HOLD/signal.
function compactAuditEvidence(value: object) {
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const raw = record(value);
  const candidate = record(raw.candidate);
  const contract = record(candidate.contract);
  const bucket = record(contract.bucket);
  const wallet = record(candidate.wallet);
  const walletSell = record(raw.walletSell);
  const estimate = record(raw.estimate);
  const quote = (input: unknown) => {
    const outer = record(input);
    if (!Object.keys(outer).length) return undefined;
    const book = record(outer.book);
    return {
      session: outer.session ?? null,
      book: {
        source: book.source ?? null,
        sourceAt: book.sourceAt ?? null,
        receivedAt: book.receivedAt ?? null,
        bids: Array.isArray(book.bids) ? book.bids.slice(0, 1) : [],
        asks: Array.isArray(book.asks) ? book.asks.slice(0, 1) : [],
      },
    };
  };
  const candidateSummary = Object.keys(candidate).length ? {
    strategy: candidate.strategy ?? null,
    token: candidate.token ?? null,
    yes: candidate.yes ?? null,
    reason: candidate.reason ?? null,
    reference: candidate.reference ?? null,
    ev: candidate.ev ?? null,
    probability: candidate.probability ?? null,
    conservative: candidate.conservative ?? null,
    contract: { bucket: { label: bucket.label ?? null } },
    ...(wallet.wallet ? { wallet: { wallet: wallet.wallet, price: wallet.price ?? null,
      at: wallet.at ?? null, receivedAt: wallet.receivedAt ?? null } } : {}),
  } : undefined;
  return {
    compact: true,
    at: raw.at ?? null,
    readyAt: raw.readyAt ?? null,
    source: raw.source ?? null,
    fair: raw.fair ?? null,
    afterFees: raw.afterFees ?? null,
    basisPerShare: raw.basisPerShare ?? null,
    priorBasis: raw.priorBasis ?? null,
    netPerShare: raw.netPerShare ?? null,
    entriesRevision: raw.entriesRevision ?? null,
    fill: raw.fill ? { partial: record(raw.fill).partial ?? null } : null,
    ...(candidateSummary ? { candidate: candidateSummary } : {}),
    ...(walletSell.wallet ? { walletSell: { wallet: walletSell.wallet, price: walletSell.price ?? null,
      at: walletSell.at ?? null, receivedAt: walletSell.receivedAt ?? null } } : {}),
    ...(raw.signalBook ? { signalBook: quote(raw.signalBook) } : {}),
    ...(raw.executionBook ? { executionBook: quote(raw.executionBook) } : {}),
    ...(Object.keys(estimate).length ? { model: {
      at: estimate.at ?? null,
      confidence: estimate.confidence ?? null,
      observed: estimate.observed ?? null,
      forecastCount: Array.isArray(estimate.forecasts) ? estimate.forecasts.length : null,
      outcomeCount: Array.isArray(estimate.distribution) ? estimate.distribution.length : null,
    } } : {}),
  };
}

export async function audit(entry: { experiment?: string; strategy: WeatherStrategy | "system"; event: string; token?: string;
  action: string; reason: string; evidence: object; key: string }) {
  const id = hash([entry.experiment, entry.strategy, entry.event, entry.token, entry.action, entry.reason, entry.key]);
  await database()`insert into weather.audit(id,experiment,strategy,event,token,at,action,reason,evidence)
    values(${id},${entry.experiment ?? null},${entry.strategy},${entry.event},${entry.token ?? null},now(),${entry.action},
      ${entry.reason},${JSON.stringify(compactAuditEvidence(entry.evidence))}) on conflict do nothing`;
  return id;
}

export async function postFill(row: { experiment: string; strategy: string; token: string; condition: string; outcome: string;
  event: WeatherEvent; side: "BUY" | "SELL" | "SETTLE"; fill: PaperFill; evidence: object; key: string }) {
  const id = hash([row.experiment, row.strategy, row.token, row.side, row.key]);
  const sql = database();
  const [result] = await sql`select weather.post_fill(${id},${row.experiment},${row.strategy},${row.token},${row.event.id},
    ${row.condition},${row.event.station.code + "/" + row.event.date},${row.outcome},${row.side},${row.fill.shares},${row.fill.gross},
    ${row.fill.fee},${JSON.stringify(row.evidence)}) as status`;
  if (["PAPER_FILLED","PAPER_SELL_FILLED","SETTLED","DUPLICATE"].includes(result.status)) {
    const [verified] = await sql`select pnl::float8,(gross/shares)::float8 price,shares::float8,fee::float8,side
      from weather.fills where id=${id}`;
    if (!verified) return result.status as string;
    const price = (verified.price * 100).toFixed(2);
    const label = verified.side === "BUY" ? "Виртуальная покупка" : verified.side === "SELL" ? "Виртуальная продажа" : "Расчёт позиции";
    const detail = verified.side === "SETTLE" ? "\nИсточник · официальный расчёт Polymarket"
      : "\nСвежий стакан подтвердил объём после задержки.";
    const description = `Weather Lab · ${label}\n${row.event.station.city} · ${row.outcome} · ${weatherStrategies[row.strategy as WeatherStrategy]}\n`
      + `${verified.shares.toFixed(4)} контрактов по ${price}¢ · комиссия $${verified.fee.toFixed(4)}`
      + (verified.pnl == null ? "" : `\nРезультат $${verified.pnl.toFixed(2)}`) + detail;
    await enqueueWeather(row.experiment,"fills",id,description);
  }
  return result.status as string;
}

export async function markBank(experiment: string, strategy: string, cash: number, liquidation: number | null, at: number) {
  const sql = database();
  const minute = date(Math.floor(at / 60_000) * 60_000);
  await sql`with sampled as (
    insert into weather.equity(experiment,strategy,at,cash,liquidation)
    values(${experiment},${strategy},${minute},${cash},${liquidation})
    on conflict do nothing returning *
  ) update weather.banks b set peak=greatest(b.peak,s.cash+s.liquidation),
    max_drawdown=case when s.liquidation is null then b.max_drawdown else greatest(b.max_drawdown,b.peak-s.cash-s.liquidation) end,
    risk_blocked=b.risk_blocked or coalesce(b.peak-s.cash-s.liquidation>=15,false)
    from sampled s where b.experiment=s.experiment and b.strategy=s.strategy`;
}
