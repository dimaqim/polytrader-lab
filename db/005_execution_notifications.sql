create or replace function lab.finish_decision(d_id uuid, claimed_at timestamptz, fill jsonb, why text, evidence jsonb)
returns text language plpgsql as $$
declare
  d lab.decisions; e lab.experiments; s lab.signals; m lab.markets; used numeric; debit numeric; final text;
begin
  select * into d from lab.decisions where id=d_id for update;
  if not found or d.status<>'processing' or d.lease_at is distinct from claimed_at then return 'stale'; end if;
  select * into e from lab.experiments where id=d.experiment for update;
  select * into s from lab.signals where id=d.signal;
  select * into m from lab.markets where condition=s.condition;
  if e.paused or e.risk_blocked then why := 'risk_or_pause';
  elsif now()>=e.ends_at or now()>=s.expires_at then why := 'expired';
  elsif fill is not null and (m.condition is null or not m.open or m.ends_at<=now()) then why := 'market_closed';
  end if;
  if why is null and fill is not null then
    debit := (fill->>'cost')::numeric;
    select coalesce(sum(cost),0) into used from lab.positions where experiment=e.id and settled_at is null;
    if debit>e.cash or debit>e.stake or used+debit>e.bank*e.exposure then why := 'exposure_or_cash';
    elsif e.worst_drawdown>=e.drawdown then why := 'drawdown';
    elsif used>0 and not coalesce((select coverage and at>now()-interval '3 minutes' from lab.equity where experiment=e.id order by at desc limit 1),false)
      then why := 'unverified_open_equity';
    else
      insert into lab.positions(decision,experiment,condition,token,shares,cost,fee,price,slippage,opened_at)
      values(d.id,e.id,s.condition,s.token,(fill->>'shares')::numeric,debit,(fill->>'fee')::numeric,
        (fill->>'price')::numeric,(fill->>'slippageBps')::numeric,now());
      update lab.experiments set cash=cash-debit where id=e.id;
    end if;
  end if;
  final := case when why is not null or fill is null then 'unfilled'
    when (fill->>'partial')::boolean then 'partial' else 'filled' end;
  update lab.decisions set status=final, reason=coalesce(why,case when fill is null then 'no_verified_fill' end),
    execution=evidence, updated_at=now() where id=d.id;
  insert into lab.outbox(key,chat_id,payload)
    select 'result:'||d.id,u.chat_id,jsonb_build_object('text','Paper · '||s.label||E'\n'||
      case final when 'filled' then 'Исполнено виртуально' when 'partial' then 'Частично исполнено виртуально'
        else 'Подтверждённая сделка пропущена. Причина доступна в журнале Mini App.' end||
      case when final in ('filled','partial') then E'\nВиртуальная покупка $'||round(debit,2) else '' end)
    from lab.users u where u.id=e.user_id and u.chat_id is not null and u.alerts
      and (final in ('filled','partial') or e.mode='confirm') on conflict do nothing;
  return final;
end $$;
