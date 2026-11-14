import { database } from "../db.ts";
import { notificationDefaults } from "./notifications.ts";

export async function weatherQuotes(user: string | null, eventIds: string[]) {
  const sql=database();
  const [status, marks] = await sql.transaction([
    sql`select key,checked_at,case when key='quotes' then jsonb_build_object('at',payload->'at','markets',
      coalesce((select jsonb_object_agg(key,value) from jsonb_each(payload->'markets') where key=any(${eventIds}::text[])),'{}'))
      else payload end payload from weather.state where key in ('readiness','quotes')`,
    sql`select j.* from weather.state s cross join lateral jsonb_to_recordset(s.payload->'marks')
      j(experiment uuid,strategy text,token text,shares float8,basis float8,at float8,quote jsonb,depth float8,fill jsonb,reason text,minimum float8)
      join weather.experiments e on e.id=j.experiment where s.key='position_marks' and e.user_id=${user}`,
  ]);
  return { readiness:status.find(row=>row.key==='readiness')??null,
    snapshot:status.find(row=>row.key==='quotes')?.payload??null, marks };
}

export async function weatherDashboard(user: string | null) {
  const sql = database();
  const [states, markets, runs, banks, positions, fills, decisions, equity, preferences, marks] = await sql.transaction([
    sql`select key,checked_at,payload from weather.state where key in ('markets','readiness')`,
    sql`select payload from weather.markets where (payload->>'end')::float8>extract(epoch from now()-interval '1 day')*1000
      order by (payload->>'start')::float8,id limit 48`,
    sql`select id,status,starts_at,ends_at,configuration from weather.experiments where user_id=${user} order by starts_at desc limit 5`,
    sql`select b.experiment,b.strategy,b.cash::float8,b.initial::float8,b.realized::float8,b.max_drawdown::float8,b.risk_blocked,b.entries_paused,signals.total,signals.last,signals.last_reason,
      q.liquidation::float8,q.at,q.cash::float8 as marked_cash,
      coalesce(f.fees,0)::float8 as fees,coalesce(f.buys,0)::int as buys,coalesce(f.sells,0)::int as sells,
      coalesce(p.basis,0)::float8 as locked,coalesce(p.open,0)::int as open,coalesce(p.events,0)::int as events,
      coalesce(p.closed,0)::int as closed,coalesce(p.wins,0)::int as wins
      from weather.banks b join weather.experiments e on e.id=b.experiment
      left join lateral(select liquidation,at,cash from weather.equity where experiment=b.experiment and strategy=b.strategy order by at desc limit 1) q on true
      left join lateral(select sum(fee) fees,count(*) filter(where side='BUY') buys,count(*) filter(where side='SELL') sells
        from weather.fills where experiment=b.experiment and strategy=b.strategy) f on true
      left join lateral(select count(*) filter(where evidence ? 'candidate' and not (evidence ? 'executionBook') and
        (action='BUY' or reason='SIGNAL_ONLY'))::int total, max(at) last, (array_agg(reason order by at desc))[1] last_reason
        from weather.audit where experiment=b.experiment and strategy=b.strategy) signals on true
      left join lateral(select sum(basis) basis,count(*) filter(where shares>0) open,count(distinct event) events,
        count(*) filter(where closed_at is not null) closed,count(*) filter(where closed_at is not null and realized>0) wins
        from weather.positions where experiment=b.experiment and strategy=b.strategy) p on true
      where e.user_id=${user} and e.id in (select id from weather.experiments where user_id=${user} order by starts_at desc limit 5)`,
    sql`select p.experiment,p.strategy,p.token,p.event,p.outcome,p.shares::float8,p.basis::float8,p.realized::float8,
      p.opened_at,p.closed_at,m.payload->'station'->>'city' city,m.payload->>'kind' kind,
      m.payload->>'date' market_day, (m.payload->>'end')::float8 market_end, purchase.price
      from weather.positions p join weather.experiments e on e.id=p.experiment join weather.markets m on m.id=p.event
      left join lateral(select (gross/shares)::float8 price from weather.fills
        where experiment=p.experiment and strategy=p.strategy and token=p.token and side='BUY' limit 1) purchase on true
      where e.user_id=${user} and p.shares>0 order by p.opened_at desc`,
    sql`select f.id,f.experiment,f.strategy,f.token,p.event,p.outcome,f.side,f.at,f.shares::float8,
      f.gross::float8,f.fee::float8,f.pnl::float8,m.payload->'station'->>'city' city,m.payload->>'kind' kind,
      coalesce(f.evidence->>'source',case when f.evidence->'executionBook'->'book'->>'source'='ws' then 'WEBSOCKET_L2' end) source
      from weather.fills f join weather.experiments e on e.id=f.experiment
      join weather.positions p on p.experiment=f.experiment and p.strategy=f.strategy and p.token=f.token join weather.markets m on m.id=p.event
      where e.user_id=${user} order by f.at desc limit 12`,
    sql`select a.id,a.experiment,a.strategy,a.token,a.at,a.action,a.reason,m.payload->'station'->>'city' city,
      m.payload->>'kind' kind,a.event,
      a.evidence->'candidate'->>'reference' reference,a.evidence->'candidate'->>'ev' ev
      from weather.audit a left join weather.experiments e on e.id=a.experiment join weather.markets m on m.id=a.event
      where (a.experiment is null or e.user_id=${user}) and a.action='SKIP' order by a.at desc limit 12`,
    sql`with latest as (
      select q.experiment, date_trunc('hour',q.at) as hour,max(q.at) at
      from weather.equity q join weather.experiments e on e.id=q.experiment where e.user_id=${user}
      and q.at>now()-interval '14 days' group by 1,2
    ) select q.experiment,q.strategy,q.at,(q.cash+q.liquidation)::float8 equity
      from latest l join weather.equity q on q.experiment=l.experiment and q.at=l.at order by q.at desc limit 4500`,
    sql`select signals,fills,health,daily from weather.notification_preferences where user_id=${user}`,
    sql`select j.* from weather.state s cross join lateral jsonb_to_recordset(s.payload->'marks')
      j(experiment uuid,strategy text,token text,shares float8,basis float8,at float8,quote jsonb,depth float8,fill jsonb,reason text,minimum float8)
      join weather.experiments e on e.id=j.experiment where s.key='position_marks' and e.user_id=${user}`,
  ]);
  return { readiness: states.find(row => row.key === "readiness") ?? null,
    live: states.find(row => row.key === "markets")?.payload ?? null,
    markets: markets.map(row => row.payload), runs,banks,positions,fills,decisions,equity,marks,
    notifications: user ? preferences[0] ?? notificationDefaults : null };
}
