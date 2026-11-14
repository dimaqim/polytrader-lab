create table if not exists weather.probability_samples (
  event text not null references weather.markets,
  horizon integer not null,
  observed_at timestamptz not null,
  distribution jsonb not null,
  primary key(event,horizon)
);
