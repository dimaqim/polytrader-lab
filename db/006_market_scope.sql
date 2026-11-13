create or replace function lab.hidden_market(title text, slug text)
returns boolean language sql immutable parallel safe as $$
  select concat_ws(' ', title, slug) ~* '(^|[^[:alnum:]])(btc|bitcoin|xbt|eth|ether|ethereum|биткоин[а-яё]*|биткойн[а-яё]*|эфир[а-яё]*|этериум[а-яё]*|эфириум[а-яё]*)([^[:alnum:]]|$)'
$$;

update lab.experiments set paused=true
where strategy in ('btc5','btc15','maker') and ends_at>now() and not paused;
