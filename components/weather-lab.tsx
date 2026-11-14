"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { weatherStrategies, type WeatherStrategy } from "../lib/weather/strategies";
import type { Estimate, WalletEvent, WeatherEvent } from "../lib/weather/types";
import { dateTime, money, resultMoney, walletLink } from "./trade-journal";

const sections = [
  ["overview", "Эксперимент"], ["markets", "Рынки"], ["strategies", "Стратегии"], ["journal", "Журнал"],
  ["wallets", "Кошельки"], ["analysis", "Аналитика"], ["health", "Источники"],
] as const;
type Section = typeof sections[number][0];
type Run = { id: string; status: string; starts_at: string; ends_at: string };
type Bank = { experiment: string; strategy: WeatherStrategy; cash: number; initial: number; realized: number; max_drawdown: number;
  risk_blocked: boolean; liquidation: number | null; at: string | null; marked_cash: number | null;
  locked: number; open: number; events: number; wins: number; closed: number; fees: number; buys: number; sells: number };
type Decision = { id: string; experiment: string | null; strategy: WeatherStrategy | "system"; city: string; at: string;
  action: string; reason: string; reference: string | null; ev: string | null; wallet: string | null };
type Fill = { id: string; experiment: string; strategy: WeatherStrategy; city: string; outcome: string; at: string;
  side: string; shares: string; fee: string; gross: string; pnl: string | null; evidence: { delayMs?: number;
    fill?: { partial: boolean; price: number }; executionBook?: { session: string; book: { sourceAt: number; receivedAt: number } };
    candidate?: { reason: string; reference: number; wallet?: WalletEvent }; walletSell?: WalletEvent } };
type Readiness = { ready: boolean; process: boolean; ws: { socket: boolean; subscribed: number; snapshots: number; updates: number;
  lastQuote: number | null; error: string | null }; sources: Record<string, { ok: boolean; at: number; count?: number; error?: string }> };
type View = { event: string; books: { condition: string; yes?: {bid:number;ask:number}; no?: {bid:number;ask:number} }[] } & Estimate;
type Feed = {
  readiness: { checked_at: string; payload: Readiness } | null;
  live: { data: View[]; wallets: { name: string; address: string }[]; walletEvents: WalletEvent[] } | null;
  markets: WeatherEvent[]; runs: Run[]; banks: Bank[]; fills: Fill[]; decisions: Decision[];
  positions: { token: string; strategy: WeatherStrategy; experiment: string; city: string; outcome: string; shares: string; basis: string }[];
  equity: { experiment: string; strategy: WeatherStrategy; at: string; equity: number | null }[];
  notifications: Record<"signals"|"fills"|"health"|"daily",boolean> | null;
};
const categories = { signals:"Существенные сигналы",fills:"Покупки, продажи и расчёты",health:"Сбои потока",daily:"Дневной отчёт" } as const;
type Scores = { accuracy: { horizon:number;n:number;paired:number;brier:number|null;logLoss:number|null;
  pairedWeatherBrier:number|null;marketBrier:number|null;bins:{bottom:number;top:number;n:number;predicted:number|null;observed:number|null}[] }[];
  financial:{experiment:string;strategy:WeatherStrategy;n:number;interval:[number,number]|null}[] };

const reasonText: Record<string,string> = {
  RULES_UNVERIFIED: "Правила расчёта не подтверждены", STALE_BOOK: "Нет свежего стакана WebSocket",
  INSUFFICIENT_MODEL_CONFIDENCE: "Недостаточно данных для уверенной оценки", NO_CONSERVATIVE_EDGE: "Преимущество после расходов не подтверждено",
  MARKET_FAVORITE: "Рыночный фаворит", PUBLIC_WALLET_BUY: "Публичная покупка трейдера", PUBLIC_WALLET_SELL: "Публичная продажа трейдера",
  OBSERVED_RANGE_EXCLUDED: "Наблюдение вышло за рамки диапазона", CONSERVATIVE_DISTRIBUTION_EDGE: "Преимущество по распределению",
  WEATHER_VALUE: "Погодная оценка выше цены", WEATHER_VALUE_AND_WALLET: "Погодная оценка и покупка трейдера",
  REMAINING_DAY_EDGE: "Прогноз на остаток дня", CALIBRATED_TAIL_EDGE: "Недорогой контракт с подтверждённым преимуществом",
  FORECAST_REVISION_EXCEEDS_MARKET: "Пересмотр прогноза опередил рынок", FAIR_VALUE_EXIT: "Доступная продажа выгоднее удержания",
  FORECAST_REVERSAL_RISK: "Прогноз ухудшился", REPRICING_TARGET: "Достигнута цель переоценки", SETTLEMENT_HOLD: "Удержание до расчёта",
  PAPER_FILLED: "Виртуальная покупка", PAPER_PARTIAL: "Частичное исполнение", PAPER_SELL_FILLED: "Виртуальная продажа",
  SETTLED: "Рынок рассчитан", PRICE_MOVED: "Цена изменилась после сигнала", NO_LIQUIDITY_OR_MINIMUM: "Недостаточно ликвидности или объёма заявки",
  RISK_REJECTED: "Лимит риска", PUBLIC_INVENTORY_UNVERIFIED: "Объём позиции трейдера не подтверждён",
  COMPLETE_SET_MONITOR_ONLY: "Найден комплект для наблюдения",
};
const pct = (value: number | null) => value == null ? "—" : (value * 100).toFixed(1) + "%";
const modelLabel = (value: string) => value.startsWith("ecmwf") ? "ECMWF IFS" : value.startsWith("gfs") ? "GFS" : "ICON";
const reason = (value: string) => reasonText[value] ?? value;
const actionText: Record<string,string> = { BUY:"Покупка", SELL:"Продажа", SETTLE:"Расчёт", HOLD:"Удержание", SKIP:"Пропуск" };
function Empty({ text }: { text: string }) { return <p className="weather-empty muted">{text}</p>; }

function MarketCard({ event, live }: { event: WeatherEvent; live?: View }) {
  const unique = live?.forecasts.filter((row, i, arr) => arr.findIndex(x => x.model === row.model) === i);
  const closes = Math.max(0, Math.round((event.end - Date.now()) / 3600_000));
  return <article className="run weather-market">
    <header><div><h3>{event.station.city}</h3><p>{event.kind === "highest" ? "Максимум" : "Минимум"} · {event.date} · {event.station.code}</p></div>
      <span className={"trade-state " + (event.verified ? "active" : "loss")}>{event.verified ? "Правила проверены" : "Правила не подтверждены"}</span></header>
    <div className="weather-facts"><span>{live?.observation?.temperature == null ? "Нет свежего наблюдения" : `${live.observation.temperature.toFixed(1)} °C по METAR`}</span>
      <span>{event.end > Date.now() ? `До конца местного дня ≈ ${closes} ч` : "Местный день завершён"}</span></div>
    <details className="trade-details">
      <summary>Прогнозы и исходы</summary>
      {unique?.length ? <div className="weather-facts">{unique.map(row => <span key={row.model}>{modelLabel(row.model)} {row.value.toFixed(1)} °C</span>)}</div>
        : <Empty text="Прогноз для этого события ещё не рассчитан." />}
      {live?.calibration?.length ? <p className="muted weather-meta">{live.calibration.map(c => `${modelLabel(c.model)} σ ${c.sigma.toFixed(1)} °C, n=${c.n}`).join(" · ")}</p> : null}
      {live && !live.confidence && <p className="muted weather-meta">Оценка исследовательская. Для сигналов модели данных пока недостаточно.</p>}
      <ul className="weather-outcomes">{event.contracts.map(contract => {
        const p = live?.distribution.find(row => row.condition === contract.condition);
        const book = live?.books.find(row => row.condition === contract.condition);
        return <li key={contract.condition}><strong>{contract.bucket.label}</strong>
          <small>Погода {pct(p?.p ?? null)} · рынок {pct(p?.market ?? null)} · смесь {pct(p?.blended ?? null)}</small>
          {p && <small>Диапазон {pct(p.low)} – {pct(p.high)}</small>}
          {book?.yes && <small>YES · покупка {pct(book.yes.ask)} · продажа {pct(book.yes.bid)}</small>}
          {book?.no && <small>NO · покупка {pct(book.no.ask)} · продажа {pct(book.no.bid)}</small>}
          <small>{book?.yes || book?.no ? `Снимок в ${dateTime(live!.at)} по Киеву` : "Нет свежего L2"}</small></li>;
      })}</ul>
      <p className="weather-meta"><a href={event.source} target="_blank" rel="noreferrer">Источник расчёта</a> · <a href={`https://polymarket.com/event/${encodeURIComponent(event.slug)}`} target="_blank" rel="noreferrer">Рынок <ArrowUpRight size={12} /></a></p>
      <details className="trade-details"><summary>Оригинальные правила</summary><p className="weather-rules">{event.rules}</p></details>
    </details>
  </article>;
}

export function WeatherLab({ authenticated }: { authenticated: boolean }) {
  const [feed,setFeed] = useState<Feed | null>(null);
  const [tab,setTab] = useState<Section>("overview");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [city,setCity] = useState("");
  const [strategy,setStrategy] = useState("");
  const [action,setAction] = useState("");
  const [scores,setScores] = useState<Scores|null>(null);
  const [scoresError,setScoresError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/weather", { cache:"no-store" });
      if (!response.ok) throw Error();
      setFeed(await response.json());
      setError("");
    } catch { setError("Weather Lab пока недоступен. Повторите обновление."); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); },20_000);
    return () => clearInterval(timer);
  }, [refresh, authenticated]);
  useEffect(()=>{
    if (tab!=="analysis") return;
    const controller = new AbortController();
    fetch("/api/weather/scores",{cache:"no-store",signal:controller.signal}).then(response=>{
      if (!response.ok) throw Error();
      return response.json();
    }).then(data=>{setScores(data);setScoresError(false);}).catch(()=>{
      if (!controller.signal.aborted) setScoresError(true);
    });
    return ()=>controller.abort();
  },[tab,authenticated]);
  const mutate = async (path: string, value: object) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/weather/" + path, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(value) });
      if (!response.ok) throw Error();
      await refresh();
    } catch { setError("Действие не выполнено. Проверьте состояние источников и эксперимента."); }
    finally { setBusy(false); }
  };

  const run = feed?.runs[0];
  const running = run && run.status !== "stopped" && +new Date(run.ends_at) > Date.now();
  const banks = feed?.banks.filter(row => row.experiment === run?.id) ?? [];
  const view = feed?.readiness?.payload;
  const online = !!feed?.readiness && Date.now() - +new Date(feed.readiness.checked_at) < 45_000 && view?.process;
  const ready = online && view?.ready;
  const sum = (key: "cash"|"locked"|"realized"|"fees"|"open"|"closed") => banks.reduce((total,b) => total+b[key],0);
  const group = (list: (Decision | Fill)[]) => list.filter(row => (!strategy || row.strategy === strategy) && (!city || row.city === city)
    && (!action || ("side" in row ? row.side : row.action) === action));
  const cities = [...new Set(feed?.markets.map(e => e.station.city))];
  const activeMarkets = feed?.markets.filter(m=>(!city||m.station.city===city)&&m.end>Date.now()&&m.contracts.some(c=>c.open)) ?? [];
  const walletName = (address: string) => feed?.live?.wallets.find(w=>w.address===address)?.name ?? `${address.slice(0,6)}…${address.slice(-4)}`;
  const chart = feed?.equity.filter(row => row.experiment === run?.id && row.strategy === (strategy || "favorite"))
    .sort((a,b)=>+new Date(a.at)-+new Date(b.at)) ?? [];
  const financial = scores?.financial.find(row=>row.experiment===run?.id && row.strategy===(strategy||"favorite"));
  const status = !online ? "Сборщик недоступен" : ready ? "Данные готовы" : "Сбор данных · входы заблокированы";

  return <section className="weather" aria-label="Weather Lab">
    <div className="weather-top"><span className={"trade-state " + (ready ? "active" : "")}>{status}</span>
      <button className="text-action" onClick={() => void refresh()}><RefreshCw size={15} /> Обновить</button></div>
    <nav className="combo-filters weather-tabs" aria-label="Разделы Weather Lab">
      {sections.map(([id,title])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{title}</button>)}
    </nav>
    {error && <p className="notice" role="status">{error}</p>}
    {!feed && !error && <p className="loading" role="status">Загружаем погодные данные…</p>}
    {feed && tab==="overview" && <div className="weather-stack">
      <article className="run"><header><div><h3>14-дневный Paper Trading</h3><p>{run ? run.status==="stopped" ? "Остановлен" : running ? run.status==="paused" ? "На паузе" : "Активен" : "Срок входов завершён" : "Эксперимент ещё не запущен"}</p></div></header>
        {run && <p className="weather-meta">{dateTime(run.starts_at)} — {dateTime(run.ends_at)} по Киеву</p>}
        {banks.length>0 && <dl className="run-values"><div><dt>Свободно</dt><dd>{money(sum("cash"))}</dd></div>
          <div><dt>В позициях</dt><dd>{money(sum("locked"))}</dd></div><div><dt>Реализовано</dt><dd>{resultMoney(sum("realized"))}</dd></div></dl>}
        {running && run && <div className="weather-actions">
          <button className="action secondary" disabled={busy} onClick={()=>void mutate("control",{id:run.id,status:run.status==="paused"?"running":"paused"})}>
            {run.status==="paused"?"Возобновить":"Пауза"}</button>
          <button className="text-action" disabled={busy} onClick={()=>void mutate("control",{id:run.id,status:"stopped"})}>Прекратить новые входы</button>
        </div>}
        {!running && <button className="action" disabled={busy||!authenticated||!ready} onClick={()=>void mutate("start",{})}>Запустить эксперимент</button>}
        {!authenticated && <p className="weather-meta muted">Откройте Mini App из Telegram для управления экспериментом.</p>}
        {online && !ready && <p className="weather-meta muted">Старт доступен после подтверждения потока L2 и погодных источников.</p>}
      </article>
      <h2>Открытые позиции</h2>
      {feed.positions.length?feed.positions.map(p=><article className="run" key={[p.experiment,p.strategy,p.token].join("/")}>
        <h3>{p.city} · {p.outcome}</h3><p className="muted">{weatherStrategies[p.strategy]} · {Number(p.shares).toFixed(3)} контрактов · {money(Number(p.basis))}</p>
      </article>):<Empty text="Открытых виртуальных позиций пока нет." />}
    </div>}
    {feed && tab==="markets" && <div className="weather-stack">
      <label>Город<select value={city} onChange={e=>setCity(e.target.value)}><option value="">Все города</option>{cities.map(c=><option key={c}>{c}</option>)}</select></label>
      {activeMarkets.map(event=><MarketCard key={event.id} event={event}
        live={feed.live?.data.find(row=>row.event===event.id)} />)}
      {!activeMarkets.length && <Empty text="Активных рынков по этому фильтру пока нет." />}
    </div>}
    {feed && tab==="strategies" && <div className="weather-stack">
      {Object.entries(weatherStrategies).map(([id,label])=>{
        const bank=banks.find(row=>row.strategy===id);
        return <article className="run" key={id}><header><div><h3>{label}</h3><p>v1 · {id==="complete"?"Мониторинг":bank?.risk_blocked?"Лимит риска":bank?"Виртуальный банк":"Ожидает старта"}</p></div>
          {bank&&<strong>{resultMoney(bank.realized)}</strong>}</header>
          {bank&&<dl className="run-values"><div><dt>Свободно</dt><dd>{money(bank.cash)}</dd></div>
            <div><dt>Покупки / продажи</dt><dd>{bank.buys} / {bank.sells}</dd></div><div><dt>Просадка</dt><dd>{money(bank.max_drawdown)}</dd></div></dl>}
        </article>;
      })}
    </div>}
    {feed && tab==="journal" && <div className="weather-stack">
      <div className="weather-selects"><label>Стратегия<select value={strategy} onChange={e=>setStrategy(e.target.value)}><option value="">Все</option>
        {Object.entries(weatherStrategies).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label>
        <label>Город<select value={city} onChange={e=>setCity(e.target.value)}><option value="">Все</option>{cities.map(c=><option key={c}>{c}</option>)}</select></label>
        <label>Действие<select value={action} onChange={e=>setAction(e.target.value)}><option value="">Все</option>{Object.entries(actionText).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <h2>Исполнения</h2>{group(feed.fills).length ? group(feed.fills).map(row=>{
        const fill=row as Fill;
        const price = Number(fill.gross) / Number(fill.shares);
        const sourceWallet = fill.evidence.walletSell ?? fill.evidence.candidate?.wallet;
        const book = fill.evidence.executionBook?.book;
        const net = Number(fill.gross) + (fill.side === "BUY" ? 1 : -1) * Number(fill.fee);
        return <article className="run" key={row.id}><h3>{actionText[fill.side]} · {fill.city} · {fill.outcome}</h3>
          <p className="muted">{dateTime(fill.at)} по Киеву · {weatherStrategies[fill.strategy]}{fill.evidence.fill?.partial ? " · частично" : ""}</p>
          <dl className="run-values"><div><dt>Цена за контракт</dt><dd>{(price*100).toFixed(2)}¢</dd></div>
            <div><dt>{fill.side === "BUY" ? "Списано" : "Получено"}</dt><dd>{money(net)}</dd></div>
            <div><dt>Комиссия</dt><dd>{money(Number(fill.fee))}</dd></div></dl>
          <p>{Number(fill.shares).toFixed(3)} шт.{fill.pnl==null?"":` · результат ${resultMoney(Number(fill.pnl))}`}</p>
          {sourceWallet && <p>Трейдер <a href={walletLink(sourceWallet.wallet)} target="_blank" rel="noreferrer">{walletName(sourceWallet.wallet)}</a></p>}
          {book && <details className="trade-details"><summary>Подтверждение из стакана</summary><p>Котировка получена {dateTime(book.receivedAt)} по Киеву · задержка {fill.evidence.delayMs} мс.</p></details>}
        </article>;
      }):<Empty text="Подтверждённых виртуальных исполнений пока нет." />}
      <h2>Решения</h2>{group(feed.decisions).length ? group(feed.decisions).map(row=>{
        const decision=row as Decision;
        return <article className="run" key={row.id}><h3>{decision.city} · {reason(decision.reason)}</h3>
          <p className="muted">{actionText[decision.action] ?? decision.action} · {dateTime(decision.at)} по Киеву{decision.ev==null?"":` · EV ${pct(Number(decision.ev))}`}
            {decision.wallet && <> · <a href={walletLink(decision.wallet)} target="_blank" rel="noreferrer">{walletName(decision.wallet)}</a></>}</p></article>;
      }):<Empty text="Решений по этому фильтру пока нет." />}
    </div>}
    {feed && tab==="wallets" && <div className="weather-stack">
      {!feed.live?.wallets.length && <Empty text="Ожидаем подтверждения публичных профилей Polymarket." />}
      {feed.live?.wallets.map(wallet=><article className="run" key={wallet.address}><h3><a href={walletLink(wallet.address)} target="_blank" rel="noreferrer">{wallet.name}</a></h3>
        <p className="muted weather-address">{wallet.address}</p>
        {feed.live!.walletEvents.filter(e=>e.wallet===wallet.address).slice(-5).reverse().map(e=><p key={e.id}>
          {e.side||e.type} · {e.price ? pct(e.price) : "—"} · обнаружено {dateTime(e.receivedAt)}</p>)}
      </article>)}
    </div>}
    {feed && tab==="analysis" && <div className="weather-stack">
      <label>Стратегия<select value={strategy||"favorite"} onChange={e=>setStrategy(e.target.value)}>
        {Object.entries(weatherStrategies).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      {chart.some(row=>row.equity!=null)?<div className="weather-chart"><ResponsiveContainer width="100%" height={210}>
        <AreaChart data={chart}><XAxis dataKey="at" tickFormatter={value=>new Date(value).toLocaleDateString("ru-RU")} minTickGap={28} />
          <YAxis width={48} domain={["auto","auto"]} /><Tooltip labelFormatter={value=>dateTime(String(value))} />
          <Area type="linear" dataKey="equity" stroke="var(--action)" fill="var(--quiet)" isAnimationActive={false} /></AreaChart>
      </ResponsiveContainer></div>:<Empty text="График появится после первой подтверждённой оценки банка." />}
      {banks.filter(b=>b.strategy===(strategy||"favorite")).map(b=><article className="run" key={b.strategy}>
        <dl className="run-values"><div><dt>ROI на банк</dt><dd>{pct(b.realized/b.initial)}</dd></div><div><dt>Прибыльные</dt><dd>{b.closed?pct(b.wins/b.closed):"—"}</dd></div>
          <div><dt>Комиссии</dt><dd>{money(b.fees)}</dd></div></dl><p className="muted">Событий {b.events}. {b.events<20?"Недостаточная независимая выборка.":""}</p>
      </article>)}
      <h2>Точность прогноза</h2>
      {scoresError ? <Empty text="Не получилось загрузить оценки прогнозов." />
        : scores?.accuracy.some(row=>row.n>0) ? scores.accuracy.filter(row=>row.n>0).map(row=><article className="run" key={row.horizon}>
          <h3>За {row.horizon} ч · {row.n} рассчитанных событий</h3>
          <p>Brier {row.brier?.toFixed(3)} · Log Loss {row.logLoss?.toFixed(3)}</p>
          {row.paired>0 && <p className="muted">На тех же {row.paired} событиях Brier модели {row.pairedWeatherBrier?.toFixed(3)} · рынка {row.marketBrier?.toFixed(3)}</p>}
          <details className="trade-details"><summary>Калибровка</summary>
            {row.bins.filter(bin=>bin.n>0).map(bin=><p key={bin.bottom}>{pct(bin.bottom)}–{pct(bin.top)} · прогноз {pct(bin.predicted)} · сбылось {pct(bin.observed)} · {bin.n} исходов</p>)}
          </details>
        </article>) : <Empty text={scores?"Оценки появятся после официального расчёта рынков с сохранённым прогнозом.":"Загружаем оценки прогнозов…"} />}
      <h2>Неопределённость результата</h2>
      {financial?.interval ? <article className="run"><p>95% интервал среднего PnL на станцию и день от {resultMoney(financial.interval[0])} до {resultMoney(financial.interval[1])}.</p>
        <p className="muted">Закрытых групп {financial.n}.</p></article> : <Empty text={"Для интервала нужно 20 закрытых групп «станция и день». Сейчас "+(financial?.n??0)+"."} />}
    </div>}
    {feed && tab==="health" && <div className="weather-stack">
      {feed.notifications && <article className="run settings"><h3>Уведомления в Telegram</h3>
        {(Object.keys(categories) as (keyof typeof categories)[]).map(key=><div key={key}>
          <label htmlFor={"weather-notify-"+key}>{categories[key]}</label>
          <input id={"weather-notify-"+key} type="checkbox" checked={feed.notifications![key]} disabled={busy}
            onChange={e=>void mutate("notifications",{ ...feed.notifications,[key]:e.target.checked })}/>
        </div>)}<p className="muted">Действуют, когда включены общие уведомления по тестам.</p>
      </article>}
      <article className="run"><h3>Polymarket L2</h3><p>{view?.ws.socket?"WebSocket открыт":"WebSocket недоступен"}</p>
        <p className="muted">Подписки {view?.ws.subscribed??0} · полные снимки {view?.ws.snapshots??0} · изменения {view?.ws.updates??0}</p>
        {view?.ws.error&&<p className="muted">{view.ws.error}</p>}</article>
      {Object.entries(view?.sources??{}).map(([id,source])=><article className="run" key={id}><h3>{({catalog:"Рынки Polymarket",metar:"Aviation Weather Center",
        forecast:"ECMWF IFS, GFS, ICON",ensemble:"ECMWF Ensemble",wallets:"Публичные кошельки",engine:"Торговая оценка"})[id]??id}</h3>
        <p className="muted">{source.ok?"Данные получены":source.error} · {dateTime(source.at)}</p></article>)}
    </div>}
  </section>;
}
