create table if not exists lab.combo_watch (
  wallet text primary key references lab.wallets(address),
  ranked_at timestamptz,
  checked_at timestamptz,
  synced_at timestamptz,
  history_cursor jsonb not null default '{}'
);

create table if not exists lab.combo_redemptions (
  id text primary key,
  combo_id text not null,
  paid_at timestamptz not null,
  amount numeric not null check (amount > 0),
  tx_hash text not null
);

create index if not exists combo_redemptions_position on lab.combo_redemptions(combo_id);
create index if not exists combos_by_entry on lab.combos(event_at desc,id desc);
create index if not exists combos_by_wallet on lab.combos(wallet);
