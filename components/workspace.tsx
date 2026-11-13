"use client";

import { ArrowUpRight, ChevronDown, CircleHelp, Layers3, List, Plus, Settings, Users, WalletCards, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { seedWallet } from "../lib/strategies";
import type { Run, WorkspaceData } from "../lib/workspace";
import { TradeJournal, dateTime, money, resultMoney, shortAddress, walletLink } from "./trade-journal";

const tabs = [
  { id: "history", title: "Сделки", icon: List },
  { id: "copy", title: "Трейдеры", icon: Users },
  { id: "strategies", title: "Мои тесты", icon: WalletCards },
  { id: "combos", title: "Комбо", icon: Layers3 },
] as const;
type Page = typeof tabs[number]["id"] | "settings";
type TelegramApp = { initData: string; ready: () => void; expand: () => void; colorScheme?: string };
type Pair = { code: string; secret: string; url: string };

const errors: Record<string, string> = {
  invalid_parameters: "Проверьте сумму, срок и ограничения теста.",
  invalid_wallet: "Проверьте адрес кошелька. Он должен начинаться с 0x.",
  telegram_chat_required: "Отправьте боту /start, затем вернитесь и запустите тест ещё раз.",
  invalid_telegram_identity: "Сессия Telegram истекла. Закройте приложение и откройте его кнопкой в чате.",
  experiment_inactive: "Срок теста уже истёк или сработал лимит риска.",
  login_required: "Сначала войдите через Telegram.",
};
async function api<T>(path: string, payload?: object): Promise<T> {
  const response = await fetch("/api/" + path, payload ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(errors[data.error] ?? "Связь с приложением прервалась. Попробуйте ещё раз.");
  return data;
}

function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="dialog" onCancel={e => { e.preventDefault(); close(); }} aria-labelledby="dialog-title">
    <header><h2 id="dialog-title">{title}</h2><button className="icon-action" aria-label="Закрыть" onClick={close}><X size={21} /></button></header>
    {children}
  </dialog>;
}

function StartForm({ data, wallet, busy, submit }: { data: WorkspaceData; wallet: string; busy: boolean; submit: (value: object) => void }) {
  const [selection, setSelection] = useState(wallet);
  const [bank, setBank] = useState(100);
  const [stake, setStake] = useState(10);
  const [mode, setMode] = useState("auto");
  const request = useRef<{ key: string; id: string } | null>(null);
  const walletKnown = data.wallets.some(w => w.address === selection);
  const minExposure = Math.max(1, Math.min(100, Math.ceil(stake / (bank || 1) * 100)));
  const [exposure, setExposure] = useState(25);
  const appliedExposure = Math.max(minExposure, exposure);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = { strategy: "copy", wallet: walletKnown ? selection : String(form.get("wallet")).trim(), mode, bank, stake,
      days: Number(form.get("days")), exposure: Number(form.get("exposure")), drawdown: Number(form.get("drawdown")),
      slippage: Math.round(Number(form.get("slippage")) * 100) };
    const key = JSON.stringify(payload);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    submit({ ...payload, requestId: request.current.id });
  };
  return <form className="start-form" onSubmit={handleSubmit} onInvalid={e => { const details = (e.target as HTMLElement).closest("details"); if (details) details.open = true; }}>
    <label>Кого копировать<select value={walletKnown ? selection : "custom"} onChange={e => setSelection(e.target.value)}>
      {data.wallets.map(w => <option value={w.address} key={w.address}>{w.name || shortAddress(w.address)}</option>)}
      <option value="custom">Другой кошелёк</option>
    </select></label>
    {!walletKnown && <label>Адрес кошелька<input name="wallet" defaultValue={selection === "custom" ? "" : selection}
      required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" autoCapitalize="none" spellCheck={false} /></label>}
    <div className="form-pair">
      <label>Виртуальный банк, $<input type="number" min="10" max="1000000" step=".01" required
        value={bank || ""} onChange={e => setBank(Number(e.target.value))} /></label>
      <label>До $ на сделку<input type="number" min="1" max={bank} step=".01" required
        value={stake || ""} onChange={e => setStake(Number(e.target.value))} /></label>
    </div>
    <div className="form-pair">
      <label>Режим<select value={mode} onChange={e => setMode(e.target.value)}>
        <option value="auto">Автоматически</option><option value="confirm">С подтверждением</option><option value="both">Оба режима</option>
      </select></label>
      <label>Длительность<select name="days" defaultValue="7">{[7, 14, 21, 30].map(days => <option key={days} value={days}>{days} дней</option>)}</select></label>
    </div>
    {mode !== "auto" && <p className="form-hint">{mode === "both" ? "Создадим два теста с отдельными банками. " : ""}Запрос на подтверждение придёт в чат.</p>}
    <details className="form-limits">
      <summary>Ограничения цены и риска <ChevronDown size={17} /></summary>
      <label>Лимит потери банка, %<input name="drawdown" type="number" min="1" max="100" step="any" defaultValue="15" required /></label>
      <label>Доля банка в открытых позициях, %<input name="exposure" type="number" min={minExposure}
        max="100" step="any" value={appliedExposure} onChange={e => setExposure(Number(e.target.value))} required /></label>
      <label>Допустимое отклонение цены, %<input name="slippage" type="number" min="0" max="50" step=".01" defaultValue="1.5" required /></label>
    </details>
    <button className="action form-submit" disabled={busy}>{busy ? "Запускаем…" : "Запустить тест"}</button>
    <p className="form-hint">Бот проверяет свежую цену и доступный объём после покупки трейдера. Суммы виртуальные.</p>
  </form>;
}

function RunCard({ run, pause, busy }: { run: Run; pause: () => void; busy: boolean }) {
  const ended = Date.parse(run.ends_at) <= Date.now();
  const trader = run.wallet_name ?? (run.wallet && shortAddress(run.wallet));
  return <article className="run">
    <header><div><h2>{trader ?? "Наблюдение за комбо"}</h2><p>{run.strategy === "combo" ? "Отслеживание крупных ставок" : run.mode === "auto" ? "Автокопирование" : "С подтверждением"}</p></div>
      <span className={"trade-state " + (!ended && !run.paused && !run.risk_blocked ? "active" : "")}>
        {ended ? "Завершён" : run.risk_blocked ? "Лимит риска" : run.paused ? "На паузе" : "Работает"}
      </span>
    </header>
    <dl className="run-values"><div><dt>Свободно в банке</dt><dd>{money(run.cash)}</dd></div>
      <div><dt>Итог закрытых</dt><dd>{run.settled ? resultMoney(run.pnl) : "—"}</dd></div>
      <div><dt>Сделки</dt><dd>{run.fills}</dd></div></dl>
    <footer><span>{ended ? "Завершён " : "До "}{dateTime(run.ends_at)}</span>
      {!ended && !run.risk_blocked && <button className="text-action" onClick={pause} disabled={busy}>{run.paused ? "Продолжить" : "Пауза"}</button>}
    </footer>
  </article>;
}

function readPage(): Page {
  const hash = window.location.hash.slice(1);
  if (hash === "settings" || hash === "start") return hash === "start" ? "strategies" : "settings";
  if (hash === "portfolio" || hash === "analytics") return "strategies";
  return tabs.find(tab => tab.id === hash)?.id ?? "history";
}

export function Workspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [page, setPage] = useState<Page>("history");
  const [dialog, setDialog] = useState<"start" | "auth" | "help" | null>(null);
  const [theme, setTheme] = useState("light");
  const [wallet, setWallet] = useState(seedWallet);
  const [search, setSearch] = useState("");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pair, setPair] = useState<Pair | null>(null);
  const authAttempt = useRef(false);
  const startAfterAuth = useRef(false);
  const loading = !data && !offline;

  const refresh = useCallback(async () => {
    try { setData(await api<WorkspaceData>("workspace")); setOffline(false); }
    catch { setOffline(true); }
  }, []);
  useEffect(() => {
    const telegram = (window as unknown as { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
    const preferred = localStorage.getItem("polytrader-theme") ?? (telegram?.initData && telegram.colorScheme)
      ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(preferred || "light");
    document.documentElement.dataset.theme = preferred || "light";
    telegram?.ready();
    telegram?.expand();
    const route = () => setPage(readPage());
    route();
    window.addEventListener("hashchange", route);
    if (!authAttempt.current) {
      authAttempt.current = true;
      const auth = telegram?.initData ? api("auth/telegram", { initData: telegram.initData })
        .catch(e => setNotice(e.message)) : Promise.resolve();
      void auth.then(refresh);
    }
    const whenVisible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(whenVisible, 25_000);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("hashchange", route);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!data || window.location.hash !== "#start") return;
    window.history.replaceState(null, "", "#strategies");
    setPage("strategies");
    startAfterAuth.current = !data.user;
    setDialog(data.user ? "start" : "auth");
  }, [data, page]);

  useEffect(() => {
    if (!pair || dialog !== "auth") return;
    let waiting = false;
    const timer = window.setInterval(async () => {
      if (waiting) return;
      waiting = true;
      try {
        if ((await api<{ ok?: boolean }>("auth/claim", pair)).ok) {
          setPair(null);
          await refresh();
          setDialog(startAfterAuth.current ? "start" : null);
          startAfterAuth.current = false;
        }
      } catch { setNotice("Не удалось подтвердить вход. Попробуйте ещё раз."); }
      finally { waiting = false; }
    }, 2500);
    return () => clearInterval(timer);
  }, [pair, dialog, refresh]);

  const navigate = (next: Page) => {
    setPage(next);
    setNotice("");
    window.location.hash = next;
    window.scrollTo(0, 0);
  };
  const openStart = (address = seedWallet) => {
    setWallet(address); setNotice(""); startAfterAuth.current = !data?.user;
    setDialog(data?.user ? "start" : "auth");
  };
  const openLogin = () => { startAfterAuth.current = false; setNotice(""); setDialog("auth"); };
  const mutate = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true); setNotice("");
    try { await action(); await refresh(); if (success) setNotice(success); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Попробуйте ещё раз."); }
    finally { setBusy(false); }
  };
  const wallets = data?.wallets.filter(w => (w.name + " " + w.address).toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const titles = { history: "Журнал сделок", copy: "Трейдеры", strategies: "Мои тесты", combos: "Крупные комбо", settings: "Настройки" };
  const monitor = data?.health.find(item => item.source === "neon");
  const upstream = data?.health.find(item => item.source === "polymarket");
  const healthy = !!monitor && Date.now() - Date.parse(monitor.at) < 180_000 && monitor.details.sections?.every(Boolean)
    && !!upstream && Date.now() - Date.parse(upstream.at) < 600_000 && Object.values(upstream.details).every(Boolean);
  return <div className="app-shell">
    <header className="app-bar">
      <a className="wordmark" href="#history" onClick={e => { e.preventDefault(); navigate("history"); }}>
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>PolyTrader Lab
      </a>
      <div className="app-actions">
        <button className="icon-action" aria-label="Как это работает" onClick={() => { setNotice(""); setDialog("help"); }}><CircleHelp size={21} /></button>
        <button className="icon-action" aria-label="Настройки" onClick={() => navigate("settings")}><Settings size={21} /></button>
      </div>
    </header>
    <main id="main">
      <header className="page-header">
        <div><h1>{titles[page]}</h1>
          <p>{{
            history: "Виртуальные покупки и их результат",
            copy: "Выберите, чьи покупки отслеживать",
            strategies: "Отдельный виртуальный банк на каждый тест",
            combos: "Наблюдение за ставками от $2 000",
            settings: data?.user ? data.user.name : "Telegram и уведомления",
          }[page]}</p></div>
        {(page === "history" || page === "strategies") && <button className="action new-test" onClick={() => openStart()} disabled={loading}><Plus size={17} /> Новый тест</button>}
      </header>
      {offline && <div className="notice" role="status">Данные не обновились. <button onClick={refresh}>Повторить</button></div>}
      {notice && !dialog && <p className="notice" role="status">{notice}</p>}
      {loading ? <p className="loading" role="status">Загружаем приложение…</p> : <>
        {page === "history" && <TradeJournal authenticated={!!data?.user} onStart={() => openStart()} onLogin={openLogin} />}
        {page === "copy" && <section className="section">
          <label className="search"><span>Найти трейдера</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Имя или адрес кошелька" /></label>
          <ul className="wallet-list">{wallets.map(w => <li key={w.address}>
            <div className="trade-source"><span className="avatar" aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span>
              <div><a className="trader" href={walletLink(w.address)} target="_blank" rel="noreferrer">{w.name} <ArrowUpRight size={13} aria-hidden="true" /></a>
              <small>{shortAddress(w.address)}</small></div></div>
            <button className="action secondary" onClick={() => openStart(w.address)}>Копировать<span className="sr-only"> {w.name}</span></button>
          </li>)}</ul>
          {!wallets.length && <p className="loading">Трейдеры не найдены.</p>}
        </section>}
        {page === "strategies" && (data?.runs.length ? <div className="run-list">{data.runs.map(run => <RunCard key={run.id} run={run} busy={busy}
          pause={() => void mutate(() => api("experiments/pause", { id: run.id, paused: !run.paused }))} />)}</div>
          : <div className="empty"><WalletCards size={24} aria-hidden="true" /><h2>У вас пока нет тестов</h2>
            <p>Начните с трейдера и суммы, которую хотите проверить на виртуальных сделках.</p>
            <button className="action" onClick={() => openStart()}>Начать копировать</button></div>)}
        {page === "combos" && <section className="section combo-list">
          <p className="muted">Здесь видно, на какие исходы поставили другие трейдеры. Для комбо доступно наблюдение.</p>
          {data?.combos.map(combo => <article key={combo.id} className="combo">
            <header><a href={walletLink(combo.wallet)} target="_blank" rel="noreferrer" className="trader">{combo.name ?? shortAddress(combo.wallet)}</a>
              <strong>{money(combo.stake)}</strong></header>
            <ul>{combo.payload.legs.map((leg, index) => <li key={index}>{leg.market.title} <span>{leg.leg_outcome_label}</span></li>)}</ul>
            <small>Замечено {dateTime(combo.detected_at)} по Киеву</small>
          </article>)}
          {!data?.combos.length && <p className="loading">Крупных комбо пока нет.</p>}
        </section>}
        {page === "settings" && <section className="section settings">
          <div><span><strong>Обновление сделок</strong><small>{healthy ? "Данные Polymarket обновляются" : "Обновление данных задерживается"}</small></span>
            <button className="text-action" onClick={refresh}>Обновить</button></div>
          {data?.user && <div><label htmlFor="alerts"><strong>Новости по тестам</strong><small>Исполнения, результаты, комбо и дневной отчёт</small></label>
            <input type="checkbox" id="alerts" checked={data.user.alerts} disabled={busy}
              onChange={e => { const alerts = e.target.checked; void mutate(() => api("settings", { alerts })); }} /></div>}
          {!data?.user && <div><button className="action" onClick={openLogin}>Войти через Telegram</button></div>}
          <div><span><strong>Тема</strong><small>{theme === "dark" ? "Тёмная" : "Светлая"}</small></span>
            <button className="text-action" onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              document.documentElement.dataset.theme = next;
              localStorage.setItem("polytrader-theme", next);
            }}>Сменить</button></div>
        </section>}
      </>}
    </main>
    <nav className="tabs" aria-label="Разделы">
      {tabs.map(({ id, title, icon: Icon }) => <a key={id} href={"#" + id} aria-current={page === id ? "page" : undefined}
        onClick={e => { e.preventDefault(); navigate(id); }}><Icon size={21} aria-hidden="true" />{title}</a>)}
    </nav>
    {dialog && <Dialog title={dialog === "start" ? "Новый тест копирования" : dialog === "auth" ? "Вход через Telegram" : "Как работает копирование"}
      close={() => { setDialog(null); setNotice(""); setPair(null); }}>
      {notice && <p className="notice" role="status">{notice}</p>}
      {dialog === "start" && data && <StartForm data={data} wallet={wallet} busy={busy} submit={value => void mutate(async () => {
        await api("experiments", value); setDialog(null); navigate("strategies");
      }, "Тест запущен. Бот ждёт следующую покупку выбранного трейдера.")} />}
      {dialog === "help" && <div className="help">
        <p><strong>Трейдер покупает.</strong> Бот замечает покупку выбранного кошелька после начала теста.</p>
        <p><strong>Бот проверяет вход.</strong> Учитывает текущую цену, доступный объём и ваши лимиты. В ручном режиме сначала спрашивает в чате.</p>
        <p><strong>Позиция закрывается при расчёте Polymarket.</strong> Продажи трейдера не закрывают вашу позицию. Отклонённые входы и их причины видны в «Пропущенных».</p>
      </div>}
      {dialog === "auth" && <div className="help">
        <p>Откройте бота, чтобы подтвердить вход и увидеть свои тесты.</p>
        {pair ? <a className="action" href={pair.url} target="_blank" rel="noreferrer">Подтвердить в Telegram <ArrowUpRight size={15} /></a>
          : <button className="action" disabled={busy} onClick={() => void mutate(async () => setPair(await api<Pair>("auth/pair", {})))}>
            Продолжить в Telegram
          </button>}
        {pair && <p className="muted">Нажмите Start в чате и вернитесь сюда.</p>}
      </div>}
    </Dialog>}
  </div>;
}
