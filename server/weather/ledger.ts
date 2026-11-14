import { database, date } from "../db.ts";
import { hash } from "./sources.ts";
import type { WeatherEvent } from "../../lib/weather/types.ts";
import { risk, strategyKeys, type WeatherStrategy } from "../../lib/weather/strategies.ts";
import type { PaperFill } from "../../lib/weather/execution.ts";

export async function state(key: string, payload: object) {
  await database()`insert into weather.state(key,payload) values(${key},${JSON.stringify(payload)})
    on conflict(key) do update set payload=excluded.payload,checked_at=now()`;
}

export async function startExperiment(user: string) {
  const sql = database();
  const config = { version: 1, strategies: strategyKeys, ...risk };
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

export async function audit(entry: { experiment?: string; strategy: WeatherStrategy | "system"; event: string; token?: string;
  action: string; reason: string; evidence: object; key: string }) {
  const id = hash([entry.experiment, entry.strategy, entry.event, entry.token, entry.action, entry.reason, entry.key]);
  await database()`insert into weather.audit(id,experiment,strategy,event,token,at,action,reason,evidence)
    values(${id},${entry.experiment ?? null},${entry.strategy},${entry.event},${entry.token ?? null},now(),${entry.action},
      ${entry.reason},${JSON.stringify(entry.evidence)}) on conflict do nothing`;
  return id;
}

export async function postFill(row: { experiment: string; strategy: string; token: string; condition: string; outcome: string;
  event: WeatherEvent; side: "BUY" | "SELL" | "SETTLE"; fill: PaperFill; evidence: object; key: string }) {
  const id = hash([row.experiment, row.strategy, row.token, row.side, row.key]);
  const sql = database();
  const [result] = await sql`select weather.post_fill(${id},${row.experiment},${row.strategy},${row.token},${row.event.id},
    ${row.condition},${row.event.station.code + "/" + row.event.date},${row.outcome},${row.side},${row.fill.shares},${row.fill.gross},
    ${row.fill.fee},${JSON.stringify(row.evidence)}) as status`;
  if (["PAPER_FILLED","PAPER_SELL_FILLED","SETTLED"].includes(result.status)) {
    const price = (row.fill.price * 100).toFixed(2);
    const label = row.side === "BUY" ? "Виртуальная покупка" : row.side === "SELL" ? "Виртуальная продажа" : "Расчёт позиции";
    const payload = JSON.stringify({ text: `Weather Lab · ${label}\n${row.event.station.city} · ${row.outcome}\n${row.fill.shares.toFixed(4)} контрактов по ${price}¢`,
      section: "weather" });
    await sql`insert into lab.outbox(key,chat_id,payload)
      select ${"weather:" + id},u.chat_id,${payload} from weather.experiments e join lab.users u on u.id=e.user_id
      where e.id=${row.experiment} and u.alerts and u.chat_id is not null on conflict do nothing`;
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
