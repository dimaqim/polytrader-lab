import { database, date } from "./db.ts";

export const storageLimit = 1024 ** 3;

export async function sampleStorage(slot: number) {
  const sql = database();
  const [schema]=await sql`select to_regclass('lab.storage_samples') is not null enabled`;
  if (!schema.enabled) return;
  const [sample] = await sql`insert into lab.storage_samples(at,bytes,tables)
    select ${date(slot)},pg_database_size(current_database()),
      (select jsonb_agg(jsonb_build_object('name',name,'bytes',bytes) order by bytes desc) from (
        select schemaname||'.'||relname name,pg_total_relation_size(relid) bytes
        from pg_stat_user_tables where schemaname in ('lab','weather') order by bytes desc limit 8
      ) sizes) on conflict(at) do update set bytes=excluded.bytes,tables=excluded.tables returning bytes::float8`;
  const tier = [90,80,70].find(value=>sample.bytes>=storageLimit*value/100);
  if (tier) {
    const day = date(slot).slice(0,10);
    const message = `PolyTrader Lab · ${tier===90?"Критично":tier===80?"Риск заполнения":"Заполняется хранилище"}\n`
      + `${(sample.bytes/storageLimit*100).toFixed(1)}% от 1 ГиБ. Откройте «Погода → Источники» для проверки.`;
    await sql`insert into lab.outbox(key,chat_id,payload)
      select 'storage:'||${day}||':'||${String(tier)}||':'||u.id,u.chat_id,${JSON.stringify({text:message,section:"weather"})}
      from lab.users u where u.alerts and u.chat_id is not null on conflict do nothing`;
  }
  await sql`delete from lab.storage_samples where at<now()-interval '30 days'`;
}

export async function storageStatus() {
  const sql=database();
  const [schema]=await sql`select to_regclass('lab.storage_samples') is not null enabled`;
  if(!schema.enabled) {
    const [live]=await sql`select now() at,pg_database_size(current_database())::float8 bytes,
      (select jsonb_agg(to_jsonb(s) order by s.bytes desc) from (select schemaname||'.'||relname name,
        pg_total_relation_size(relid)::float8 bytes from pg_stat_user_tables where schemaname in ('lab','weather') order by bytes desc limit 8) s) tables,
      (select jsonb_build_object('at',checked_at,'details',payload) from weather.state where key='archive') archive`;
    return {...live,limit:storageLimit,growth:null,seconds:null,migrationPending:true};
  }
  const [row] = await sql`with latest as (select * from lab.storage_samples order by at desc limit 1),
    baseline as (select s.* from lab.storage_samples s,latest l where s.at<l.at-interval '10 minutes'
      and s.at>=l.at-interval '25 hours' order by s.at limit 1)
    select l.at,l.bytes::float8 as bytes,l.tables,
      (l.bytes-b.bytes)::float8 as growth,extract(epoch from l.at-b.at)::float8 as seconds,
      (select jsonb_build_object('at',checked_at,'details',payload) from weather.state where key='archive') as archive,
      (select jsonb_build_object('at',at,'message',message,'repetitions',repetitions) from lab.logs
        where area in ('storage','weather_archive','wallet_recent') order by at desc limit 1) as error
    from latest l left join baseline b on true`;
  return row ? {...row,limit:storageLimit} : null;
}
