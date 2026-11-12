import { database } from "./db.ts";

export async function systemHealth() {
  const [health] = await database()`select
    exists(select 1 from lab.heartbeats where source='neon' and at>now()-interval '3 minutes') as monitor,
    exists(select 1 from lab.heartbeats where source='collector' and at>now()-interval '30 seconds') as process,
    exists(select 1 from lab.heartbeats where source='collector' and at>now()-interval '30 seconds'
      and coalesce(details->>'socketOpen', (details->>'status' in ('syncing','connected'))::text)='true') as socket,
    exists(select 1 from lab.heartbeats where source='collector' and at>now()-interval '30 seconds' and details->>'connected'='true') as quotes,
    (select details from lab.heartbeats where source='polymarket' and at>now()-interval '10 minutes') as upstream`;
  const yes = (ok: boolean | undefined) => ok == null ? "Нет свежей проверки" : ok ? "Доступен" : "Нет связи";
  return [
    "PolyTrader Lab · Состояние системы",
    "Neon PostgreSQL · Доступен",
    `Планировщик Neon · ${health.monitor ? "Работает" : "Нет свежего запуска"}`,
    `Polymarket Gamma · ${yes(health.upstream?.gamma)}`,
    `Polymarket Data · ${yes(health.upstream?.data)}`,
    `Polymarket CLOB · ${yes(health.upstream?.clob)}`,
    `Процесс сборщика · ${health.process ? "Запущен" : "Нет свежего heartbeat"}`,
    `WebSocket · ${health.socket ? "Открыт" : "Нет подключения"}`,
    `Котировки BTC · ${health.quotes ? "Свежие стаканы" : "Нет достоверных данных"}`,
    "Telegram webhook · Команда получена",
  ].join("\n");
}

export async function tradingReports(user: string | null, kind: "daily" | "stats" | "portfolio") {
  const daily = kind === "daily";
  const rows = await database()`select u.id,u.chat_id,
    count(e.id)::int as tests, count(e.id) filter(where not e.paused and not e.risk_blocked and e.ends_at>now())::int as active,
    coalesce(sum(e.bank),0)::float8 as bank, coalesce(sum(e.cash),0)::float8 as cash,
    coalesce(max(e.worst_drawdown),0)::float8 as drawdown,
    coalesce(sum(p.pnl),0)::float8 as pnl,coalesce(sum(p.fees),0)::float8 as fees,
    coalesce(sum(p.wins),0)::int as wins,coalesce(sum(p.settled),0)::int as settled,
    coalesce(sum(p.open),0)::int as open,coalesce(sum(d.missed),0)::int as missed
    from lab.users u left join lab.experiments e on e.user_id=u.id
    left join lateral (
      select sum(pnl) filter(where not ${daily} or settled_at>now()-interval '24 hours') as pnl,
        sum(fee) filter(where not ${daily} or opened_at>now()-interval '24 hours') as fees,
        count(*) filter(where settled_at is null) as open,
        count(*) filter(where settled_at is not null and (not ${daily} or settled_at>now()-interval '24 hours')) as settled,
        count(*) filter(where pnl>0 and (not ${daily} or settled_at>now()-interval '24 hours')) as wins
      from lab.positions where experiment=e.id
    ) p on true
    left join lateral (
      select count(*) as missed from lab.decisions where experiment=e.id and status in ('unfilled','skipped')
        and (not ${daily} or updated_at>now()-interval '24 hours')
    ) d on true
    where (${user}::text is not null and u.id=${user})
      or (${user}::text is null and u.alerts and u.chat_id is not null and e.id is not null)
    group by u.id,u.chat_id`;
  const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  const pct = (value: number) => (value * 100).toFixed(1) + "%";
  return rows.map(row => {
    const title = daily ? "Дневной отчёт · 24 ч" : kind === "portfolio" ? "Портфель" : "Статистика";
    const portfolio = [
      `Виртуальный банк: ${usd(row.bank)}`,
      `Свободные средства: ${usd(row.cash)}`,
      `Открытые позиции: ${row.open}`,
    ];
    const stats = [
      `Активные тесты: ${row.active} из ${row.tests}`,
      `Реализованный PnL: ${usd(row.pnl)}`,
      `ROI${daily ? " за 24 ч к сумме стартовых банков" : ""}: ${row.bank ? pct(row.pnl / row.bank) : "—"}`,
      `Завершённые сделки: ${row.settled}`,
      `Win Rate: ${row.settled ? pct(row.wins / row.settled) : "—"}`,
      `Макс. просадка за всё время: ${pct(row.drawdown)}`,
      `Комиссии: ${usd(row.fees)}`,
      `Пропущенные сигналы: ${row.missed}`,
    ];
    return { id: row.id as string, chat: row.chat_id as string, message: [
      `PolyTrader Lab · ${title}`, ...portfolio, ...(kind === "portfolio" ? stats.slice(0, 2) : stats),
    ].join("\n") };
  });
}
