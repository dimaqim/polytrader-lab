import { database,date } from "../db.ts";
import { clusteredInterval,forecastScore } from "../../lib/weather/scoring.ts";
import type { Probability } from "../../lib/weather/types.ts";

type Sample = { station: string; resolved: string; horizon: number; distribution: Probability[] };
const horizons = [24,12,6,1];

export async function sampleForecasts(rows: {event:string; end:number; at:number; distribution:Probability[]}[]) {
  const records=rows.flatMap(({event,end,at,distribution})=>{
    const hours=(end-at)/3600000;
    const horizon=horizons.find(h=>hours<=h && hours>=h-.25);
    return horizon && distribution.length ? [{event,horizon,at:date(at),distribution}] : [];
  });
  if (!records.length) return;
  await database()`insert into weather.probability_samples(event,horizon,observed_at,distribution)
    select r.event,r.horizon,r.at,r.distribution from jsonb_to_recordset(${JSON.stringify(records)}::jsonb)
    r(event text,horizon integer,at timestamptz,distribution jsonb) on conflict do nothing`;
}

export async function weatherScores(user: string | null) {
  const sql=database();
  const [samples,results]=await sql.transaction([
    sql`select p.horizon,p.distribution, m.payload->'station'->>'code' station, w.resolved
      from weather.probability_samples p join weather.markets m on m.id=p.event
      cross join lateral (
        select min(c->>'condition') filter(where c->'payout'->>0='1') resolved
        from jsonb_array_elements(m.payload->'contracts') c
        having count(*) filter(where c->'payout'->>0='1')=1
          and count(*)=count(*) filter(where c->'payout'->>0 in ('0','1'))
      ) w
      where p.observed_at>now()-interval '45 days' and (m.payload->>'verified')::boolean`,
    sql`select b.experiment,b.strategy,p.city_day,sum(p.realized)::float8 pnl
      from weather.banks b join weather.experiments e on e.id=b.experiment join weather.positions p
        on p.experiment=b.experiment and p.strategy=b.strategy
      where e.user_id=${user} group by b.experiment,b.strategy,p.city_day
      having bool_and(p.closed_at is not null)`,
  ]);
  const exits = user ? await sql`with comparisons as (
    select f.experiment,f.strategy,p.city_day,f.evidence->>'reason' reason,
      (f.gross-f.fee)::float8 proceeds, f.pnl::float8 pnl,
      f.shares::float8*(case when p.token=c->>'yes' then c->'payout'->>0 else c->'payout'->>1 end)::float8 held
    from weather.fills f join weather.experiments e on e.id=f.experiment
    join weather.positions p using(experiment,strategy,token) join weather.markets m on m.id=p.event
    cross join lateral jsonb_array_elements(m.payload->'contracts') c
    where e.user_id=${user} and f.side='SELL' and c->>'condition'=p.condition and c->'payout'->>0 is not null
  ) select experiment,reason,count(*)::int as sells,count(distinct city_day)::int as groups,
      sum(pnl)::float8 pnl,sum(proceeds-held)::float8 difference
    from comparisons group by experiment,reason order by sells desc` : [];
  const scores=(samples as Sample[]).flatMap(row=>{
    const winner=row.distribution.findIndex(x=>x.condition===row.resolved);
    const weather=forecastScore(row.distribution.map(p=>p.p),winner);
    const market=forecastScore(row.distribution.map(p=>p.market),winner);
    return weather ? [{...row,weather,market,winner}] : [];
  });
  const accuracy=horizons.map(horizon=>{
    const a=scores.filter(x=>x.horizon===horizon);
    const paired=a.filter(x=>x.market);
    const avg=(data:number[])=>data.length ? data.reduce((sum,p)=>sum+p,0)/data.length : null;
    const guesses=a.flatMap(row=>row.distribution.map((p,i)=>({p:p.p,y:Number(i===row.winner)})));
    return {horizon,n:a.length,paired:paired.length,brier:avg(a.map(x=>x.weather.brier)),logLoss:avg(a.map(x=>x.weather.logLoss)),
      pairedWeatherBrier:avg(paired.map(x=>x.weather.brier)),marketBrier:avg(paired.map(x=>x.market!.brier)),
      bins:Array.from({length:5},(_,i)=>{
        const bin=guesses.filter(x=>Math.min(4,Math.floor(x.p*5))===i);
        return {bottom:i/5,top:(i+1)/5,n:bin.length,predicted:avg(bin.map(x=>x.p)),observed:avg(bin.map(x=>x.y))};
      })};
  });
  const groups=new Map<string,{experiment:string;strategy:string;values:number[]}>();
  for (const row of results) {
    const key=row.experiment+"/"+row.strategy;
    const group=groups.get(key)??{experiment:row.experiment,strategy:row.strategy,values:[] as number[]};
    group.values.push(row.pnl);
    groups.set(key,group);
  }
  return {accuracy,exits,financial:[...groups.values()].map(group=>({experiment:group.experiment,strategy:group.strategy,n:group.values.length,
    interval:clusteredInterval(group.values)}))};
}
