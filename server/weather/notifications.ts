import { database } from "../db.ts";
import { weatherStrategies, type WeatherStrategy } from "../../lib/weather/strategies.ts";

export const notificationDefaults = { signals: true, fills: true, health: true, daily: true };
type Category = keyof typeof notificationDefaults;

export async function saveWeatherNotifications(user: string, value: typeof notificationDefaults) {
  await database()`insert into weather.notification_preferences(user_id,signals,fills,health,daily)
    values(${user},${value.signals},${value.fills},${value.health},${value.daily})
    on conflict(user_id) do update set signals=excluded.signals,fills=excluded.fills,health=excluded.health,daily=excluded.daily`;
}

export async function enqueueWeather(experiment: string, category: Category, key: string, text: string) {
  const payload = JSON.stringify({ text, section: "weather" });
  await database()`insert into lab.outbox(key,chat_id,payload)
    select ${"weather:"+category+":"+experiment+":"+key},u.chat_id,${payload} from weather.experiments e
    join lab.users u on u.id=e.user_id left join weather.notification_preferences p on p.user_id=u.id
    where e.id=${experiment} and u.alerts and u.chat_id is not null
      and coalesce((to_jsonb(p)->>${category})::boolean,true) on conflict do nothing`;
}

const signed = (value: number) => (value < 0 ? "−" : "+") + "$" + Math.abs(value).toFixed(2);

export async function weatherReport(now: number, stale: boolean) {
  const sql = database();
  const day = new Date(now).toISOString().slice(0, 10);
  const through = day + "T00:00:00Z";
  const runs = await sql`select e.id,e.starts_at,e.ends_at,e.status from weather.experiments e join lab.users u on u.id=e.user_id
    left join weather.notification_preferences p on p.user_id=u.id
    where e.status<>'stopped' and u.alerts and u.chat_id is not null and e.ends_at>now()-interval '24 hours'
      and ((coalesce(p.health,true) and ${stale} and e.ends_at>now() and e.status='running'
        and not exists(select 1 from lab.outbox o where o.key='weather:health:'||e.id||':'||${day}))
        or (coalesce(p.daily,true) and e.starts_at<${through}::timestamptz
        and not exists(select 1 from lab.outbox o where o.key='weather:daily:'||e.id||':'||${day})))`;
  for (const run of runs) {
    if (stale && run.status==="running" && +new Date(run.ends_at)>now) {
      await enqueueWeather(run.id,"health",day,"Weather Lab · Нет свежих котировок Polymarket. Новые виртуальные исполнения приостановлены.");
    }
    if (+new Date(run.starts_at) >= +new Date(through)) continue;
    const [banks, skips] = await sql.transaction([
      sql`select b.strategy,b.max_drawdown::float8,coalesce(f.pnl,0)::float8 pnl,coalesce(f.fees,0)::float8 fees,
          coalesce(f.wins,0)::int wins,coalesce(f.losses,0)::int losses,
          (q.finish-q.start)::float8 equity_change
        from weather.banks b left join lateral (
          select sum(pnl) pnl,sum(fee) fees,count(*) filter(where pnl>0) wins,count(*) filter(where pnl<0) losses
          from weather.fills where experiment=b.experiment and strategy=b.strategy
            and at<${through}::timestamptz and at>=${through}::timestamptz-interval '24 hours'
        ) f on true left join lateral (
          select (select cash+liquidation from weather.equity where experiment=b.experiment and strategy=b.strategy
            and at>=${through}::timestamptz-interval '24 hours' and at<${through}::timestamptz order by at desc limit 1) finish,
            (select cash+liquidation from weather.equity where experiment=b.experiment and strategy=b.strategy
            and at>=${through}::timestamptz-interval '24 hours' and at<${through}::timestamptz order by at limit 1) start
        ) q on true where b.experiment=${run.id} order by pnl desc,b.strategy`,
      sql`select count(*)::int as total from weather.audit where experiment=${run.id} and action='SKIP'
        and at<${through}::timestamptz and at>=${through}::timestamptz-interval '24 hours'`,
    ]);
    const previousDay = new Date(+new Date(through)-86400_000).toISOString().slice(0,10);
    const label = (key: WeatherStrategy) => weatherStrategies[key];
    const lines = banks.map(row => label(row.strategy) + " · PnL " + signed(row.pnl) + " · банк "
      + (row.equity_change == null ? "—" : signed(row.equity_change)) + " · +" + row.wins + "/−" + row.losses
      + " выходов · комиссии $" + row.fees.toFixed(2) + " · просадка $" + row.max_drawdown.toFixed(2));
    const leader = banks[0], last = banks.at(-1);
    const ranking = leader && last && leader.pnl !== last.pnl
      ? ["Лучший · " + label(leader.strategy) + " " + signed(leader.pnl), "Худший · " + label(last.strategy) + " " + signed(last.pnl)] : [];
    await enqueueWeather(run.id,"daily",day,["Weather Lab · " + previousDay + " UTC",...lines,
      "Пропущено сигналов: " + skips[0].total,"Поток при отправке: " + (stale ? "котировки недоступны" : "доступен"),...ranking].join("\n"));
  }
}
