import { database } from "../db.ts";

export async function weatherDashboard(user: string | null) {
  const sql = database();
  const [states, markets, runs, banks, positions, fills, decisions, equity] = await sql.transaction([
    sql`select key,checked_at,payload from weather.state where key in ('markets','readiness')`,
    sql`select payload from weather.markets where (payload->>'end')::float8>extract(epoch from now()-interval '1 day')*1000
      order by (payload->>'start')::float8,id limit 48`,
    sql`select id,status,starts_at,ends_at from weather.experiments where user_id=${user} order by starts_at desc limit 5`,
    sql`select b.experiment,b.strategy,b.cash::float8,b.initial::float8,b.realized::float8,b.max_drawdown::float8,b.risk_blocked,
      q.liquidation::float8,q.at,q.cash::float8 as marked_cash,
      coalesce(f.fees,0)::float8 as fees,coalesce(f.buys,0)::int as buys,coalesce(f.sells,0)::int as sells,
      coalesce(p.basis,0)::float8 as locked,coalesce(p.open,0)::int as open,coalesce(p.events,0)::int as events,
      coalesce(p.closed,0)::int as closed,coalesce(p.wins,0)::int as wins
      from weather.banks b join weather.experiments e on e.id=b.experiment
      left join lateral(select liquidation,at,cash from weather.equity where experiment=b.experiment and strategy=b.strategy order by at desc limit 1) q on true
      left join lateral(select sum(fee) fees,count(*) filter(where side='BUY') buys,count(*) filter(where side='SELL') sells
        from weather.fills where experiment=b.experiment and strategy=b.strategy) f on true
      left join lateral(select sum(basis) basis,count(*) filter(where shares>0) open,count(distinct event) events,
        count(*) filter(where closed_at is not null) closed,count(*) filter(where closed_at is not null and realized>0) wins
        from weather.positions where experiment=b.experiment and strategy=b.strategy) p on true
      where e.user_id=${user} and e.id in (select id from weather.experiments where user_id=${user} order by starts_at desc limit 5)`,
    sql`select p.*,m.payload->'station'->>'city' city from weather.positions p
      join weather.experiments e on e.id=p.experiment join weather.markets m on m.id=p.event
      where e.user_id=${user} and p.shares>0 order by p.opened_at desc limit 60`,
    sql`select f.*,m.payload->'station'->>'city' city,p.outcome from weather.fills f join weather.experiments e on e.id=f.experiment
      join weather.positions p on p.experiment=f.experiment and p.strategy=f.strategy and p.token=f.token join weather.markets m on m.id=p.event
      where e.user_id=${user} order by f.at desc limit 80`,
    sql`select a.id,a.experiment,a.strategy,a.token,a.at,a.action,a.reason,m.payload->'station'->>'city' city,
      a.evidence->'candidate'->>'reference' reference,a.evidence->'candidate'->>'ev' ev
      ,coalesce(a.evidence->'candidate'->'wallet'->>'wallet',a.evidence->'walletSell'->>'wallet') wallet
      from weather.audit a left join weather.experiments e on e.id=a.experiment join weather.markets m on m.id=a.event
      where a.experiment is null or e.user_id=${user} order by a.at desc limit 100`,
    sql`select q.experiment,q.strategy,date_trunc('hour',q.at) at,avg(q.cash+q.liquidation)::float8 equity
      from weather.equity q join weather.experiments e on e.id=q.experiment where e.user_id=${user}
      and q.at>now()-interval '14 days' group by 1,2,3 order by 3 desc limit 4500`,
  ]);
  return { readiness: states.find(row => row.key === "readiness") ?? null,
    live: states.find(row => row.key === "markets")?.payload ?? null,
    markets: markets.map(row => row.payload), runs,banks,positions,fills,decisions,equity };
}
