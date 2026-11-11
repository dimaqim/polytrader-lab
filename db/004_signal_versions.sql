alter table lab.signals add column if not exists version int not null default 1;
create index if not exists signals_strategy_window on lab.signals(strategy,version,observed_at desc);
