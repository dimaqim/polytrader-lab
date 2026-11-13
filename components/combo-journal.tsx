"use client";

import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { comboMinimum, comboStates, type ComboFeed, type ComboRecord } from "../lib/combos";
import { dateTime, journalDay, money, resultMoney, shortAddress, walletLink } from "./trade-journal";

const filters = [
  ["all", "Все"], ["OPEN", "Открытые"], ["RESOLVED_WIN", "Победы"], ["RESOLVED_LOSS", "Проигрыши"],
] as const;
type Filter = typeof filters[number][0];
const timeFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
const shownMoney = (value: number | null) => value == null ? "—" : money(value);
const legStatus: Record<string, string> = { OPEN: "Ожидаем", RESOLVED_WIN: "Сыграл", RESOLVED_LOSS: "Не сыграл", RESOLVED_VOID: "Отменён", VOID: "Отменён" };

function ComboCard({ row, filterTrader }: { row: ComboRecord; filterTrader: () => void }) {
  const who = row.name ?? shortAddress(row.wallet);
  const status = comboStates[row.status as keyof typeof comboStates] ?? "Исход уточняется";
  const tone = row.status === "RESOLVED_WIN" ? "profit" : row.status === "RESOLVED_LOSS" ? "loss" : "active";
  const needRedeem = row.status === "RESOLVED_WIN" && row.redeemable;
  const receivedLabel = row.received == null && row.status === "OPEN" ? "После расчёта"
    : row.received == null && needRedeem ? "Можно получить"
    : row.received == null ? "Нет подтверждения" : shownMoney(row.received);

  return <article className="combo">
    <header className="combo-header">
      <div>
        <h3><a href={walletLink(row.wallet)} target="_blank" rel="noreferrer">{who}<ArrowUpRight size={14} aria-hidden="true" /></a></h3>
        <p>Вход <time dateTime={row.event_at}>{timeFormat.format(new Date(row.event_at))}</time></p>
      </div>
      <span className={"trade-state " + tone}>{status}</span>
    </header>
    <dl className="combo-money">
      <div><dt>{row.cost == null ? "Вход без комиссии" : "Поставил"}</dt><dd>{shownMoney(row.cost ?? row.entry)}</dd></div>
      <div><dt>Получил</dt><dd className={row.received == null ? "combo-unknown" : ""}>{receivedLabel}</dd></div>
      <div><dt>Прибыль / убыток</dt><dd className={row.profit == null ? "combo-unknown" : row.profit > 0 ? "profit" : row.profit < 0 ? "loss" : ""}>
        {row.profit == null ? "—" : resultMoney(row.profit)}
      </dd></div>
    </dl>
    {row.received == null && row.proceeds != null && row.proceeds > 0 && <p className="combo-payout-note">
      Polymarket показывает выплату {money(row.proceeds)}. Подтверждение получения ищем в истории кошелька.
    </p>}
    <ol className="combo-legs" aria-label="Исходы комбо">
        {row.legs.map((leg, index) => {
          const slug = leg.market.event?.event_slug || leg.market.slug;
          const title = leg.market.question || leg.market.event?.event_title || leg.market.title;
          const marketTitle = leg.market.group_item_title || leg.market.title;
          return <li key={leg.leg_index ?? index}>
            <span>
              {slug ? <a href={`https://polymarket.com/event/${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">{title}</a> : title}
              <small>{marketTitle !== title ? marketTitle + " · " : ""}<strong>{leg.leg_outcome_label}</strong></small>
            </span>
            <span className="trade-state">{legStatus[leg.leg_status ?? ""] ?? "Исход уточняется"}</span>
          </li>;
        })}
    </ol>
    <details className="trade-details combo-details">
      <summary>Детали ставки и выплаты <ChevronDown size={16} aria-hidden="true" /></summary>
      <dl className="combo-dates">
        <div><dt>Поставил</dt><dd>{dateTime(row.event_at)}</dd></div>
        <div><dt>Бот заметил</dt><dd>{dateTime(row.detected_at)}</dd></div>
        <div><dt>Рассчитано</dt><dd>{row.resolved_at ? dateTime(row.resolved_at) : "—"}</dd></div>
        {row.fee != null && <div><dt>Комиссия входа</dt><dd>{money(row.fee)}</dd></div>}
        {row.paid_at && <div><dt>Выплата получена</dt><dd>{row.tx_hash
          ? <a href={`https://polygonscan.com/tx/${row.tx_hash}`} target="_blank" rel="noreferrer">{dateTime(row.paid_at)}</a>
          : dateTime(row.paid_at)}</dd></div>}
      </dl>
      <button className="text-action" onClick={filterTrader}>Все комбо этого трейдера</button>
    </details>
  </article>;
}

export function ComboJournal() {
  const [filter, setFilter] = useState<Filter>("all");
  const [trader, setTrader] = useState<{ wallet: string; name: string } | null>(null);
  const [feed, setFeed] = useState<ComboFeed | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const current = useRef<AbortController | null>(null);
  const loadedOlder = useRef(false);

  const load = useCallback(async (cursor?: string) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError(false);
    const params = new URLSearchParams({ status: filter, ...(trader ? { wallet: trader.wallet } : {}), ...(cursor ? { cursor } : {}) });
    try {
      const response = await fetch("/api/combos?" + params, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Combo feed unavailable");
      const page = await response.json() as ComboFeed;
      if (controller.signal.aborted) return;
      if (cursor) loadedOlder.current = true;
      setFeed(prior => !cursor || !prior ? page
        : { ...page, rows: prior.rows.concat(page.rows.filter(row => !prior.rows.some(old => old.id === row.id))) });
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [filter, trader]);

  useEffect(() => {
    loadedOlder.current = false;
    setFeed(null);
    void load();
    const update = () => {
      if (!document.hidden && !loadedOlder.current) void load();
    };
    const timer = window.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { current.current?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [load]);

  const groups = new Map<string, ComboRecord[]>();
  for (const row of feed?.rows ?? []) {
    const day = journalDay(row.event_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(row);
  }
  const monitor = feed?.monitor;
  const currentScan = monitor?.ok && Date.now() - +new Date(monitor.checkedAt) < 10 * 60_000;
  return <section className="combo-journal" aria-label="Лента крупных комбо">
    <div className="combo-controls">
      <div className="combo-filters" role="group" aria-label="Фильтр комбо">
        {filters.map(([value, title]) => <button type="button" key={value} aria-pressed={value === filter} onClick={() => setFilter(value)}>{title}</button>)}
      </div>
      <div className="combo-toolbar">
        <p>{monitor?.lastSuccess ? `Проверено ${dateTime(monitor.lastSuccess)}` : "Время по Киеву"}
          {monitor && !currentScan && <small>Обновление задерживается</small>}</p>
        <button className="text-action" disabled={busy} onClick={() => { loadedOlder.current = false; void load(); }}>
          <RefreshCw size={15} aria-hidden="true" />Обновить
        </button>
      </div>
      {trader && <div className="combo-toolbar"><p>Трейдер <strong>{trader.name}</strong></p>
        <button className="text-action" onClick={() => setTrader(null)}>Сбросить</button></div>}
      <details className="trade-details combo-method">
        <summary>Как бот находит комбо <ChevronDown size={16} aria-hidden="true" /></summary>
        <p>Каждые 5 минут бот проверяет часть кошельков из недельного рейтинга Polymarket. Список из 12 лидеров обновляется раз в час. Бот продолжает следить за ранее найденными открытыми ставками и выплатами.</p>
        <p>Порог — {money(comboMinimum)} без комиссии. Дата в ленте — день первого входа по Киеву. «Поставил» включает комиссию. «Получил» показывает выплаты из истории кошелька. Итог считается после расчёта.</p>
      </details>
    </div>
    {error && <div className="notice" role="status">Не удалось обновить комбо. <button onClick={() => void load()}>Повторить</button></div>}
    {busy && !feed && !error && <p className="loading" role="status">Загружаем комбо…</p>}
    {!busy && !error && groups.size === 0 && <div className="empty">
      <h2>Комбо по этому фильтру пока нет</h2>
      <p>Смените фильтр или проверьте ленту позже.</p>
    </div>}
    {Array.from(groups, ([day, rows]) => <section className="combo-day" key={day} aria-label={day}>
      <h2>{day}</h2>
      <div className="combo-entries">{rows.map(row => <ComboCard key={row.id} row={row} filterTrader={() => {
        setFilter("all");
        setTrader({ wallet: row.wallet, name: row.name ?? shortAddress(row.wallet) });
        window.scrollTo(0, 0);
      }} />)}</div>
    </section>)}
    {feed?.next && <button className="action secondary load-more" disabled={busy} onClick={() => void load(feed.next!)}>
      {busy ? "Загружаем…" : "Показать более ранние комбо"}
    </button>}
  </section>;
}
