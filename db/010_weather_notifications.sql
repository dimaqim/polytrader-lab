create table if not exists weather.notification_preferences (
  user_id text primary key references lab.users(id) on delete cascade,
  signals boolean not null default true,
  fills boolean not null default true,
  health boolean not null default true,
  daily boolean not null default true
);
