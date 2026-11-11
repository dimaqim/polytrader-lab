"use client";

import { useEffect, useState, useRef, useCallback, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Bitcoin, BookOpen, ChartNoAxesCombined, ChevronDown,
  CircleHelp, Clock3, FlaskConical, History, LayoutDashboard, Layers3, ListFilter, Menu, Moon, Plus, Radio, RefreshCw,
  ScanLine, Send, Settings, ShieldCheck, Sun, Target, Users, Wallet, X, Zap,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "./ui/button";
import { seedWallet, strategies, strategyIds, type Strategy } from "../lib/strategies";
import type { Run, Trade, WorkspaceData } from "../lib/workspace";

const navigation = [
  { id: "dashboard", title: "Обзор", english: "Dashboard", icon: LayoutDashboard },
  { id: "strategies", title: "Стратегии", english: "Strategies", icon: FlaskConical },
  { id: "markets", title: "Рынки", english: "Markets", icon: Radio },
  { id: "copy", title: "Кошельки", english: "Copy Traders", icon: Users },
  { id: "combos", title: "Комбо", english: "Combo Tracker", icon: Layers3 },
  { id: "portfolio", title: "Портфель", english: "Paper Portfolio", icon: Wallet },
  { id: "history", title: "Журнал", english: "Trade History", icon: History },
  { id: "analytics", title: "Аналитика", english: "Analytics", icon: BarChart3 },
  { id: "settings", title: "Настройки", english: "Settings", icon: Settings },
] as const;
type Page = typeof navigation[number]["id"];
type TelegramApp = { initData: string; ready: () => void; expand: () => void; colorScheme?: string };
type Pair = { code: string; secret: string; url: string };
const icons = { btc15: Bitcoin, btc5: Zap, copy: Users, combo: Layers3, maker: ScanLine };
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
  exposure_or_cash: "Лимит позиции или недостаточно средств", drawdown: "Лимит просадки", user_skipped: "Пропущено пользователем",
  below_threshold: "Цена ниже порога или нет фаворита", quote_api_error: "API котировок недоступен", missing_market: "Рынок недоступен",
  maker_no_trade_through: "Нет подтверждённого прохода цены", maker_continuity_gap: "Разрыв в потоке стакана",
};
const statuses: Record<string, string> = {
  filled: "Исполнено", partial: "Частично", unfilled: "Не исполнено", pending: "Ожидает", processing: "Проверяется",
  queued: "В очереди", skipped: "Пропущено", research: "Наблюдение",
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
  return <div className="brand"><span className="brand-icon"><ChartNoAxesCombined size={23} strokeWidth={2.5} /></span>
    <span>PolyTrader <em>Lab</em><small>POLYMARKET RESEARCH</small></span></div>;
}
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={"panel " + className}>{children}</section>;
}
function Empty({ icon: Icon = Activity, title, text, action }: { icon?: typeof Activity; title: string; text: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon size={23} strokeWidth={1.6} /></span><strong>{title}</strong><p>{text}</p>{action}</div>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-body"><div className="modal-heading"><h2 id="modal-title">{title}</h2>
      <Button size="icon" variant="ghost" aria-label="Закрыть" onClick={onClose}><X size={19} /></Button></div>{children}</div>
  </dialog>;
}
function MarketHealth({ data, unavailable }: { data: WorkspaceData | null; unavailable: boolean }) {
  const heartbeat = data?.health.find(h => h.source === "neon");
  const monitor = heartbeat && Date.now() - +new Date(heartbeat.at) < 180_000;
  const collector = data?.health.find(h => h.source === "collector");
  const collectorLive = collector?.details.connected && Date.now() - +new Date(collector.at) < 30_000;
  return <div className="health-list">
    <div><span className="health-icon"><Radio size={16} /></span><span><strong>Мониторинг Neon</strong><small>{heartbeat ? "Последний запуск " + clock(heartbeat.at) : "Ожидание первого запуска"}</small></span><span className={"tag " + (monitor && heartbeat.details.sections?.every(Boolean) ? "good" : "muted")}>{unavailable ? "Нет связи" : monitor ? heartbeat.details.sections?.every(Boolean) ? "Активен" : "Есть ошибки" : "Ожидание"}</span></div>
    <div><span className="health-icon"><Zap size={16} /></span><span><strong>BTC WebSocket</strong><small>{collectorLive ? "Получение L2-стакана" : "Окна T−30 / T−60 не подтверждены"}</small></span><span className={"tag " + (collectorLive ? "good" : "amber")}>{collectorLive ? "Подключён" : "Нужен сборщик"}</span></div>
    <div><span className="health-icon"><ShieldCheck size={16} /></span><span><strong>Режим исполнения</strong><small>Независимые виртуальные банки</small></span><span className="tag violet">Paper</span></div>
  </div>;
}
function Trades({ rows }: { rows: Trade[] }) {
  if (!rows.length) return <Empty icon={History} title="Журнал пока пуст" text="Здесь появятся сигналы, исполнения и причины пропусков." />;
  return <div className="table-wrap"><table><thead><tr><th>Сигнал / рынок</th><th>Режим</th><th>Статус</th><th>Цена</th><th>PnL</th><th>Время · Киев</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td><strong>{row.label}</strong><small>{strategies[row.strategy].name}{row.reason ? " · " + (reasons[row.reason] ?? row.reason) : ""}</small></td>
      <td>{shortMode(row.mode)}</td><td><span className={"tag " + (row.status === "filled" || row.status === "partial" ? "good" : row.status === "pending" ? "amber" : "muted")}>{statuses[row.status] ?? row.status}</span></td>
      <td className="number">{price(row.price)}</td><td className={"number " + (row.pnl != null && row.pnl >= 0 ? "positive" : row.pnl != null ? "negative" : "")}>{dollars(row.pnl)}</td>
      <td className="number nowrap">{when(row.observed_at)}</td></tr>)}</tbody></table></div>;
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
    <div className="segments" aria-label="Период графика">{[7, 14, 21].map(n => <button key={n} className={range === n ? "selected" : ""} onClick={() => setRange(n)} aria-pressed={range === n}>{n} д</button>)}</div></div>
    {runs.length > 0 && <select className="chart-select" value={selected?.id} onChange={e => setChosen(e.target.value)} aria-label="Тест для графика">
      {runs.map(r => <option value={r.id} key={r.id}>{strategies[r.strategy].name} · {shortMode(r.mode)} · {when(r.starts_at)}</option>)}
    </select>}
    <div className="chart-area">
      {points.some(p => p.value != null) ? <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <AreaChart data={points} margin={{ top: 20, left: 4, right: 14, bottom: 5 }}>
          <defs><linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#a799ff" stopOpacity={0.34} /><stop offset="100%" stopColor="#a799ff" stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid stroke="var(--line)" vertical={false} /><YAxis tickFormatter={n => "$" + n} domain={["auto", "auto"]} width={62} tickLine={false} axisLine={false} tick={{ fill: "var(--secondary)", fontSize: 11 }} />
          <XAxis dataKey="time" minTickGap={75} tickFormatter={s => s.split(",")[0]} tickLine={false} axisLine={false} tick={{ fill: "var(--secondary)", fontSize: 11 }} />
          <Tooltip formatter={value => [dollars(Number(value)), "Капитал"]} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10 }} />
          <Area type="linear" dataKey="value" stroke="var(--accent-text)" strokeWidth={2} fill="url(#equity-fill)" connectNulls={false} dot={points.length < 3} />
        </AreaChart>
      </ResponsiveContainer> : <div className="chart-grid"><Empty icon={ChartNoAxesCombined}
        title={selected ? "Нет подтверждённых оценок" : "Нет данных по капиталу"}
        text={selected ? "Выберите другой период или дождитесь оценки позиций." : "Кривая появится после запуска первого теста."}
        action={selected ? undefined : <Button size="small" variant="outline" onClick={start}>Создать тест <ArrowRight size={14} /></Button>} /></div>}
    </div></Panel>;
}
function RunTable({ runs, onPause, ranking }: { runs: Run[]; onPause?: (run: Run) => void; ranking?: boolean }) {
  if (!runs.length) return <Empty icon={FlaskConical} title={ranking ? "Нет рассчитанных сделок за неделю" : "Нет запущенных тестов"} text={ranking ? "Рейтинг появится после расчёта первых позиций." : "Запустите стратегию, чтобы сформировать независимый виртуальный банк."} />;
  return <div className="table-wrap"><table><thead><tr><th>Стратегия</th><th>{ranking ? "PnL · 7 д" : "Рассчитанный PnL"}</th><th>ROI{ranking ? " · 7 д" : ""}</th><th>Win rate / 95% ДИ</th><th>Макс. просадка</th><th>{ranking ? "Сделки · 7 д" : "Сделки / пропуски"}</th><th>{onPause ? "Статус" : "Комиссии"}</th></tr></thead>
    <tbody>{runs.map(run => {
      const ci = ranking ? run.weeklyInterval95 : run.interval95;
      const rate = ranking ? (run.weekly_settled ? run.weekly_wins / run.weekly_settled : null) : run.winRate;
      return <tr key={run.id}><td><strong>{strategies[run.strategy].name}</strong><small>v{run.version} · {shortMode(run.mode)} · {dollars(run.bank)}</small></td>
        <td className="number">{dollars(ranking ? run.weekly_pnl : run.pnl)}</td><td className="number">{percent(ranking ? run.weekly_pnl / run.bank : run.roi)}</td>
        <td className="number">{percent(rate)}<small>{ci ? percent(ci[0]) + " – " + percent(ci[1]) : "—"}</small></td>
        <td className="number">{percent(run.drawdown)}</td><td className="number">{ranking ? run.weekly_settled : `${run.fills} / ${run.missed}`}</td>
        <td>{onPause ? <><span className={"tag " + (status(run) === "Активен" ? "good" : "muted")}>{status(run)}</span>
          {!run.risk_blocked && +new Date(run.ends_at) > Date.now() && <Button variant="ghost" size="small" onClick={() => onPause(run)}>{run.paused ? "Возобновить" : "Пауза"}</Button>}</> : <>{dollars(run.fees)}<small>Проск. {run.slippage == null ? "—" : run.slippage.toFixed(1) + " б.п."}</small></>}</td></tr>;
    })}</tbody></table></div>;
}

function StartForm({ strategy, wallets, onSubmit, busy }: { strategy: Strategy; wallets: WorkspaceData["wallets"]; onSubmit: (body: object) => void; busy: boolean }) {
  const [selected, setSelected] = useState(strategy);
  const [days, setDays] = useState("7");
  const [custom, setCustom] = useState(false);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    onSubmit({ strategy: selected, mode: f.get("mode"), wallet: f.get("wallet"), bank: Number(f.get("bank")),
      stake: Number(f.get("stake")), days: Number(days), drawdown: Number(f.get("drawdown")), exposure: Number(f.get("exposure")), slippage: Number(f.get("slippage")) });
  }
  return <form className="run-form" onSubmit={submit}>
    <label>Стратегия<select value={selected} onChange={e => setSelected(e.target.value as Strategy)}>{strategyIds.map(id => <option value={id} key={id}>{strategies[id].name} · v{strategies[id].version}</option>)}</select></label>
    <p>{strategies[selected].description}. Параметры сохраняются на весь тест.</p>
    {selected === "copy" && <label>Публичный кошелёк<input name="wallet" list="wallets" defaultValue={seedWallet} required pattern="0x[0-9a-fA-F]{40}" />
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
    {custom && <label>Дни<input aria-label="Своя продолжительность в днях" type="number" min=".05" max="365" step="any" value={days} onChange={e => setDays(e.target.value)} required /></label>}
    {strategies[selected].collector && <p className="notice"><Zap size={15} /> Для точных наблюдений нужен запущенный WebSocket-сборщик.</p>}
    <Button type="submit" disabled={busy}>{busy ? "Запускаю…" : "Запустить тест"}<ArrowRight size={16} /></Button>
  </form>;
}

export function Workspace() {
  const [page, setPage] = useState<Page>("dashboard");
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"start" | "auth" | null>(null);
  const [selected, setSelected] = useState<Strategy>("btc15");
  const [pair, setPair] = useState<Pair | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");
  const [walletSearch, setWalletSearch] = useState("");
  const [comboSort, setComboSort] = useState("time");
  const initial = useRef(false);
  const refresh = useCallback(async () => {
    try { setData(await api<WorkspaceData>("workspace")); setOffline(false); }
    catch { setOffline(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const tg = (window as unknown as { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
    const preferred = localStorage.getItem("polytrader-theme") ?? (tg?.initData ? tg.colorScheme : null) ?? "dark";
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
        if (result.ok) { setPair(null); setDialog(null); setMessage("Вход выполнен"); await refresh(); }
      } catch (e) { setMessage((e as Error).message); }
    }, 2500);
    return () => clearInterval(timer);
  }, [pair, dialog, refresh]);
  function navigate(next: Page) { setPage(next); setDrawer(false); window.location.hash = next; window.scrollTo(0, 0); }
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("polytrader-theme", next);
    setTheme(next);
  }
  function openStart(strategy: Strategy = "btc15") { setSelected(strategy); setMessage(""); setDialog(data?.user ? "start" : "auth"); }
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
  const descriptions: Record<Page, string> = {
    dashboard: "Следите за тестами стратегий, рынками и качеством исполнения.",
    strategies: "Запускайте независимые тесты с заранее зафиксированными правилами.",
    markets: "Текущие раунды BTC и котировки из каталога Polymarket.",
    copy: "Публичные кошельки для исследования и виртуального копирования.",
    combos: "Позиции от $2 000 среди наблюдаемых авторов Polymarket.",
    portfolio: "Баланс, риск и состояние каждого виртуального банка.",
    history: "Исполнения, частичные сделки и причины пропущенных сигналов.",
    analytics: "Доходность, просадка и статистическая надёжность тестов.",
    settings: "Подключение Telegram, тема и состояние источников данных.",
  };
  return <div className="workspace">
    {drawer && <button className="scrim" aria-label="Закрыть меню" onClick={() => setDrawer(false)} />}
    <aside className={"sidebar " + (drawer ? "sidebar-open" : "")}>
      <button className="brand-button" onClick={() => navigate("dashboard")} aria-label="PolyTrader Lab, обзор"><Brand /></button>
      <nav aria-label="Разделы">
        <div className="nav-group"><span>ЛАБОРАТОРИЯ</span>{navigation.slice(0, 5).map(n => <a key={n.id} href={"#" + n.id} onClick={e => { e.preventDefault(); navigate(n.id); }} aria-current={page === n.id ? "page" : undefined}><n.icon size={18} />{n.title}</a>)}</div>
        <div className="nav-group"><span>РЕЗУЛЬТАТЫ</span>{navigation.slice(5).map(n => <a key={n.id} href={"#" + n.id} onClick={e => { e.preventDefault(); navigate(n.id); }} aria-current={page === n.id ? "page" : undefined}><n.icon size={18} />{n.title}</a>)}</div>
      </nav>
      <div className="sidebar-bottom"><span className="paper-icon"><FlaskConical size={17} /></span><div><strong>Paper Trading</strong><small>Виртуальное исполнение</small></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="breadcrumbs"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="Открыть меню" onClick={() => setDrawer(true)}><Menu size={21} /></Button>
          <span>Лаборатория</span><span className="slash">/</span><strong>{headline.english}</strong></div>
        <div className="toolbar"><span className="network"><i className={offline ? "offline" : data ? "online" : ""} />{offline ? "Нет связи" : data ? "Данные Polymarket" : "Подключение"}</span>
          <Button variant="ghost" size="icon" aria-label="Сменить тему" onClick={toggleTheme}>{theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}</Button>
          {data?.user ? <button className="avatar" aria-label="Настройки аккаунта" onClick={() => navigate("settings")}>{data.user.name.slice(0, 2).toUpperCase()}</button>
            : <Button size="small" variant="outline" onClick={() => { setMessage(""); setDialog("auth"); }}><Send size={14} /> Войти</Button>}
        </div>
      </header>
      <main id="main" className="content">
        <div className="page-head"><div><div className="eyebrow"><span /> POLYMARKET · PAPER TRADING</div><h1>{headline.title}</h1><p>{descriptions[page]}</p></div>
          <Button onClick={() => openStart()}><Plus size={18} /> Новый тест</Button></div>
        {offline && <div className="notice" role="status"><Activity size={17} /> Данные временно недоступны. <button onClick={refresh}>Повторить</button></div>}
        {message && !dialog && <div className="notice" role="status">{message}<Button size="icon" variant="ghost" aria-label="Закрыть сообщение" onClick={() => setMessage("")}><X size={15} /></Button></div>}
        {page === "dashboard" && <>
          <div className="metrics">
            {[
              { label: "Виртуальный банк", value: runs.length ? dollars(capital) : "—", hint: "Сумма стартовых банков", icon: Wallet },
              { label: "Рассчитанный PnL", value: settled ? dollars(pnl) : "—", hint: settled ? `ROI ${percent(pnl / capital)}` : "По закрытым позициям", icon: ChartNoAxesCombined },
              { label: "Win rate", value: settled ? percent(wins / settled) : "—", hint: settled ? `${wins} из ${settled} сделок` : "Ожидание расчётов", icon: Target },
              { label: "Активные тесты", value: data ? String(active).padStart(2, "0") : "—", hint: `Доступно ${strategyIds.length} стратегий`, icon: FlaskConical },
            ].map(m => <Panel className="metric" key={m.label}><div><span>{m.label}</span><m.icon size={17} /></div><strong>{m.value}</strong><small>{m.hint}</small></Panel>)}
          </div>
          <div className="overview-grid"><Equity data={data} start={() => openStart()} />
            <Panel><div className="panel-head"><div><h2>Источники данных</h2><p>Покрытие и исполнение</p></div><Radio size={19} className="accent" /></div>
              <MarketHealth data={data} unavailable={offline} /><button className="panel-link" onClick={() => navigate("settings")}>Состояние системы <ArrowUpRight size={15} /></button></Panel>
          </div>
          <Panel><div className="panel-head"><div><h2>Последние сигналы</h2><p>Решения ваших активных и завершённых тестов</p></div>
            <Button variant="outline" size="small" onClick={() => navigate("history")}>Весь журнал <ArrowRight size={14} /></Button></div>
            <Trades rows={trades.slice(0, 5)} /></Panel>
        </>}
        {page === "strategies" && <><div className="strategy-grid">{strategyIds.map(id => {
          const Icon = icons[id];
          return <Panel className="strategy-card" key={id}><div className="strategy-top"><span className="strategy-icon"><Icon size={22} /></span><span className="tag muted">v{strategies[id].version}</span></div>
            <h2>{strategies[id].name}</h2><p>{strategies[id].description}</p><div className="strategy-bottom"><span className={"tag " + (strategies[id].collector ? "amber" : "violet")}>{strategies[id].collector ? "WebSocket" : "API"}</span>
            <Button variant="outline" size="small" onClick={() => openStart(id)}>Тестировать <ArrowRight size={14} /></Button></div></Panel>;
        })}</div><Panel><div className="panel-head"><div><h2>Ваши тесты</h2><p>Режимы исполнения и версии стратегии</p></div></div>
          <RunTable runs={runs} onPause={r => void mutate(() => api("experiments/pause", { id: r.id, paused: !r.paused }), r.paused ? "Тест возобновлён" : "Тест на паузе")} /></Panel></>}
        {page === "markets" && <Panel><div className="panel-head"><div><h2>Каталог раундов BTC</h2><p>Цены каталога · свежий стакан проверяется отдельно при исполнении</p></div>
          <select aria-label="Длительность раунда" value={marketFilter} onChange={e => setMarketFilter(e.target.value)}><option value="all">Все раунды</option><option value="5">5 минут</option><option value="15">15 минут</option></select></div>
          {data?.markets.some(m => marketFilter === "all" || String(m.interval_minutes) === marketFilter) ? <div className="table-wrap"><table><thead><tr><th>Рынок</th><th>Исходы</th><th>Закрытие · Киев</th><th>Снимок</th></tr></thead><tbody>
            {data.markets.filter(m => marketFilter === "all" || String(m.interval_minutes) === marketFilter).map(m => <tr key={m.condition}><td><a href={`https://polymarket.com/event/${encodeURIComponent(m.slug)}`} target="_blank" rel="noreferrer">{m.title} <ArrowUpRight size={13} /></a></td>
              <td>{m.outcomes.map((o, i) => <span key={o} className="tag violet">{o} {price(m.prices[i])}</span>)}</td><td className="number">{when(m.ends_at)}</td><td className="number">{clock(m.seen_at)}</td></tr>)}
          </tbody></table></div> : <Empty icon={Radio} title={loading ? "Загрузка рынков" : "Нет свежих рынков"} text="Данные появятся после успешного обновления каталога." />}</Panel>}
        {page === "copy" && <Panel><div className="panel-head"><div><h2>Кандидаты для наблюдения</h2><p>Рейтинг Polymarket за неделю · история загружается постранично</p></div>
          <input aria-label="Поиск кошелька" placeholder="Имя или 0x…" value={walletSearch} onChange={e => setWalletSearch(e.target.value)} /></div>
          {data?.wallets.some(w => (w.name + w.address).toLowerCase().includes(walletSearch.toLowerCase())) ? <div className="table-wrap"><table><thead><tr><th>Кошелёк</th><th>Источник</th><th>Публичный PnL</th><th>История</th></tr></thead><tbody>
            {data.wallets.filter(w => (w.name + w.address).toLowerCase().includes(walletSearch.toLowerCase())).map(w => <tr key={w.address}><td><a href={`https://polymarket.com/profile/${w.address}`} target="_blank" rel="noreferrer"><strong>{w.name}</strong> <ArrowUpRight size={13} /></a><small className="number">{compactWallet(w.address)}</small></td>
              <td><span className="tag muted">{w.source === "research" ? "Исследование" : w.source}</span></td><td className="number">{dollars(w.public_pnl)}</td><td>{count(w.records)} записей<small>{w.history_complete ? "Архив выгружен" : "Архив неполный"}</small></td></tr>)}
          </tbody></table></div> : <Empty icon={Users} title="Кошельки не найдены" text="Измените поиск или дождитесь обновления рейтинга." />}</Panel>}
        {page === "combos" && <Panel><div className="panel-head"><div><h2>Крупные комбо</h2><p>Стоимость входа в позицию · повторы проверяются после обнаружения</p></div>
          <select aria-label="Сортировка комбо" value={comboSort} onChange={e => setComboSort(e.target.value)}><option value="time">По обнаружению</option><option value="stake">По размеру</option><option value="author">По PnL автора</option></select></div>
          {data?.combos.length ? <div className="table-wrap"><table><thead><tr><th>Комбо</th><th>Автор</th><th>Стоимость</th><th>Обнаружено · Киев</th></tr></thead><tbody>
            {[...data.combos].sort((a, b) => comboSort === "stake" ? b.stake - a.stake : comboSort === "author" ? (b.author_pnl ?? -Infinity) - (a.author_pnl ?? -Infinity) : +new Date(b.detected_at) - +new Date(a.detected_at)).map(c => <tr key={c.id}><td><strong>{c.payload.legs.map(l => l.market.title + " · " + l.leg_outcome_label).join(" / ")}</strong><small>{c.payload.status}</small></td><td><a href={`https://polymarket.com/profile/${c.wallet}`} target="_blank" rel="noreferrer">{c.name ?? compactWallet(c.wallet)} <ArrowUpRight size={13} /></a><small>{dollars(c.author_pnl)}</small></td><td className="number">{dollars(c.stake)}</td><td className="number">{when(c.detected_at)}</td></tr>)}
          </tbody></table></div> : <Empty icon={Layers3} title="Комбо ещё не обнаружены" text="Мониторинг проверяет публичные позиции авторов из рейтинга комбо." />}</Panel>}
        {page === "portfolio" && <><Equity data={data} start={() => openStart()} /><Panel><div className="panel-head"><div><h2>Виртуальные банки</h2><p>Свободные средства и последняя оценка капитала</p></div></div>
          {runs.length ? <div className="table-wrap"><table><thead><tr><th>Тест</th><th>Свободно</th><th>Капитал</th><th>Завершение · Киев</th><th>Статус</th></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td><strong>{strategies[r.strategy].name}</strong><small>{shortMode(r.mode)} · v{r.version}</small></td><td className="number">{dollars(r.cash)}</td><td className="number">{dollars(r.equity)}</td><td className="number">{when(r.ends_at)}</td><td><span className="tag muted">{status(r)}</span></td></tr>)}</tbody></table></div> : <Empty icon={Wallet} title="Портфель пуст" text="Запустите тест, чтобы создать виртуальный банк." />}</Panel></>}
        {page === "history" && <Panel><div className="panel-head"><div><h2>Решения по сигналам</h2><p>До 250 последних записей</p></div>
          <select aria-label="Фильтр статуса" value={historyFilter} onChange={e => setHistoryFilter(e.target.value)}><option value="all">Все статусы</option>{Object.entries(statuses).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></div>
          <Trades rows={trades.filter(t => historyFilter === "all" || t.status === historyFilter)} /></Panel>}
        {page === "analytics" && <><Panel><div className="panel-head"><div><h2>Рейтинг за 7 дней</h2><p>По реализованному ROI · 95% интервал Уилсона для доли прибыльных сделок</p></div></div>
          <RunTable runs={runs.filter(r => r.weekly_settled).sort((a, b) => b.weekly_pnl / b.bank - a.weekly_pnl / a.bank || a.drawdown - b.drawdown || b.weekly_settled - a.weekly_settled)} ranking /></Panel>
          <Panel><div className="panel-head"><div><h2>Сравнение тестов</h2><p>За весь период тестирования</p></div></div><RunTable runs={runs} /></Panel>
          <Panel><div className="panel-head"><div><h2>Точность сигналов BTC</h2><p>95-й перцентиль абсолютного отклонения от T−30 и T−60</p></div><Clock3 size={19} className="accent" /></div>
            {runs.some(r => r.strategy === "btc5" || r.strategy === "btc15") ? <div className="table-wrap"><table><thead><tr><th>Тест</th><th>Отклонение P95</th><th>Пропущено окон</th></tr></thead><tbody>{runs.filter(r => r.strategy === "btc5" || r.strategy === "btc15").map(r => <tr key={r.id}><td>{strategies[r.strategy].name} · {shortMode(r.mode)}</td><td className="number">{r.timing_p95 == null ? "—" : Math.round(r.timing_p95) + " мс"}</td><td className="number">{r.timing_missing}</td></tr>)}</tbody></table></div> : <Empty icon={Clock3} title="Нет измерений времени" text="Запустите BTC-тест и подключите WebSocket-сборщик." />}</Panel></>}
        {page === "settings" && <div className="overview-grid">
          <Panel><div className="panel-head"><div><h2>Профиль и уведомления</h2><p>{data?.user ? data.user.name : "Войдите через Telegram"}</p></div><Settings size={20} className="accent" /></div>
            <div className="setting-rows"><div><span><strong>Тема интерфейса</strong><small>{theme === "dark" ? "Тёмная" : "Светлая"}</small></span><Button size="small" variant="outline" onClick={toggleTheme}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />} Сменить</Button></div>
            <div><span><strong>Telegram-бот</strong><small>{data?.user?.linked ? "Чат подключён" : "Отправьте /start для уведомлений"}</small></span>{botUrl(data?.bot) && <a className="button button-outline button-small" href={botUrl(data?.bot)!} target="_blank" rel="noreferrer"><Send size={14} /> Открыть</a>}</div>
            {data?.user && <div><label htmlFor="alerts"><strong>Уведомления и дневной отчёт</strong><small>Сигналы, исполнения и крупные комбо</small></label><input id="alerts" type="checkbox" checked={data.user.alerts} onChange={e => void mutate(() => api("settings", { alerts: e.target.checked }), "Настройки сохранены")} /></div>}
            {data?.user && <Button variant="ghost" onClick={() => void mutate(() => api("auth/logout", {}), "Вы вышли из аккаунта")}>Выйти из аккаунта</Button>}</div></Panel>
          <Panel><div className="panel-head"><div><h2>Мониторинг</h2><p>Здоровье источников и сборщика</p></div><Button aria-label="Обновить состояние" variant="ghost" size="icon" onClick={refresh}><RefreshCw size={17} /></Button></div>
            <MarketHealth data={data} unavailable={offline} /><div className="setting-rows">{data?.errors.length ? data.errors.map(e => <div key={e.area}><span><strong>{e.area}</strong><small>{when(e.at)}</small></span><span className="tag amber">{e.count} / 24 ч</span></div>) : <p>Ошибок за 24 часа {data ? "в журнале нет." : "—"}</p>}</div></Panel>
        </div>}
        <footer className="footer"><span><FlaskConical size={14} /> PolyTrader Lab</span><span>{data ? "Обновлено " + clock(data.asOf) + " · Киев" : "Данные появляются после подключения"}</span></footer>
      </main>
    </div>
    {dialog && <Modal title={dialog === "auth" ? "Войти через Telegram" : "Новый тест"} onClose={() => { setDialog(null); setPair(null); setMessage(""); }}>
      {message && <p className="notice" role="status">{message}</p>}
      {dialog === "auth" ? <div className="auth-content"><p>Подтвердите вход в боте, чтобы открыть свои тесты в браузере.</p>
        {pair ? <><a className="button button-primary" href={pair.url} target="_blank" rel="noreferrer"><Send size={17} /> Подтвердить в Telegram <ArrowUpRight size={16} /></a><p>Откройте чат, нажмите Start и вернитесь сюда. Код действует 10 минут.</p></>
          : <Button disabled={busy} onClick={() => void mutate(async () => setPair(await api<Pair>("auth/pair", {})))}><Send size={17} /> {busy ? "Подключение…" : "Продолжить в Telegram"}</Button>}
      </div> : <StartForm strategy={selected} wallets={data?.wallets ?? []} busy={busy} onSubmit={body => void mutate(async () => {
        await api("experiments", body); setDialog(null); navigate("strategies");
      }, "Тест запущен")} />}
    </Modal>}
  </div>;
}
