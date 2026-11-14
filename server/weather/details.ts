import { database } from "../db.ts";

export async function setWeatherEntries(user:string, experiment:string, strategy:string, paused:boolean) {
  const [row] = await database()`select weather.set_entries(${user},${experiment},${strategy},${paused}) as ok`;
  return Boolean(row?.ok);
}

export async function weatherPosition(user:string, experiment:string, strategy:string, token:string) {
  const sql=database();
  const [positions, fills, timeline, marketState, marks] = await sql.transaction([
    sql`select p.*,p.shares::float8,p.basis::float8,p.realized::float8,p.original_cost::float8,m.payload as market
      from weather.positions p join weather.experiments e on e.id=p.experiment join weather.markets m on m.id=p.event
      where e.user_id=${user} and p.experiment=${experiment} and p.strategy=${strategy} and p.token=${token}`,
    sql`select f.*,f.shares::float8,f.gross::float8,f.fee::float8,f.basis::float8,f.pnl::float8
      from weather.fills f join weather.experiments e on e.id=f.experiment
      where e.user_id=${user} and f.experiment=${experiment} and f.strategy=${strategy} and f.token=${token} order by f.at,f.id`,
    sql`select a.id,a.at,a.action,a.reason,a.evidence->>'at' evaluated_at, a.evidence->>'fair' fair,
      a.evidence->>'afterFees' net_bid,a.evidence->>'readyAt' ready_at
      from weather.audit a join weather.experiments e on e.id=a.experiment
      where e.user_id=${user} and a.experiment=${experiment} and a.strategy=${strategy} and a.token=${token}
      and (a.action<>'HOLD' or a.id=(select h.id from weather.audit h where h.experiment=a.experiment and h.strategy=a.strategy
        and h.token=a.token and h.action='HOLD' order by h.at desc limit 1))
      order by a.at,a.id`,
    sql`select item as live from weather.state s cross join lateral jsonb_array_elements(s.payload->'data') item
      join weather.positions p on p.event=item->>'event' join weather.experiments e on e.id=p.experiment
      where s.key='markets' and e.user_id=${user} and p.experiment=${experiment} and p.strategy=${strategy} and p.token=${token}`,
    sql`select j.* from weather.state s cross join lateral jsonb_to_recordset(s.payload->'marks')
      j(experiment uuid,strategy text,token text,shares float8,basis float8,at float8,quote jsonb,depth float8,fill jsonb)
      join weather.experiments e on e.id=j.experiment where s.key='position_marks' and e.user_id=${user}
      and j.experiment=${experiment} and j.strategy=${strategy} and j.token=${token}`,
  ]);
  return positions[0] ? {position:positions[0],fills,timeline,live:marketState[0]?.live??null,mark:marks[0]??null} : null;
}

export async function weatherDecision(user:string, id:string) {
  const [row]=await database()`select a.*,m.payload as market from weather.audit a join weather.markets m on m.id=a.event
    left join weather.experiments e on e.id=a.experiment where a.id=${id} and (e.user_id=${user} or a.experiment is null)`;
  return row??null;
}

export async function weatherJournal(user:string, query:URLSearchParams) {
  const kind=query.get("kind")??"signals";
  const city=query.get("city")||null, strategy=query.get("strategy")||null, source=query.get("source")||null;
  const pnl=query.get("pnl")||null, since=query.get("since")||null;
  const page=Math.max(0,Math.min(1000,Math.floor(Number(query.get("page"))||0)));
  const sql=database();
  const rows=await sql`with records as (
    select a.id,a.experiment,a.strategy,a.token,a.event,a.at,a.reason,
      case when a.evidence ? 'candidate' then (case when a.evidence->'candidate'->>'yes'='true' then 'YES ' else 'NO ' end)
        ||(a.evidence->'candidate'->'contract'->'bucket'->>'label') else null end as outcome,
      (a.evidence->'candidate'->>'reference')::float8 price,
      null::float8 amount,null::float8 pnl,
      coalesce(a.evidence->>'source',case a.evidence->'signalBook'->'book'->>'source'
        when 'ws' then 'WEBSOCKET_L2' when 'rest' then 'REST_VERIFIED_PAPER' end) source,
      case when a.action='BUY' then 'signals' else 'skips' end category
    from weather.audit a left join weather.experiments e on e.id=a.experiment
    where ${kind} in ('signals','skips') and (e.user_id=${user} or a.experiment is null)
      and (a.action='SKIP' or (a.action='BUY' and a.evidence ? 'candidate' and not (a.evidence ? 'executionBook')))
    union all
    select f.id,f.experiment,f.strategy,f.token,p.event,f.at,f.side,p.outcome,(f.gross/f.shares)::float8,
      (f.gross+case when f.side='BUY' then f.fee else -f.fee end)::float8,f.pnl::float8,
      coalesce(f.evidence->>'source',case f.evidence->'executionBook'->'book'->>'source'
        when 'ws' then 'WEBSOCKET_L2' when 'rest' then 'REST_VERIFIED_PAPER' end),
      case when f.side='BUY' then 'buys' else 'sells' end
    from weather.fills f join weather.experiments e on e.id=f.experiment
    join weather.positions p using(experiment,strategy,token)
    where ${kind} in ('buys','sells') and e.user_id=${user}
    union all
    select p.token,p.experiment,p.strategy,p.token,p.event,coalesce(p.closed_at,p.opened_at),
      case when p.closed_at is null then 'OPEN' else 'CLOSED' end,p.outcome,(b.gross/b.shares)::float8,
      (case when p.closed_at is null then p.basis else p.original_cost end)::float8,p.realized::float8,
      coalesce(b.evidence->>'source',case b.evidence->'executionBook'->'book'->>'source'
        when 'ws' then 'WEBSOCKET_L2' when 'rest' then 'REST_VERIFIED_PAPER' end),
      case when p.closed_at is null then 'open' else 'closed' end
    from weather.positions p join weather.experiments e on e.id=p.experiment
    left join lateral(select gross,shares,evidence from weather.fills f where f.experiment=p.experiment
      and f.strategy=p.strategy and f.token=p.token and f.side='BUY' limit 1) b on true
    where ${kind} in ('open','closed') and e.user_id=${user}
  )
  select r.*,m.payload->'station'->>'city' city,m.payload->>'kind' kind
  from records r join weather.markets m on m.id=r.event
  where r.category=${kind} and (${city}::text is null or m.payload->'station'->>'city'=${city})
    and (${strategy}::text is null or r.strategy=${strategy})
    and (${source}::text is null or r.source=${source})
    and (${pnl}::text is null or (${pnl}='profit' and r.pnl>0) or (${pnl}='loss' and r.pnl<0))
    and (${since}::text is null or r.at>=${since}::date::timestamp at time zone 'Europe/Kyiv')
  order by r.at desc,r.experiment,r.strategy,r.id limit 41 offset ${page*40}`;
  return {rows:rows.slice(0,40),more:rows.length>40};
}
