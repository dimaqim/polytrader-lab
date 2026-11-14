alter table weather.banks add column if not exists entries_paused boolean not null default false;

alter table weather.banks add column if not exists entries_revision integer not null default 0;

create or replace function weather.set_entries(owner_id text, exp_id uuid, str text, paused boolean)
returns boolean language plpgsql as $$
declare
  run_row weather.experiments%rowtype;
begin
  select * into run_row from weather.experiments where id=exp_id and user_id=owner_id for share;
  if not found or run_row.status='stopped' or run_row.ends_at<=clock_timestamp() or str='complete' then return false; end if;
  update weather.banks b set entries_paused=paused,
    entries_revision=b.entries_revision+case when b.entries_paused is distinct from paused then 1 else 0 end
    where b.experiment=exp_id and b.strategy=str;
  return found;
end $$;

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
    if bank.entries_paused or (bank.entries_revision>0 and (proof->>'entriesRevision') is distinct from bank.entries_revision::text)
      then return 'ENTRIES_PAUSED'; end if;
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
