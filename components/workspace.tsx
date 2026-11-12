"use client";

import { useEffect, useState, useRef, useCallback, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, BarChart3, FlaskConical, History, LayoutDashboard,
  Layers3, Menu, Moon, Plus, Radio, RefreshCw, Send, Settings, Sun, Users, Wallet, X,
} from "lucide-react";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "./ui/button";
import { seedWallet, strategies, strategyIds, type Strategy } from "../lib/strategies";
import type { Run, Trade, WorkspaceData } from "../lib/workspace";

const navigation = [
  { id: "dashboard", title: "Обзор", icon: LayoutDashboard },
  { id: "strategies", title: "Стратегии", icon: FlaskConical },
  { id: "markets", title: "Рынки", icon: Radio },
  { id: "copy", title: "Кошельки", icon: Users },
  { id: "combos", title: "Комбо", icon: Layers3 },
  { id: "portfolio", title: "Портфель", icon: Wallet },
  { id: "history", title: "Журнал", icon: History },
  { id: "analytics", title: "Аналитика", icon: BarChart3 },
  { id: "settings", title: "Настройки", icon: Settings },
] as const;
type Page = typeof navigation[number]["id"];
type TelegramApp = { initData: string; ready: () => void; expand: () => void; colorScheme?: string };
type Pair = { code: string; secret: string; url: string };
const errors: Record<string, string> = {
  invalid_parameters: "Проверьте банк, размер ставки и лимиты.",
  invalid_wallet: "Введите публичный адрес в формате 0x…",
  telegram_chat_required: "Откройте бота и отправьте /start, чтобы получать сигналы на подтверждение.",
  invalid_telegram_identity: "Сессия Telegram устарела. Откройте Mini App из меню бота ещё раз.",
  login_required: "Войдите через Telegram, чтобы запустить тест.",
  experiment_inactive: "Этот тест уже завершён или остановлен лимитом риска.",
  database_unconfigured: "Подключение к базе ещё не настроено.",
  service_unavailable: "Хранилище временно недоступно.",
};
const reasons: Record<string, string> = {
  expired: "Срок истёк", missing_collector_window: "Пропущено окно сбора", missing_fresh_depth: "Нет свежего стакана",
  insufficient_liquidity_or_slippage: "Мало ликвидности или превышено проскальзывание", source_sell_outside_v1: "Продажа вне правил v1",
  combo_rfq_depth_unavailable: "Нет публичной котировки RFQ", missing_market_parameters: "Нет параметров рынка",
  expired_or_closed: "Срок истёк или рынок закрыт", market_closed: "Рынок закрыт", risk_or_pause: "Пауза или лимит риска",
  exposure_or_cash: "Лимит позиции или недостаточно средств", drawdown: "Лимит просадки", unverified_open_equity: "Капитал открытых позиций не оценён", user_skipped: "Пропущено пользователем",
  below_threshold: "Цена ниже порога или нет фаворита", quote_api_error: "API котировок недоступен", missing_market: "Рынок недоступен",
  maker_research_estimate: "Парный спред · исследовательская оценка", missing_catalog_window: "Раунд не получен из каталога",
  maker_no_trade_through: "Нет подтверждённого прохода цены", maker_continuity_gap: "Разрыв в потоке стакана",
};
const statuses: Record<string, string> = {
  filled: "Исполнено", partial: "Частично", unfilled: "Не исполнено", pending: "Ожидает", processing: "Проверяется",
  queued: "В очереди", skipped: "Пропущено",
};
const dollars = (n: number | null | undefined) => n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
const percent = (n: number | null | undefined) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;
const count = (n: number) => new Intl.NumberFormat("ru-RU").format(n);
const when = (time: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "medium" }).format(new Date(time));
const clock = (time: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(time));
const compactWallet = (address: string) => address.slice(0, 8) + "…" + address.slice(-5);
const price = (n: number | null | undefined) => n == null ? "—" : `${(n * 100).toFixed(1)}¢`;
const status = (r: Run) => r.risk_blocked ? "Лимит риска" : +new Date(r.ends_at) <= Date.now() ? "Завершён" : r.paused ? "На паузе" : "Активен";
const botUrl = (bot: string | null | undefined) => bot ? `https://t.me/${bot}` : null;
const shortMode = (mode: string) => mode === "auto" ? "Авто" : "Подтверждение";

async function api<T>(path: string, payload?: object): Promise<T> {
  const res = await fetch("/api/" + path, payload ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  } : { cache: "no-store" });
  const result = await res.json();
  if (!res.ok) throw Error(errors[result.error] ?? "Не удалось выполнить запрос. Попробуйте ещё раз.");
  return result as T;
}
function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true">PT</span>PolyTrader Lab</span>;
}
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{text}</p>{action}</div>;
}
function RouteLinks({ page, navigate }: { page: Page; navigate: (page: Page) => void }) {
  return <nav aria-label="Разделы">
    {[{ label: "Торговля", items: navigation.slice(0, 3) }, { label: "Исследование", items: navigation.slice(3) }].map(group =>
      <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(n => (
        <a key={n.id} href={"#" + n.id} onClick={e => { e.preventDefault(); navigate(n.id); }} aria-current={page === n.id ? "page" : undefined}>
          <n.icon size={17} aria-hidden="true" />{n.title}
        </a>
      ))}</div>
    )}
  </nav>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-body"><div className="modal-heading"><h2 id="modal-title">{title}</h2>
      <Button size="icon" variant="ghost" aria-label="Закрыть" onClick={onClose}><X size={19} aria-hidden="true" /></Button></div>{children}</div>
  </dialog>;
}
function collectorOnline(data: WorkspaceData | null) {
  const collector = data?.health.find(h => h.source === "collector");
  return !!collector?.details.connected && Date.now() - +new Date(collector.at) < 30_000;
}
function MarketHealth({ data, unavailable }: { data: WorkspaceData | null; unavailable: boolean }) {
  const heartbeat = data?.health.find(h => h.source === "neon");
  const monitor = !!heartbeat && Date.now() - +new Date(heartbeat.at) < 180_000;
  const healthy = monitor && heartbeat.details.sections?.every(Boolean);
  const collectorLive = collectorOnline(data);
  return <dl className="health-list">
    <div><dt>Мониторинг рынков</dt><dd>
      <span className={healthy && !unavailable ? "positive" : ""}>
        {unavailable ? "Нет связи" : healthy ? "Работает" : monitor ? "Есть ошибки" : "Нет свежего запуска"}
      </span>
      {heartbeat && <small>Обновление в {clock(heartbeat.at)}</small>}
    </dd></div>
    <div><dt>Стакан BTC в реальном времени</dt><dd>
      <span className={collectorLive ? "positive" : "warning"}>{collectorLive ? "Подключён" : "Сборщик выключен"}</span>
      <small>{collectorLive ? "Снимки доступны для сигналов BTC" : "Окна T−30 и T−60 могут быть пропущены"}</small>
    </dd></div>
  </dl>;
}
function MarketTable({ markets, loading, filtered = false }: {
  markets: WorkspaceData["markets"]; loading: boolean; filtered?: boolean;
}) {
  if (!markets.length) return <Empty title={loading ? "Загружаю рынки…" : filtered ? "Раунды не найдены" : "Нет свежих котировок"}
    text={filtered ? "Выберите другую длительность раунда." : "Котировки появятся после обновления каталога."} />;
  return <div className="table-wrap"><table role="table" className="market-table">
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Рынок</th><th scope="col" role="columnheader">Котировки</th>
      <th scope="col" role="columnheader">Закрытие</th><th scope="col" role="columnheader">Обновлено</th></tr></thead>
    <tbody role="rowgroup">{markets.map(m => <tr role="row" key={m.condition}>
      <td role="cell"><a href={`https://polymarket.com/event/${encodeURIComponent(m.slug)}`} target="_blank" rel="noreferrer">
        {m.interval_minutes == null ? m.title : `BTC за ${m.interval_minutes} мин`} <ArrowUpRight size={13} aria-hidden="true" /></a>
        {m.interval_minutes != null && <small>Раунд с {clock(new Date(+new Date(m.ends_at) - m.interval_minutes * 60_000).toISOString())}</small>}</td>
      <td role="cell" data-label="Котировки"><div className="quote-pair">{m.outcomes.map((o, i) => (
        <span key={o}><span>{o === "Up" ? "Вверх" : o === "Down" ? "Вниз" : o}</span><strong className="number">{price(m.prices[i])}</strong></span>
      ))}</div></td>
      <td role="cell" data-label="Закрытие" className="number"><time dateTime={m.ends_at} title={when(m.ends_at)}>{m.interval_minutes == null ? when(m.ends_at) : clock(m.ends_at)}</time></td>
      <td role="cell" data-label="Обновлено" className="number"><time dateTime={m.seen_at}>{clock(m.seen_at)}</time></td>
    </tr>)}</tbody>
  </table></div>;
}
function Trades({ rows, details = false }: { rows: Trade[]; details?: boolean }) {
  if (!rows.length) return <Empty title="Сигналов пока нет" text="Журнал пополнится после первого решения по сигналу." />;
  return <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Сигнал / рынок</th><th scope="col" role="columnheader">Режим</th><th scope="col" role="columnheader">Статус</th><th scope="col" role="columnheader">Цена</th>{details && <><th scope="col" role="columnheader">Объём</th><th scope="col" role="columnheader">Комиссия</th><th scope="col" role="columnheader">Задержка исполнения</th></>}<th scope="col" role="columnheader">PnL</th><th scope="col" role="columnheader">Время · Киев</th></tr></thead>
    <tbody role="rowgroup">{rows.map(row => <tr role="row" key={row.id}><td role="cell"><strong>{row.label}</strong><small>{strategies[row.strategy].name}{row.reason ? " · " + (reasons[row.reason] ?? row.reason) : ""}</small>{row.evidence?.modeledShares ? <small>Парный объём {row.evidence.modeledShares.toFixed(2)} · оценка спреда {dollars(row.evidence.modeledSpread)}</small> : null}</td>
      <td role="cell" data-label="Режим">{shortMode(row.mode)}</td><td role="cell" data-label="Статус"><span className={"tag " + (row.status === "filled" || row.status === "partial" ? "good" : row.status === "pending" ? "amber" : "muted")}>{statuses[row.status] ?? row.status}</span></td>
      <td role="cell" data-label="Цена" className="number">{price(row.price)}</td>{details && <><td role="cell" data-label="Объём" className="number">{row.shares == null ? "—" : row.shares.toFixed(2)}</td><td role="cell" data-label="Комиссия" className="number">{dollars(row.fee)}</td><td role="cell" data-label="Задержка" className="number">{row.execution?.delayMs == null ? "—" : Math.round(row.execution.delayMs) + " мс"}</td></>}<td role="cell" data-label="PnL" className={"number " + (row.pnl != null && row.pnl >= 0 ? "positive" : row.pnl != null ? "negative" : "")}>{dollars(row.pnl)}</td>
      <td role="cell" data-label="Время · Киев" className="number nowrap">{when(row.observed_at)}</td></tr>)}</tbody></table></div>;
}
function HistoryPanel({ enabled }: { enabled: boolean }) {
  const [filter, setFilter] = useState("all");
  const [rows, setRows] = useState<Trade[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const read = useCallback(async (cursor?: string) => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ status: filter, ...(cursor ? { cursor } : {}) });
      const result = await api<{ rows: Trade[]; next: string | null }>("history?" + params);
      if (current !== request.current) return;
      setRows(prior => cursor ? [...prior, ...result.rows] : result.rows);
      setNext(result.next);
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    } finally {
      if (current === request.current) setBusy(false);
    }
  }, [filter]);
  useEffect(() => {
    setRows([]);
    setNext(null);
    if (enabled) void read();
    return () => { request.current++; };
  }, [read, enabled]);
  return <Panel><div className="panel-head"><div><h2>Решения по сигналам</h2><p>Исполнения, пропуски, комиссии и задержки</p></div>
    <select aria-label="Фильтр статуса" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Все статусы</option>{Object.entries(statuses).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></div>
    {error ? <p className="notice" role="status">{error} <button onClick={() => void read()}>Повторить</button></p> :
      busy && rows.length === 0 ? <Empty title="Загрузка журнала" text="Запрашиваю решения по сигналам." /> : <Trades rows={rows} details />}
    {next && <button className="panel-link" disabled={busy} onClick={() => void read(next)}>{busy ? "Загрузка…" : "Показать более ранние"}</button>}
  </Panel>;
}

function Equity({ data, start }: { data: WorkspaceData | null; start: () => void }) {
  const runs = data?.runs ?? [];
  const [chosen, setChosen] = useState("");
  const [range, setRange] = useState(7);
  const selected = runs.find(r => r.id === chosen) ?? runs[0];
  const points = data?.equity.filter(p => p.experiment === selected?.id && +new Date(p.at) >= Date.now() - range * 86400_000).map(p => ({
    time: when(p.at), value: p.value,
  })) ?? [];
  return <Panel className="equity"><div className="panel-head"><div><h2>Кривая капитала</h2><p>Переоценка виртуального банка</p></div>
    {selected && <div className="segments" role="group" aria-label="Период графика">{[7, 14, 21].map(n => <button key={n} className={range === n ? "selected" : ""} onClick={() => setRange(n)} aria-pressed={range === n}>{n} д</button>)}</div>}</div>
    {runs.length > 0 && <select className="chart-select" value={selected?.id} onChange={e => setChosen(e.target.value)} aria-label="Тест для графика">
      {runs.map(r => <option value={r.id} key={r.id}>{strategies[r.strategy].name} · {shortMode(r.mode)} · {when(r.starts_at)}</option>)}
    </select>}
    {points.some(p => p.value != null) ? <div className="chart-area"><ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
      <LineChart data={points} margin={{ top: 12, left: 0, right: 14, bottom: 5 }} accessibilityLayer>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <YAxis tickFormatter={n => "$" + n} domain={["auto", "auto"]} width={60} tickLine={false} axisLine={false} tick={{ fill: "var(--secondary)", fontSize: 12 }} />
        <XAxis dataKey="time" minTickGap={70} tickFormatter={s => s.split(",")[0]} tickLine={false} axisLine={false} tick={{ fill: "var(--secondary)", fontSize: 12 }} />
        <Tooltip formatter={value => [dollars(Number(value)), "Капитал"]} contentStyle={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line-strong)", borderRadius: 5 }} />
        <Line type="linear" dataKey="value" stroke="var(--accent-text)" strokeWidth={2} connectNulls={false} dot={points.length < 3} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer></div> : <Empty
      title={selected ? "За этот период нет оценок" : "Портфель пока пуст"}
      text={selected ? "Выберите другой период или дождитесь следующего расчёта." : "Запустите тест, чтобы открыть виртуальный банк."}
      action={!selected && <Button size="small" variant="outline" onClick={start}>Новый тест <ArrowRight size={14} aria-hidden="true" /></Button>} />}
  </Panel>;
}

function RunTable({ runs, onPause, ranking, collectorActive }: {
  runs: Run[]; onPause?: (run: Run) => void; ranking?: boolean; collectorActive?: boolean;
}) {
  if (!runs.length) return <Empty title={ranking ? "Нет рассчитанных сделок за неделю" : "Нет запущенных тестов"} text={ranking ? "Рейтинг появится после расчёта первых позиций." : "Запустите стратегию, чтобы сформировать независимый виртуальный банк."} />;
  return <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Стратегия</th><th scope="col" role="columnheader">{ranking ? "PnL · 7 д" : "Рассчитанный PnL"}</th><th scope="col" role="columnheader">ROI{ranking ? " · 7 д" : ""}</th><th scope="col" role="columnheader">Win rate / 95% ДИ</th><th scope="col" role="columnheader">Макс. просадка</th><th scope="col" role="columnheader">{ranking ? "Сделки · 7 д" : "Сделки / пропуски"}</th><th scope="col" role="columnheader">{onPause ? "Статус" : "Комиссии"}</th></tr></thead>
    <tbody role="rowgroup">{runs.map(run => {
      const ci = ranking ? run.weeklyInterval95 : run.interval95;
      const rate = ranking ? (run.weekly_settled ? run.weekly_wins / run.weekly_settled : null) : run.winRate;
      return <tr role="row" key={run.id}><td role="cell"><strong>{strategies[run.strategy].name}</strong><small>v{run.version} · {shortMode(run.mode)} · {dollars(run.bank)}</small>
          {collectorActive === false && strategies[run.strategy].collector && status(run) === "Активен" && <small className="warning">Сборщик котировок выключен</small>}</td>
        <td role="cell" data-label="PnL" className="number">{dollars(ranking ? run.weekly_pnl : run.pnl)}</td><td role="cell" data-label="ROI" className="number">{percent(ranking ? run.weekly_pnl / run.bank : run.roi)}</td>
        <td role="cell" data-label="Доля прибыльных" className="number">{percent(rate)}<small>{ci ? percent(ci[0]) + " – " + percent(ci[1]) : "—"}</small></td>
        <td role="cell" data-label="Макс. просадка" className="number">{percent(run.drawdown)}</td><td role="cell" data-label="Сделки" className="number">{ranking ? run.weekly_settled : `${run.fills} / ${run.missed}`}</td>
        <td role="cell" data-label={onPause ? "Статус" : "Комиссии"} className={onPause ? "run-controls" : undefined}>{onPause ? <><span className={"tag " + (status(run) === "Активен" ? "good" : "muted")}>{status(run)}</span>
          {!run.risk_blocked && +new Date(run.ends_at) > Date.now() && <Button variant="ghost" size="small" onClick={() => onPause(run)}>{run.paused ? "Возобновить" : "Пауза"}</Button>}</> : <>{dollars(run.fees)}<small>Проск. {run.slippage == null ? "—" : run.slippage.toFixed(1) + " б.п."}</small></>}</td></tr>;
    })}</tbody></table></div>;
}

function StartForm({ strategy, wallet, wallets, onSubmit, busy }: { strategy: Strategy; wallet: string; wallets: WorkspaceData["wallets"]; onSubmit: (body: object) => void; busy: boolean }) {
  const [selected, setSelected] = useState(strategy);
  const [days, setDays] = useState("7");
  const [custom, setCustom] = useState(false);
  const requestId = useRef<string | null>(null);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    requestId.current ??= crypto.randomUUID();
    onSubmit({ requestId: requestId.current, strategy: selected, mode: f.get("mode"), wallet: f.get("wallet"), bank: Number(f.get("bank")),
      stake: Number(f.get("stake")), days: Number(days), drawdown: Number(f.get("drawdown")), exposure: Number(f.get("exposure")), slippage: Number(f.get("slippage")) });
  }
  return <form className="run-form" onSubmit={submit} autoComplete="off">
    <label>Стратегия<select name="strategy" value={selected} onChange={e => setSelected(e.target.value as Strategy)}>{strategyIds.map(id => <option value={id} key={id}>{strategies[id].name} · v{strategies[id].version}</option>)}</select></label>
    <p>{strategies[selected].description}. Параметры сохраняются на весь тест.</p>
    {selected === "copy" && <label>Публичный кошелёк<input name="wallet" autoComplete="off" spellCheck={false} list="wallets" defaultValue={wallet} required pattern="0x[0-9a-fA-F]{40}" />
      <datalist id="wallets">{wallets.map(w => <option value={w.address} key={w.address}>{w.name}</option>)}</datalist></label>}
    <label>Режим<select name="mode"><option value="auto">Автоматический</option><option value="confirm">Подтверждение в Telegram</option><option value="both">Оба режима · два независимых банка</option></select></label>
    <div className="fields"><label>Виртуальный банк, $<input name="bank" type="number" min="10" max="1000000" step=".01" defaultValue="1000" required /></label>
    <label>Ставка с комиссией, $<input name="stake" type="number" min="1" step=".01" defaultValue="25" required /></label>
    <label>Макс. просадка, %<input name="drawdown" type="number" min="1" max="100" step=".1" defaultValue="15" required /></label>
    <label>Лимит открытых позиций, %<input name="exposure" type="number" min="1" max="100" step=".1" defaultValue="25" required /></label></div>
    <label>Макс. проскальзывание, б.п.<input name="slippage" type="number" min="0" max="5000" defaultValue="150" required /></label>
    <fieldset><legend>Продолжительность</legend><div className="segments">
      {[7, 14, 21].map(n => <button type="button" key={n} className={!custom && +days === n ? "selected" : ""} onClick={() => { setDays(String(n)); setCustom(false); }}>{n} дней</button>)}
      <button type="button" className={custom ? "selected" : ""} onClick={() => setCustom(true)}>Своя</button></div></fieldset>
    {custom && <label>Дни<input name="custom-duration" aria-label="Своя продолжительность в днях" type="number" min=".05" max="365" step="any" value={days} onChange={e => setDays(e.target.value)} required /></label>}
    {strategies[selected].collector && <p className="notice">Для этой стратегии нужен сборщик котировок Polymarket.</p>}
    <Button type="submit" disabled={busy}>{busy ? "Запускаю…" : "Запустить тест"}<ArrowRight size={16} aria-hidden="true" /></Button>
  </form>;
}

export function Workspace() {
  const [page, setPage] = useState<Page>("dashboard");
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState("light");
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"start" | "auth" | null>(null);
  const [selected, setSelected] = useState<Strategy>("btc15");
  const [testWallet, setTestWallet] = useState(seedWallet);
  const [pair, setPair] = useState<Pair | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [marketFilter, setMarketFilter] = useState("all");
  const [walletSearch, setWalletSearch] = useState("");
  const [comboSort, setComboSort] = useState("time");
  const initial = useRef(false);
  const startAfterAuth = useRef(false);
  const refresh = useCallback(async () => {
    try { setData(await api<WorkspaceData>("workspace")); setOffline(false); }
    catch { setOffline(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const tg = (window as unknown as { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
    const preferred = localStorage.getItem("polytrader-theme") ?? (tg?.initData ? tg.colorScheme : null) ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = preferred;
    setTheme(preferred);
    tg?.ready(); tg?.expand();
    if (!initial.current) {
      initial.current = true;
      const auth = tg?.initData ? api("auth/telegram", { initData: tg.initData }).catch(e => setMessage(e.message)) : Promise.resolve();
      void auth.then(refresh);
    }
    const readPage = () => {
      const section = window.location.hash.slice(1) || "dashboard";
      if (navigation.some(item => item.id === section)) setPage(section as Page);
    };
    readPage();
    window.addEventListener("hashchange", readPage);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 25_000);
    return () => { clearInterval(timer); window.removeEventListener("hashchange", readPage); };
  }, [refresh]);
  useEffect(() => {
    if (!pair || dialog !== "auth") return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ ok?: boolean }>("auth/claim", { code: pair.code, secret: pair.secret });
        if (result.ok) {
          setPair(null); setDialog(startAfterAuth.current ? "start" : null); startAfterAuth.current = false;
          await refresh();
        }
      } catch (e) { setMessage((e as Error).message); }
    }, 2500);
    return () => clearInterval(timer);
  }, [pair, dialog, refresh]);
  function navigate(next: Page) {
    setPage(next);
    setDrawer(false);
    if (window.location.hash !== "#" + next) window.location.hash = next;
    window.scrollTo(0, 0);
    requestAnimationFrame(() => document.getElementById("page-title")?.focus({ preventScroll: true }));
  }
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("polytrader-theme", next);
    setTheme(next);
  }
  function openStart(strategy: Strategy = "btc15", wallet = seedWallet) { setSelected(strategy); setTestWallet(wallet); setMessage(""); startAfterAuth.current = !data?.user; setDialog(data?.user ? "start" : "auth"); }
  async function mutate(action: () => Promise<unknown>, success?: string) {
    setBusy(true); setMessage("");
    try { await action(); if (success) setMessage(success); await refresh(); }
    catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  const runs = data?.runs ?? [];
  const trades = data?.trades ?? [];
  const active = runs.filter(r => status(r) === "Активен").length;
  const settled = runs.reduce((s, r) => s + r.settled, 0);
  const wins = runs.reduce((s, r) => s + r.wins, 0);
  const capital = runs.reduce((s, r) => s + r.bank, 0);
  const pnl = runs.reduce((s, r) => s + r.pnl, 0);
  const headline = navigation.find(n => n.id === page)!;
  const openAuth = () => {
    setMessage("");
    startAfterAuth.current = false;
    setDialog("auth");
  };
  return <div className="workspace">
    <a className="skip-link" href="#main">К содержимому</a>
    <aside className="sidebar">
      <a className="brand-link" href="#dashboard" onClick={e => { e.preventDefault(); navigate("dashboard"); }}><Brand /></a>
      <RouteLinks page={page} navigate={navigate} />
      <div className="sidebar-bottom"><span className="status-dot" aria-hidden="true" />Режим симуляции</div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <span className="desktop-mode">Виртуальная торговля <span>на Polymarket</span></span>
        <a className="brand-link mobile-brand" href="#dashboard" onClick={e => { e.preventDefault(); navigate("dashboard"); }}><Brand /></a>
        <div className="toolbar">
          <span className="network"><i className={offline ? "offline" : data ? "online" : ""} aria-hidden="true" />
            {offline ? "Нет связи" : data ? "Данные Polymarket" : "Подключение"}
          </span>
          <Button variant="ghost" size="icon" aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"} onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={19} aria-hidden="true" /> : <Moon size={19} aria-hidden="true" />}
          </Button>
          {data?.user ? <button className="avatar" aria-label="Настройки аккаунта" onClick={() => navigate("settings")}>
            {data.user.name.slice(0, 2).toUpperCase()}
          </button> : <Button size="small" variant="outline" onClick={openAuth}>Войти</Button>}
        </div>
      </header>
      <main id="main" className="content" tabIndex={-1}>
        <div className="page-head">
          <h1 id="page-title" tabIndex={-1}>{headline.title}</h1>
          {(page === "dashboard" || page === "strategies") && <Button onClick={() => openStart()}>
            <Plus size={17} aria-hidden="true" /> Новый тест
          </Button>}
        </div>
        {offline && <div className="notice" role="status"><Activity size={17} aria-hidden="true" /> Данные временно недоступны. <button onClick={refresh}>Повторить</button></div>}
        {message && !dialog && <div className="notice" role="status">{message}<Button size="icon" variant="ghost" aria-label="Закрыть сообщение" onClick={() => setMessage("")}><X size={15} aria-hidden="true" /></Button></div>}
        {page === "dashboard" && <>
          <section className="portfolio-summary" aria-labelledby="portfolio-summary-title">
            <div className="summary-heading">
              <h2 id="portfolio-summary-title">Виртуальный портфель</h2>
              {runs.length > 0 && <a href="#portfolio" onClick={e => { e.preventDefault(); navigate("portfolio"); }}>
                Открыть портфель <ArrowRight size={15} aria-hidden="true" />
              </a>}
            </div>
            {runs.length ? <dl className="summary-metrics">
              <div><dt>Стартовый капитал</dt><dd>{dollars(capital)}</dd></div>
              <div><dt>Рассчитанный PnL</dt><dd><span className={pnl < 0 ? "summary-negative" : undefined}>{settled ? dollars(pnl) : "—"}</span>
                {settled > 0 && <small>ROI {percent(pnl / capital)}</small>}</dd></div>
              <div><dt>Доля прибыльных</dt><dd>{settled ? percent(wins / settled) : "—"}{settled > 0 && <small>{wins} из {settled}</small>}</dd></div>
              <div><dt>Активные тесты</dt><dd>{active}</dd></div>
            </dl> : <p>{loading ? "Загружаю портфель…" : data?.user ? "Создайте тест, чтобы начать виртуальную торговлю." : "Войдите через Telegram, чтобы запустить свой первый тест."}</p>}
            {runs.some(r => strategies[r.strategy].collector && status(r) === "Активен") && !collectorOnline(data) &&
              <a className="summary-status" href="#settings" onClick={e => { e.preventDefault(); navigate("settings"); }}>
                Сборщик котировок выключен <ArrowRight size={14} aria-hidden="true" />
              </a>}
          </section>
          <div className="overview-grid">
            <Panel className="overview-markets"><div className="panel-head"><div><h2>Рынки BTC</h2><p>Котировки Polymarket · время по Киеву</p></div>
              <a className="section-link" href="#markets" onClick={e => { e.preventDefault(); navigate("markets"); }}>
                Все рынки <ArrowRight size={15} aria-hidden="true" />
              </a></div>
              <MarketTable markets={(data?.markets ?? []).filter(m => m.interval_minutes != null).slice(0,4)} loading={loading} />
            </Panel>
            <Panel><div className="panel-head"><h2>Покрытие данных</h2></div>
              <MarketHealth data={data} unavailable={offline} />
              <a className="panel-link" href="#settings" onClick={e => { e.preventDefault(); navigate("settings"); }}>
                Настройки источников <ArrowRight size={15} aria-hidden="true" />
              </a>
            </Panel>
          </div>
          {runs.length > 0 && <Equity data={data} start={() => openStart()} />}
          {data?.user && <Panel><div className="panel-head"><h2>Последние сигналы</h2>
            <a className="section-link" href="#history" onClick={e => { e.preventDefault(); navigate("history"); }}>
              Весь журнал <ArrowRight size={15} aria-hidden="true" />
            </a></div><Trades rows={trades.slice(0, 5)} /></Panel>}
        </>}
        {page === "strategies" && <>
          <Panel><div className="panel-head"><h2>Ваши тесты</h2></div>
            <RunTable runs={runs} collectorActive={collectorOnline(data)} onPause={r => void mutate(() => api("experiments/pause", { id: r.id, paused: !r.paused }), r.paused ? "Тест возобновлён" : "Тест на паузе")} />
          </Panel>
          <Panel><div className="panel-head"><div><h2>Каталог стратегий</h2><p>Правила фиксируются при запуске теста.</p></div></div>
            <ul className="strategy-list">{strategyIds.map(id => (
              <li key={id}><div><h3>{strategies[id].name}</h3><p>{strategies[id].description}</p>
                <small>v{strategies[id].version}{strategies[id].collector ? " · Нужен сборщик котировок" : ""}</small>
              </div><Button variant="outline" size="small" onClick={() => openStart(id)} aria-label={`Тестировать: ${strategies[id].name}`}>
                Тестировать <ArrowRight size={14} aria-hidden="true" />
              </Button></li>
            ))}</ul>
          </Panel>
        </>}
        {page === "markets" && <Panel><div className="panel-head"><div><h2>Каталог раундов BTC</h2><p>Котировки Polymarket · время по Киеву</p></div>
          <select aria-label="Длительность раунда" value={marketFilter} onChange={e => setMarketFilter(e.target.value)}>
            <option value="all">Все раунды</option><option value="5">5 минут</option><option value="15">15 минут</option>
          </select></div>
          <MarketTable markets={(data?.markets ?? []).filter(m => marketFilter === "all" || String(m.interval_minutes) === marketFilter)}
            loading={loading} filtered={marketFilter !== "all"} />
        </Panel>}
        {page === "copy" && <><Panel><div className="panel-head"><div><h2>Кандидаты для наблюдения</h2><p>Рейтинг Polymarket за неделю · история загружается постранично</p></div>
          <input aria-label="Поиск кошелька" placeholder="Имя или 0x…" name="wallet-search" autoComplete="off" spellCheck={false} value={walletSearch} onChange={e => setWalletSearch(e.target.value)} /></div>
          {data?.wallets.some(w => (w.name + w.address).toLowerCase().includes(walletSearch.toLowerCase())) ? <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Кошелёк</th><th scope="col" role="columnheader">Источник</th><th scope="col" role="columnheader">Публичный PnL</th><th scope="col" role="columnheader">История</th></tr></thead><tbody role="rowgroup">
            {data.wallets.filter(w => (w.name + w.address).toLowerCase().includes(walletSearch.toLowerCase())).map(w => <tr role="row" key={w.address}><td role="cell"><a href={`https://polymarket.com/profile/${w.address}`} target="_blank" rel="noreferrer"><strong>{w.name}</strong> <ArrowUpRight size={13} aria-hidden="true" /></a><small className="number">{compactWallet(w.address)}</small></td>
              <td role="cell" data-label="Источник"><span className="tag muted">{w.source === "research" ? "Исследование" : w.source}</span></td><td role="cell" data-label="Публичный PnL" className="number">{dollars(w.public_pnl)}</td><td role="cell" data-label="История">{count(w.records)} записей<small>{w.history_complete ? "Архив выгружен" : "Архив неполный"}</small><small>Покупки: {count(w.buys)}, продажи: {count(w.sells)}, погашения: {count(w.redeems)}</small></td></tr>)}
          </tbody></table></div> : <Empty title="Кошельки не найдены" text="Измените поиск или дождитесь обновления рейтинга." />}</Panel>
          {data?.wallets.some(w => w.source === "crypto" && (w.public_pnl ?? 0) > 0 && w.buys >= 100) && <Panel>
            <div className="panel-head"><div><h2>Гипотезы для проверки</h2><p>Кандидаты с положительным недельным PnL и минимум 100 покупками в архиве</p></div></div>
            <div className="setting-rows">{data.wallets.filter(w => w.source === "crypto" && (w.public_pnl ?? 0) > 0 && w.buys >= 100).slice(0,5).map(w => <div key={w.address}><span><strong>Проверить копирование {w.name}</strong><small>{count(w.buys)} покупок · {compactWallet(w.address)}</small></span>
              <Button variant="outline" size="small" onClick={() => openStart("copy", w.address)}>Настроить тест <ArrowRight size={14} aria-hidden="true" /></Button></div>)}</div>
          </Panel>}</>}
        {page === "combos" && <Panel><div className="panel-head"><div><h2>Крупные комбо</h2><p>Стоимость входа в позицию · повторы проверяются после обнаружения</p></div>
          <select aria-label="Сортировка комбо" value={comboSort} onChange={e => setComboSort(e.target.value)}><option value="time">По обнаружению</option><option value="stake">По размеру</option><option value="author">По PnL автора</option></select></div>
          {data?.combos.length ? <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Комбо</th><th scope="col" role="columnheader">Автор</th><th scope="col" role="columnheader">Стоимость</th><th scope="col" role="columnheader">Обнаружено · Киев</th></tr></thead><tbody role="rowgroup">
            {[...data.combos].sort((a, b) => comboSort === "stake" ? b.stake - a.stake : comboSort === "author" ? (b.author_pnl ?? -Infinity) - (a.author_pnl ?? -Infinity) : +new Date(b.detected_at) - +new Date(a.detected_at)).map(c => <tr role="row" key={c.id}><td role="cell"><strong>{c.payload.legs.map(l => l.market.title + " · " + l.leg_outcome_label).join(" / ")}</strong><small>{c.payload.status}</small></td><td role="cell" data-label="Автор"><a href={`https://polymarket.com/profile/${c.wallet}`} target="_blank" rel="noreferrer">{c.name ?? compactWallet(c.wallet)} <ArrowUpRight size={13} aria-hidden="true" /></a><small>{dollars(c.author_pnl)}</small></td><td role="cell" data-label="Стоимость" className="number">{dollars(c.stake)}</td><td role="cell" data-label="Обнаружено · Киев" className="number">{when(c.detected_at)}</td></tr>)}
          </tbody></table></div> : <Empty title="Комбо ещё не обнаружены" text="Мониторинг проверяет публичные позиции авторов из рейтинга комбо." />}</Panel>}
        {page === "portfolio" && <><Equity data={data} start={() => openStart()} /><Panel><div className="panel-head"><div><h2>Виртуальные банки</h2><p>Свободные средства и последняя оценка капитала</p></div></div>
          {runs.length ? <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Тест</th><th scope="col" role="columnheader">Свободно</th><th scope="col" role="columnheader">Капитал</th><th scope="col" role="columnheader">Завершение · Киев</th><th scope="col" role="columnheader">Статус</th></tr></thead><tbody role="rowgroup">{runs.map(r => <tr role="row" key={r.id}><td role="cell"><strong>{strategies[r.strategy].name}</strong><small>{shortMode(r.mode)} · v{r.version}</small></td><td role="cell" data-label="Свободно" className="number">{dollars(r.cash)}</td><td role="cell" data-label="Капитал" className="number">{dollars(r.equity)}</td><td role="cell" data-label="Завершение · Киев" className="number">{when(r.ends_at)}</td><td role="cell" data-label="Статус"><span className="tag muted">{status(r)}</span></td></tr>)}</tbody></table></div> : <Empty title="Портфель пуст" text="Запустите тест, чтобы создать виртуальный банк." />}</Panel></>}
        {page === "history" && <HistoryPanel enabled={!!data?.user} />}
        {page === "analytics" && <><Panel><div className="panel-head"><div><h2>Рейтинг за 7 дней</h2><p>По реализованному ROI · 95% интервал Уилсона для доли прибыльных сделок</p></div></div>
          <RunTable runs={runs.filter(r => r.weekly_settled).sort((a, b) => b.weekly_pnl / b.bank - a.weekly_pnl / a.bank || a.drawdown - b.drawdown || b.weekly_settled - a.weekly_settled)} ranking /></Panel>
          <Panel><div className="panel-head"><div><h2>Сравнение тестов</h2><p>За весь период тестирования</p></div></div><RunTable runs={runs} /></Panel>
          <Panel><div className="panel-head"><div><h2>Точность сигналов BTC</h2><p>95-й перцентиль абсолютного отклонения от T−30 и T−60</p></div></div>
            {runs.some(r => r.strategy === "btc5" || r.strategy === "btc15") ? <div className="table-wrap"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Тест</th><th scope="col" role="columnheader">Отклонение P95</th><th scope="col" role="columnheader">Пропущено окон</th></tr></thead><tbody role="rowgroup">{runs.filter(r => r.strategy === "btc5" || r.strategy === "btc15").map(r => <tr role="row" key={r.id}><td role="cell">{strategies[r.strategy].name} · {shortMode(r.mode)}</td><td role="cell" data-label="Отклонение P95" className="number">{r.timing_p95 == null ? "—" : Math.round(r.timing_p95) + " мс"}</td><td role="cell" data-label="Пропущено окон" className="number">{r.timing_missing}</td></tr>)}</tbody></table></div> : <Empty title="Нет измерений времени" text="Запустите BTC-тест и подключите WebSocket-сборщик." />}</Panel></>}
        {page === "settings" && <div className="overview-grid">
          <Panel><div className="panel-head"><div><h2>Профиль и уведомления</h2><p>{data?.user ? data.user.name : "Войдите через Telegram"}</p></div></div>
            <div className="setting-rows"><div><span><strong>Тема интерфейса</strong><small>{theme === "dark" ? "Тёмная" : "Светлая"}</small></span><Button size="small" variant="outline" onClick={toggleTheme}>{theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />} Сменить</Button></div>
            <div><span><strong>Telegram-бот</strong><small>{data?.user?.linked ? "Чат подключён" : "Отправьте /start для уведомлений"}</small></span>{botUrl(data?.bot) && <a className="button button-outline button-small" href={botUrl(data?.bot)!} target="_blank" rel="noreferrer"><Send size={14} aria-hidden="true" /> Открыть</a>}</div>
            {data?.user && <div><label htmlFor="alerts"><strong>Уведомления и дневной отчёт</strong><small>Сигналы, исполнения и крупные комбо</small></label><input id="alerts" type="checkbox" name="alerts" checked={data.user.alerts} onChange={e => void mutate(() => api("settings", { alerts: e.target.checked }), "Настройки сохранены")} /></div>}
            {data?.user && <Button variant="ghost" onClick={() => void mutate(() => api("auth/logout", {}), "Вы вышли из аккаунта")}>Выйти из аккаунта</Button>}</div></Panel>
          <Panel><div className="panel-head"><div><h2>Мониторинг</h2><p>Здоровье источников и сборщика</p></div><Button aria-label="Обновить состояние" variant="ghost" size="icon" onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></Button></div>
            <MarketHealth data={data} unavailable={offline} />
            <details className="collector-help"><summary>Как запустить сборщик бесплатно</summary>
              <p>WebSocket передаёт изменения стакана Polymarket в реальном времени. Подписка на публичный поток бесплатна. Оставьте сборщик запущенным на своём компьютере, пока идёт тест.</p>
              <a href="https://github.com/dimaqim/polytrader-lab/blob/main/docs/operations.md#websocket-сборщик" target="_blank" rel="noreferrer">Инструкция запуска <ArrowUpRight size={14} aria-hidden="true" /></a>
            </details><div className="setting-rows">{data?.errors.length ? data.errors.map(e => <div key={e.area}><span><strong>{e.area}</strong><small>{when(e.at)}</small></span><span className="tag amber">{e.count} / 24 ч</span></div>) : <p>Ошибок за 24 часа {data ? "в журнале нет." : "—"}</p>}</div></Panel>
        </div>}
        <footer className="footer">{data ? <span>Данные обновлены в <time dateTime={data.asOf}>{clock(data.asOf)}</time> · Киев</span> : "Данные Polymarket"}</footer>
      </main>
      <nav className="mobile-nav" aria-label="Основные разделы">
        {navigation.slice(0, 3).map(n => <a key={n.id} href={"#" + n.id} onClick={e => { e.preventDefault(); navigate(n.id); }}
          aria-current={page === n.id ? "page" : undefined}><n.icon size={19} aria-hidden="true" />{n.title}</a>)}
        <button type="button" aria-label="Открыть меню" aria-expanded={drawer} aria-haspopup="dialog" onClick={() => setDrawer(true)}>
          <Menu size={19} aria-hidden="true" />Ещё
        </button>
      </nav>
    </div>
    {drawer && <Modal title="Разделы" onClose={() => setDrawer(false)}><RouteLinks page={page} navigate={navigate} /></Modal>}
    {dialog && <Modal title={dialog === "auth" ? "Войти через Telegram" : "Новый тест"} onClose={() => { setDialog(null); setPair(null); setMessage(""); }}>
      {message && <p className="notice" role="status">{message}</p>}
      {dialog === "auth" ? <div className="auth-content"><p>Подтвердите вход в боте, чтобы открыть свои тесты в браузере.</p>
        {pair ? <><a className="button button-primary" href={pair.url} target="_blank" rel="noreferrer"><Send size={17} aria-hidden="true" /> Подтвердить в Telegram <ArrowUpRight size={16} aria-hidden="true" /></a><p>Откройте чат, нажмите Start и вернитесь сюда. Код действует 10 минут.</p></>
          : <Button disabled={busy} onClick={() => void mutate(async () => setPair(await api<Pair>("auth/pair", {})))}><Send size={17} aria-hidden="true" /> {busy ? "Подключение…" : "Продолжить в Telegram"}</Button>}
      </div> : <StartForm strategy={selected} wallet={testWallet} wallets={data?.wallets ?? []} busy={busy} onSubmit={body => void mutate(async () => {
        await api("experiments", body); setDialog(null); navigate("strategies");
      }, "Тест запущен")} />}
    </Modal>}
  </div>;
}
