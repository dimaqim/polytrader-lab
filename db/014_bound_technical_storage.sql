alter table weather.audit add column if not exists first_at timestamptz;
alter table weather.audit add column if not exists repetitions integer not null default 1;
alter table weather.audit add column if not exists last_observation_id text;

create table if not exists lab.storage_samples (
  at timestamptz primary key,
  bytes bigint not null,
  tables jsonb not null
);

create or replace function weather.aggregate_audit()
returns trigger language plpgsql as $aggregate$
declare
  aggregate_id text;
  sample text;
  hour_slot bigint := floor(extract(epoch from new.at)/3600);
begin
  if new.action='SKIP' or (new.action='HOLD' and new.reason='SETTLEMENT_HOLD') then
    sample := jsonb_build_array(new.evidence->>'source',new.evidence#>>'{signalBook,book,source}',
      new.evidence#>>'{model,confidence}',new.evidence#>>'{model,observed}',new.evidence#>>'{model,revision}',
      (select jsonb_agg(case when value ~ '^[-]?[0-9]+(\.[0-9]+)?$' then round(value::numeric / .03) end order by ordinal)
       from unnest(array[new.evidence#>>'{candidate,reference}',new.evidence#>>'{candidate,probability}',
         new.evidence->>'fair',new.evidence->>'afterFees',new.evidence#>>'{model,leadProbability}']) with ordinality as v(value,ordinal)))::text;
    aggregate_id := encode(sha256(convert_to(jsonb_build_array(new.experiment,new.strategy,new.event,new.token,
      new.action,new.reason,hour_slot,sample)::text,'UTF8')),'hex');
    new.first_at := new.at;
    if coalesce((select bytes from lab.storage_samples order by at desc limit 1),0)>=966367641 then return null; end if;
    insert into weather.audit(id,experiment,strategy,event,token,at,action,reason,evidence,first_at,last_observation_id)
      values(aggregate_id,new.experiment,new.strategy,new.event,new.token,new.at,new.action,new.reason,new.evidence,new.at,new.id)
      on conflict(id) do update set at=excluded.at, repetitions=weather.audit.repetitions+1,
        evidence=excluded.evidence,last_observation_id=excluded.last_observation_id
      where weather.audit.last_observation_id is distinct from excluded.last_observation_id and weather.audit.at<=excluded.at;
    return null;
  end if;
  return new;
end
$aggregate$;
create or replace trigger weather_z_aggregate_audit_insert
before insert on weather.audit
for each row when (pg_trigger_depth()=0) execute function weather.aggregate_audit();

create or replace function lab.guard_wallet_archive()
returns trigger language plpgsql as $wallet$
begin
  -- Only compact entries from live scanners. Old deployed backfill code omits this marker.
  if new.payload->>'operational' is distinct from '1' or new.event_at < now()-interval '15 minutes'
    or new.event_at > now() or pg_column_size(new.payload)>1500 then return null; end if;
  if pg_table_size('lab.wallet_activity')>=16777216 or
    coalesce((select bytes from lab.storage_samples order by at desc limit 1),0)>=966367641 then return null; end if;
  return new;
end
$wallet$;
create or replace trigger lab_wallet_archive_guard
before insert on lab.wallet_activity for each row execute function lab.guard_wallet_archive();

alter table lab.logs add column if not exists fingerprint text;
alter table lab.logs add column if not exists first_at timestamptz;
alter table lab.logs add column if not exists repetitions integer not null default 1;
create unique index if not exists lab_log_fingerprint on lab.logs(fingerprint);

create or replace function lab.aggregate_log()
returns trigger language plpgsql as $logging$
declare
  key text := md5(jsonb_build_array(new.area,new.level,new.message,floor(extract(epoch from new.at)/3600))::text);
begin
  insert into lab.logs(at,area,level,message,fingerprint,first_at)
    values(new.at,new.area,new.level,new.message,key,new.at)
    on conflict(fingerprint) do update set at=excluded.at,repetitions=lab.logs.repetitions+1;
  return null;
end
$logging$;
create or replace trigger lab_aggregate_log_insert
before insert on lab.logs for each row when (pg_trigger_depth()=0) execute function lab.aggregate_log();

create index if not exists wallet_activity_recent on lab.wallet_activity(event_at,wallet,id);
create index if not exists weather_inputs_archive on weather.inputs(received_at,kind,id);
