import { neon } from "@neondatabase/serverless";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const sql = neon(process.env.DATABASE_URL);
await sql.transaction([sql.query(`do $$
declare
  exp uuid; owner_id text := 'TEST_FIXTURE_'||gen_random_uuid(); event_id text := 'TEST_FIXTURE_' || gen_random_uuid()::text;
  expires jsonb := jsonb_build_object('expiresAt', extract(epoch from now()+interval '1 min')*1000,'label','TEST_FIXTURE');
  status text; balance numeric;
begin
  begin
  insert into weather.markets(id,payload,checked_at) values(event_id,'{}',now());
  insert into lab.users(id,name) values(owner_id,'Weather rollback fixture');
  insert into weather.experiments(user_id,configuration) values(owner_id,'{"mode":"TEST_FIXTURE"}') returning id into exp;
  insert into weather.banks(experiment,strategy) values(exp,'favorite');
  status := weather.post_fill(event_id||'b',exp,'favorite','token',event_id,'condition','station/date','YES','BUY',10,4.5,.1,expires);
  if status<>'PAPER_FILLED' then raise exception 'BUY failed %',status; end if;
  status := weather.post_fill(event_id||'b',exp,'favorite','token',event_id,'condition','station/date','YES','BUY',10,4.5,.1,expires);
  if status<>'DUPLICATE' then raise exception 'Duplicate BUY passed'; end if;
  if weather.set_entries('other-owner',exp,'favorite',true) then raise exception 'Foreign mutation passed'; end if;
  if not weather.set_entries(owner_id,exp,'favorite',true) then raise exception 'Pause failed'; end if;
  if not weather.set_entries(owner_id,exp,'favorite',true) then raise exception 'Idempotent pause failed'; end if;
  if (select entries_revision from weather.banks where experiment=exp and strategy='favorite')<>1
    then raise exception 'Duplicate request changed revision'; end if;
  status := weather.post_fill(event_id||'paused',exp,'favorite','another',event_id,'condition','station/date','YES','BUY',5,2,.1,expires);
  if status<>'ENTRIES_PAUSED' then raise exception 'Paused BUY passed: %',status; end if;
  status := weather.post_fill(event_id||'s0',exp,'favorite','token',event_id,'condition','station/date','YES','SELL',11,7,.1,expires);
  if status<>'NO_INVENTORY' then raise exception 'Oversell passed'; end if;
  status := weather.post_fill(event_id||'s',exp,'favorite','token',event_id,'condition','station/date','YES','SELL',5,3,.1,expires);
  if status<>'PAPER_SELL_FILLED' then raise exception 'SELL failed %',status; end if;
  status := weather.post_fill(event_id||'t',exp,'favorite','token',event_id,'condition','station/date','YES','SETTLE',5,5,0,'{"label":"TEST_FIXTURE"}');
  if status<>'SETTLED' then raise exception 'Settlement failed %',status; end if;
  status := weather.post_fill(event_id||'t',exp,'favorite','token',event_id,'condition','station/date','YES','SETTLE',5,5,0,'{}');
  if status<>'DUPLICATE' then raise exception 'Duplicate settlement passed'; end if;
  select cash into balance from weather.banks where experiment=exp and strategy='favorite';
  if balance<>103.3 then raise exception 'Wrong cash %',balance; end if;
  if not weather.set_entries(owner_id,exp,'favorite',false) then raise exception 'Resume failed'; end if;
  status := weather.post_fill(event_id||'stale',exp,'favorite','another',event_id,'condition','station/date','YES','BUY',5,2,.1,expires||'{"entriesRevision":1}');
  if status<>'ENTRIES_PAUSED' then raise exception 'Old pending BUY passed after resume: %',status; end if;
  status := weather.post_fill(event_id||'new',exp,'favorite','another',event_id,'condition','station/date','YES','BUY',5,2,.1,expires||'{"entriesRevision":2}');
  if status<>'PAPER_FILLED' then raise exception 'Fresh BUY after resume failed: %',status; end if;
  raise sqlstate 'ZX101' using message='rollback TEST_FIXTURE';
  exception when sqlstate 'ZX101' then null;
  end;
end $$`, [])]);
console.log("TEST_FIXTURE verified BUY, partial SELL, settlement, cash, ownership, idempotent pause, SELL and SETTLE during pause, and stale BUY after resume. Rolled back.");
