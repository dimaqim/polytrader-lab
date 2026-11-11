import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const sql = neon(process.env.DATABASE_URL);
await sql.query(`do $$
declare
  u text := 'qa:' || gen_random_uuid()::text;
  c text := 'qa:' || gen_random_uuid()::text;
  e uuid; s uuid; d uuid; p uuid; t timestamptz := date_trunc('milliseconds',now()); state text;
begin
  begin
    insert into lab.users(id,name) values(u,'transaction fixture');
    insert into lab.markets(condition,slug,title,ends_at,tokens,outcomes,prices,fee,open,seen_at)
      values(c,c,c,now()+interval '5 minutes','["1","2"]','["Up","Down"]','[0.5,0.5]','{"rate":0.07,"exponent":1}',true,now());
    insert into lab.experiments(user_id,strategy,version,mode,rules,bank,cash,stake,drawdown,exposure,slippage,starts_at,ends_at,peak)
      values(u,'copy',1,'auto','{}',100,100,10,.2,.5,100,now()-interval '1 min',now()+interval '5 min',100) returning id into e;
    insert into lab.signals(key,strategy,condition,token,label,target_at,observed_at,expires_at,reference,evidence)
      values(c,'copy',c,'1',c,now(),now(),now()+interval '1 min',.5,'{}') returning id into s;
    insert into lab.decisions(experiment,signal,status,lease_at) values(e,s,'processing',t) returning id into d;
    state := lab.finish_decision(d,t,'{"cost":9,"shares":16,"fee":1,"price":0.5,"slippageBps":0,"partial":true}',null,'{}');
    if state <> 'partial' or (select cash from lab.experiments where id=e) <> 91 then raise exception 'Fill did not debit exactly'; end if;
    if lab.finish_decision(d,t,null,'duplicate','{}') <> 'stale' then raise exception 'Duplicate fill not rejected'; end if;
    select id into p from lab.positions where decision=d;
    if not lab.settle_position(p,1) then raise exception 'Position did not settle'; end if;
    if lab.settle_position(p,1) then raise exception 'Duplicate settlement not rejected'; end if;
    if (select cash from lab.experiments where id=e) <> 107 or (select pnl from lab.positions where id=p) <> 7 then
      raise exception 'Settlement balances failed';
    end if;
    raise sqlstate 'ZX101' using message='rollback fixture';
  exception when sqlstate 'ZX101' then null;
  end;
  if exists(select 1 from lab.users where id=u) then raise exception 'Fixture persisted'; end if;
end $$`, []);
console.log("Verified partial execution, atomic debit, settlement and deduplication. Fixture rolled back.");
