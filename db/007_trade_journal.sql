create or replace view lab.visible_trades as
select d.id,d.status,d.reason,e.id as experiment,e.user_id,s.strategy,s.label,s.observed_at,
  least(s.expires_at,e.ends_at) as expires_at,coalesce(m.slug,s.evidence->>'slug') as slug,
  coalesce(q.outcome,s.evidence->>'outcome') as outcome,e.mode,coalesce(s.wallet,e.wallet) as wallet,w.name as wallet_name,
  (s.evidence->>'upstreamAt')::float8 as source_at,s.evidence->>'side' as source_side,s.reference::float8 as source_price,
  p.opened_at,p.settled_at,p.price::float8,p.shares::float8,p.cost::float8,p.fee::float8,p.pnl::float8,p.payout::float8,
  (p.shares*q.mark-p.cost)::float8 as unrealized_pnl
from lab.decisions d join lab.signals s on s.id=d.signal join lab.experiments e on e.id=d.experiment
left join lab.positions p on p.decision=d.id left join lab.markets m on m.condition=s.condition
left join lab.wallets w on w.address=coalesce(s.wallet,e.wallet)
left join lateral (
  select m.outcomes->>(t.ord::int-1) as outcome,
    case when p.settled_at is null and m.open and m.ends_at>now() and m.seen_at>now()-interval '3 minutes'
      then (m.prices->>(t.ord::int-1))::numeric end as mark
  from jsonb_array_elements_text(m.tokens) with ordinality t(token,ord) where t.token=s.token
) q on true
where e.strategy in ('copy','combo') and not lab.hidden_market(s.label,coalesce(m.slug,s.evidence->>'slug'));
