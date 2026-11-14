-- Compact high-frequency research decisions without touching full execution evidence
-- kept in weather.fills. Runs also for older Mac collector versions until they update.
create or replace function weather.compact_audit_evidence()
returns trigger language plpgsql as $audit$
declare
  e jsonb := new.evidence;
  c jsonb := e->'candidate';
  sb jsonb := e->'signalBook';
  xb jsonb := e->'executionBook';
begin
  if pg_column_size(e) <= 1800 then
    return new;
  end if;
  new.evidence := jsonb_strip_nulls(jsonb_build_object(
    'compact', true,
    'at', e->'at',
    'readyAt', e->'readyAt',
    'source', e->'source',
    'fair', e->'fair',
    'afterFees', e->'afterFees',
    'basisPerShare', e->'basisPerShare',
    'priorBasis', e->'priorBasis',
    'netPerShare', e->'netPerShare',
    'entriesRevision', e->'entriesRevision',
    'candidate', case when c is not null then jsonb_strip_nulls(jsonb_build_object(
      'token',c->'token','strategy',c->'strategy','yes',c->'yes',
      'reason',c->'reason','reference',c->'reference','ev',c->'ev',
      'probability',c->'probability','conservative',c->'conservative',
      'contract',jsonb_build_object('bucket',jsonb_build_object('label',c#>'{contract,bucket,label}')),
      'wallet',case when c->'wallet' is not null then jsonb_strip_nulls(jsonb_build_object(
        'wallet',c#>'{wallet,wallet}', 'price',c#>'{wallet,price}',
        'at',c#>'{wallet,at}','receivedAt',c#>'{wallet,receivedAt}')) end
    )) end,
    'walletSell',case when e->'walletSell' is not null then jsonb_strip_nulls(jsonb_build_object(
      'wallet',e#>'{walletSell,wallet}', 'price',e#>'{walletSell,price}',
      'at',e#>'{walletSell,at}','receivedAt',e#>'{walletSell,receivedAt}')) end,
    'signalBook',case when sb is not null then jsonb_build_object('book',jsonb_strip_nulls(jsonb_build_object(
      'source',sb#>'{book,source}', 'receivedAt',sb#>'{book,receivedAt}',
      'sourceAt',sb#>'{book,sourceAt}'))) end,
    'executionBook',case when xb is not null then jsonb_build_object('book',jsonb_strip_nulls(jsonb_build_object(
      'source',xb#>'{book,source}', 'receivedAt',xb#>'{book,receivedAt}',
      'sourceAt',xb#>'{book,sourceAt}'))) end,
    'model',case when e->'estimate' is not null then jsonb_strip_nulls(jsonb_build_object(
      'at',e#>'{estimate,at}', 'confidence',e#>'{estimate,confidence}',
      'observed',e#>'{estimate,observed}')) end
  ));
  return new;
end
$audit$;
create or replace trigger weather_compact_audit_insert
before insert on weather.audit
for each row execute function weather.compact_audit_evidence();
