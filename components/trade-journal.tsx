"use client";

import { ArrowUpRight, Check, ChevronDown, Clock3, List, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { tradeReasons } from "../lib/trade-text";
import type { Trade } from "../lib/workspace";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (value: number) => currency.format(value);
export const resultMoney = (value: number) => value > 0 ? "+" + money(value) : money(value);
export const shortAddress = (value: string) => value.slice(0, 6) + "…" + value.slice(-4);
export const walletLink = (wallet: string) => "https://polymarket.com/profile/" + encodeURIComponent(wallet);
export const journalDay = (time: string) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Kyiv", day: "numeric", month: "long", year: "numeric",
}).format(new Date(time));
export const dateTime = (time: string | number) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Kyiv", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(new Date(time));
const cents = (value: number) => Number((value * 100).toFixed(2)).toLocaleString("ru-RU") + "¢";
const contracts = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const outcomes: Record<string, string> = { yes: "Да", no: "Нет", up: "Выше", down: "Ниже" };
const filters = [
  ["trades", "Сделки"], ["open", "Открыты"], ["settled", "Закрыты"], ["pending", "На подтверждении"], ["skipped", "Пропущены"],
] as const;
type Filter = typeof filters[number][0];

function TradeCard({ row }: { row: Trade }) {
  const trader = row.wallet_name || (row.wallet ? shortAddress(row.wallet) : "Трейдер");
  const state = row.settled_at ? "Закрыта" : row.opened_at ? "Открыта"
    : row.status === "pending" ? "Ждёт ответа" : "Пропущена";
  const outcome = row.outcome && (outcomes[row.outcome.toLowerCase()] ?? row.outcome);
  const priced = row.settled_at ? row.pnl : row.unrealized_pnl;
  const tone = priced == null || priced === 0 ? "" : priced > 0 ? "profit" : "loss";
  return <article className="trade-card">
    <header className="trade-header">
      <div className="trade-source">
        <span className="avatar" aria-hidden="true">{trader.slice(0, 1).toUpperCase()}</span>
        <div>{row.wallet ? <a aria-label={`Трейдер ${trader} на Polymarket`} href={walletLink(row.wallet)} target="_blank" rel="noreferrer" className="trader">{trader}</a>
          : <strong>{row.strategy === "combo" ? "Комбо" : trader}</strong>}
          <div className="muted trade-mode">{row.mode === "confirm" ? "С подтверждением" : "Автокопирование"}</div>
        </div>
      </div>
      <div className="trade-result">
        <span className={"trade-state " + (row.opened_at && !row.settled_at ? "active" : "")}>
          {row.settled_at ? <Check size={13} /> : row.opened_at ? <Clock3 size={13} /> : null}{state}
        </span>
        {priced != null && <strong className={tone}>{resultMoney(priced)}{!row.settled_at && <small>оценка</small>}</strong>}
      </div>
    </header>
    <div className="trade-market">
      {row.slug ? <a href={`https://polymarket.com/event/${encodeURIComponent(row.slug)}`} target="_blank" rel="noreferrer">
        {row.label}<ArrowUpRight size={15} aria-label="На Polymarket" />
      </a> : <strong>{row.label}</strong>}
      {outcome && <p className="muted">Исход <strong>{outcome}</strong></p>}
    </div>
    {row.opened_at ? <dl className="trade-time">
      <div><dt>Ваш вход</dt><dd><time dateTime={row.opened_at}>{dateTime(row.opened_at)}</time></dd>
        {row.cost != null && <dd className="muted">{money(row.cost)}{row.price != null ? " по " + cents(row.price) : ""}</dd>}</div>
      <div><dt>Выход по расчёту</dt><dd>{row.settled_at ? <time dateTime={row.settled_at}>{dateTime(row.settled_at)}</time> : "Ждёт расчёта"}</dd>
        {row.payout != null && <dd className="muted">Выплата {money(row.payout)}</dd>}</div>
    </dl> : <div className="trade-note">
      {row.status === "pending" ? "Подтвердите или пропустите вход в чате до " + dateTime(row.expires_at) + "."
        : tradeReasons[row.reason ?? ""] ?? "Вход не состоялся. Средства остались в тесте."}
    </div>}
    <details className="trade-details">
      <summary>Подробнее <ChevronDown size={16} /></summary>
      <dl>
        {row.source_at != null && <div><dt>{row.source_side === "SELL" ? "Продажа трейдера" : "Покупка трейдера"}</dt><dd>{dateTime(row.source_at)}</dd></div>}
        {row.source_price != null && <div><dt>Цена трейдера</dt><dd>{cents(row.source_price)}</dd></div>}
        <div><dt>Бот заметил</dt><dd><time dateTime={row.observed_at}>{dateTime(row.observed_at)}</time></dd></div>
        {row.shares != null && <div><dt>Контракты</dt><dd>{contracts(row.shares)}</dd></div>}
        {row.fee != null && <div><dt>Комиссия</dt><dd>{money(row.fee)}</dd></div>}
        {row.status === "partial" && <div><dt>Объём</dt><dd>Исполнена часть заявки</dd></div>}
      </dl>
    </details>
  </article>;
}

export function TradeJournal({ authenticated, onStart, onLogin }: {
  authenticated: boolean; onStart: () => void; onLogin: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("trades");
  const [rows, setRows] = useState<Trade[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(authenticated);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || cursor) return;
    const refresh = () => { if (!document.hidden) setRevision(value => value + 1); };
    const timer = window.setInterval(refresh, 25_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [authenticated, cursor]);

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ status: filter, ...(cursor ? { cursor } : {}) });
    setBusy(true);
    setError(false);
    fetch("/api/history?" + params, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { rows: Trade[]; next: string | null };
      if (controller.signal.aborted) return;
      setRows(prior => cursor ? prior.concat(data.rows.filter(row => !prior.some(old => old.id === row.id))) : data.rows);
      setNext(data.next);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [authenticated, filter, cursor, revision]);

  if (!authenticated) return <div className="empty">
    <List size={24} aria-hidden="true" /><h2>Ваши сделки в Telegram</h2>
    <p>Войдите, чтобы увидеть покупки, пропуски и расчёты по вашим тестам.</p>
    <button className="action" onClick={onLogin}>Войти через Telegram</button>
  </div>;

  const chooseFilter = (key: Filter) => {
    if (key === filter) return;
    setRows([]); setNext(null); setBusy(true); setCursor(null); setFilter(key);
  };
  const days = new Map<string, Trade[]>();
  for (const row of rows) {
    const day = journalDay(row.opened_at ?? row.observed_at);
    const group = days.get(day);
    if (group) group.push(row);
    else days.set(day, [row]);
  }
  return <section aria-label="Журнал сделок">
    <header className="journal-tools">
      <div className="filters" role="group" aria-label="Фильтр сделок">
        {filters.map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => chooseFilter(key)}>{label}</button>)}
      </div>
      <div className="journal-note"><span>Время по Киеву</span>
        <button className="text-action" onClick={() => { setCursor(null); setRevision(revision + 1); }}>Обновить</button>
      </div>
    </header>
    {error && <div className="notice" role="status">Журнал пока недоступен. <button onClick={() => setRevision(revision + 1)}>Повторить</button></div>}
    {days.size > 0 && <div className="trade-list">{Array.from(days, ([day, group]) => <section className="combo-day" key={day}>
      <h2>{day}</h2><div className="trade-list">{group.map(row => <TradeCard key={row.id} row={row} />)}</div>
    </section>)}</div>}
    {busy && rows.length === 0 && <p className="loading" role="status"><LoaderCircle size={17} /> Загружаем сделки…</p>}
    {!busy && !error && rows.length === 0 && <div className="empty">
      <List size={24} aria-hidden="true" /><h2>{{
        trades: "Виртуальных сделок пока нет", open: "Нет открытых позиций", settled: "Закрытых сделок пока нет",
        pending: "Нет сделок на подтверждении", skipped: "Нет пропущенных сигналов",
      }[filter]}</h2>
      {filter === "trades" && <><p>Выберите трейдера и задайте сумму, на которую бот может повторять его покупки.</p>
        <button className="action" onClick={onStart}>Начать копировать</button></>}
    </div>}
    {next && <button className="action secondary load-more" disabled={busy} onClick={() => setCursor(next)}>
      {busy ? "Загружаем…" : "Показать более ранние"}
    </button>}
  </section>;
}
