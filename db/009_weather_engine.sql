create schema if not exists weather;

create table if not exists weather.markets (
  id text primary key, payload jsonb not null, checked_at timestamptz not null
);

create table if not exists weather.inputs (
  kind text not null, id text not null, station text not null, received_at timestamptz not null,
  payload jsonb not null, primary key(kind,id)
);

create index if not exists weather_input_station on weather.inputs(station,kind,received_at desc);

create table if not exists weather.state (
  key text primary key, checked_at timestamptz not null default now(), payload jsonb not null
);

create table if not exists weather.experiments (
  id uuid primary key default gen_random_uuid(), user_id text references lab.users(id), starts_at timestamptz not null default now(),
  ends_at timestamptz not null default now()+interval '14 days', status text not null default 'running'
    check(status in ('running','paused','stopped')),
  configuration jsonb not null
);

create or replace function weather.start_experiment(owner_id text, config jsonb, strategy_ids text[])
returns uuid language plpgsql as $$
declare new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('weather.start:'||owner_id,0));
  if exists(select 1 from weather.experiments where user_id=owner_id and status<>'stopped' and ends_at>now())
    or not exists(select 1 from weather.state where key='readiness' and checked_at>now()-interval '45 seconds' and (payload->>'ready')::boolean)
    then return null; end if;
  insert into weather.experiments(user_id,configuration,ends_at) values(owner_id,config,now()+interval '336 hours') returning id into new_id;
  insert into weather.banks(experiment,strategy) select new_id,unnest(strategy_ids);
  return new_id;
end $$;

create table if not exists weather.banks (
  experiment uuid not null references weather.experiments, strategy text not null, initial numeric not null default 100,
  cash numeric not null default 100 check(cash>=0), realized numeric not null default 0, peak numeric not null default 100,
  max_drawdown numeric not null default 0, risk_blocked boolean not null default false,
  primary key(experiment,strategy)
);

create table if not exists weather.positions (
  experiment uuid not null, strategy text not null, token text not null, event text not null references weather.markets,
  condition text not null, city_day text not null, outcome text not null, opened_at timestamptz not null default now(),
  shares numeric not null check(shares>=0), basis numeric not null check(basis>=0), original_cost numeric not null,
  realized numeric not null default 0, closed_at timestamptz,
  primary key(experiment,strategy,token),
  foreign key(experiment,strategy) references weather.banks(experiment,strategy)
);

create index if not exists weather_open_positions on weather.positions(event) where shares>0;

create table if not exists weather.audit (
  id text primary key, experiment uuid, strategy text not null, event text not null references weather.markets,
  token text, at timestamptz not null, action text not null, reason text not null, evidence jsonb not null
);

create index if not exists weather_audit_recent on weather.audit(at desc);
create index if not exists weather_audit_strategy on weather.audit(experiment,strategy,at desc);

create table if not exists weather.fills (
  id text primary key, experiment uuid not null, strategy text not null, token text not null,
  at timestamptz not null default now(), side text not null check(side in ('BUY','SELL','SETTLE')),
  shares numeric not null check(shares>0), gross numeric not null check(gross>=0), fee numeric not null check(fee>=0),
  basis numeric not null check(basis>=0), pnl numeric, evidence jsonb not null,
  foreign key(experiment,strategy,token) references weather.positions(experiment,strategy,token)
);

create table if not exists weather.equity (
  experiment uuid not null, strategy text not null, at timestamptz not null, cash numeric not null, liquidation numeric,
  primary key(experiment,strategy,at), foreign key(experiment,strategy) references weather.banks(experiment,strategy)
);

create or replace function weather.post_fill(
  fill_id text, exp_id uuid, str text, asset text, event_id text, market_condition text, city_date text, bet text,
  direction text, quantity numeric, amount numeric, commission numeric, proof jsonb
) returns text language plpgsql as $$
declare
  bank weather.banks%rowtype;
  position weather.positions%rowtype;
  run_row weather.experiments%rowtype;
  tied numeric; entry_cost numeric; released numeric; proceeds numeric; trading_pnl numeric;
  decision_at timestamptz := clock_timestamp();
begin
  select * into run_row from weather.experiments where id=exp_id for share;
  select * into bank from weather.banks where experiment=exp_id and strategy=str for update;
  if not found then return 'NO_BANK'; end if;
  if exists(select 1 from weather.fills where id=fill_id) then return 'DUPLICATE'; end if;
  if quantity<=0 or amount<0 or commission<0 or direction not in ('BUY','SELL','SETTLE') then return 'INVALID_FILL'; end if;
  if direction<>'SETTLE' and ((proof->>'expiresAt') is null or to_timestamp((proof->>'expiresAt')::float8 / 1000)<=decision_at)
    then return 'STALE_BOOK'; end if;
  select * into position from weather.positions where experiment=exp_id and strategy=str and token=asset for update;
  if direction='BUY' then
    if run_row.status<>'running' or decision_at>=run_row.ends_at or bank.risk_blocked then return 'RISK_REJECTED'; end if;
    if position.token is not null then return 'DUPLICATE_POSITION'; end if;
    entry_cost := amount+commission;
    select coalesce(sum(basis),0) into tied from weather.positions p where p.experiment=exp_id and p.strategy=str and shares>0;
    if entry_cost>least(5,bank.cash) or tied+entry_cost>15 then return 'RISK_REJECTED'; end if;
    if exists(select 1 from weather.positions p where p.experiment=exp_id and p.strategy=str
      and p.city_day=city_date and p.event<>event_id) then return 'CORRELATED_EVENT'; end if;
    insert into weather.positions(experiment,strategy,token,event,condition,city_day,outcome,shares,basis,original_cost)
      values(exp_id,str,asset,event_id,market_condition,city_date,bet,quantity,entry_cost,entry_cost);
    update weather.banks set cash=cash-entry_cost where experiment=exp_id and strategy=str;
    released := entry_cost;
  else
    if position.token is null or quantity>position.shares then return 'NO_INVENTORY'; end if;
    released := position.basis*quantity/position.shares;
    proceeds := amount-commission;
    if proceeds<0 then return 'INVALID_FILL'; end if;
    trading_pnl := proceeds-released;
    update weather.positions set shares=shares-quantity,basis=basis-released,
      realized=realized+trading_pnl,closed_at=case when shares=quantity then decision_at end
      where experiment=exp_id and strategy=str and token=asset;
    update weather.banks set cash=cash+proceeds, realized=realized+trading_pnl
      where experiment=exp_id and strategy=str;
  end if;
  insert into weather.fills(id,experiment,strategy,token,side,shares,gross,fee,basis,pnl,evidence)
    values(fill_id,exp_id,str,asset,direction,quantity,amount,commission,released,trading_pnl,proof);
  return case when direction='SETTLE' then 'SETTLED' when direction='SELL' then 'PAPER_SELL_FILLED' else 'PAPER_FILLED' end;
end $$;
