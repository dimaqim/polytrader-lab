import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { weatherStrategies,type WeatherStrategy } from "../../lib/weather/strategies";
import { dateTime,money } from "../trade-journal";
import { actionName,cityName,kindName,metrics,pct,price,reasonText,sourceName,strategyStatus,timeLeft,
  type Bank,type Feed,type Fill,type Position,type Run,type Decision,type Readiness } from "./data";
import { Empty,Facts,Result,Row } from "./panels";

export function EquityChart({rows}:{rows:{at:string;equity:number|null}[]}) {
  if(rows.filter(x=>x.equity!=null).length<2)return <Empty>График появится после двух подтверждённых оценок банка.</Empty>;
  return <div className="weather-chart" role="img" aria-label="Виртуальный капитал по сохранённым оценкам">
    <ResponsiveContainer width="100%" height={156}><AreaChart data={rows}>
      <XAxis dataKey="at" tickFormatter={v=>new Date(v).toLocaleDateString("ru",{day:"numeric",month:"short",timeZone:"Europe/Kyiv"})} minTickGap={30}/>
      <YAxis width={52} domain={["auto","auto"]}/><Tooltip labelFormatter={v=>dateTime(String(v))}/>
      <Area type="linear" name="Капитал" dataKey="equity" stroke="var(--action)" fill="var(--quiet)" isAnimationActive={false}/>
    </AreaChart></ResponsiveContainer>
  </div>;
}
export function equitySeries(feed:Feed,run:string,strategies:WeatherStrategy[]) {
  const byTime=new Map<string,Map<string,number|null>>();
  for(const row of feed.equity) if(row.experiment===run&&strategies.includes(row.strategy)){
    const group=byTime.get(row.at)??new Map<string,number|null>();
    group.set(row.strategy,row.equity);byTime.set(row.at,group);
  }
  return [...byTime].sort(([a],[b])=>a.localeCompare(b)).map(([at,group])=>({at,
    equity:group.size===strategies.length&&[...group.values()].every(n=>n!=null)?[...group.values()].reduce<number>((sum,n)=>sum+(n??0),0):null}));
}
export function Dashboard({feed,run,banks,now,authenticated,busy,mutate,openPosition,openFill,openDecision,openStrategy,journal}:{
  feed:Feed;run?:Run;banks:Bank[];now:number;authenticated:boolean;busy:boolean;
  mutate:(path:string,value:object)=>Promise<boolean>;openPosition:(p:Position)=>void;openFill:(f:Fill)=>void;
  openDecision:(d:Decision)=>void;openStrategy:(key:WeatherStrategy)=>void;journal:()=>void;
}) {
  const [ready,online]=[feed.readiness?.payload.ready,feed.readiness!=null&&feed.readiness.payload.process&&now-+new Date(feed.readiness.checked_at)<45000];
  const active=!!run&&run.status!=="stopped"&&+new Date(run.ends_at)>now;
  const status=!run?"Ожидает запуска":run.status==="stopped"?"Остановлен":!active?"Срок новых входов завершён":run.status==="paused"?"На паузе":"Идёт";
  const unrealized=banks.map(b=>metrics(b,feed,now).unrealized);
  const subtotal=unrealized.every(p=>p!=null)?unrealized.reduce<number>((sum,x)=>sum+(x??0),0):null;
  const sum=(key:"cash"|"initial"|"locked"|"realized")=>banks.reduce((total,b)=>total+b[key],0);
  const source=online?feed.readiness?.payload.source:undefined;
  const lastMark=Math.max(0,...feed.marks.filter(mark=>mark.experiment===run?.id).map(mark=>mark.at));
  return <div className="weather-stack">
    <section className="run weather-overview"><div className="weather-overview-title">
      <div><h2>Виртуальная торговля</h2><p>{run ? "14-дневный эксперимент" : "Эксперимент Weather Lab"}</p></div>
      <span className={"trade-state "+(active&&run?.status==="running"&&ready?"active":"")}>{status}</span></div>
      <div className="weather-health-line"><span>{source?sourceName[source]:online?"Ожидаем котировки":"Сборщик недоступен"}</span>
        {feed.readiness?.payload.ws.socket&&<span>Канал открыт</span>}
        {source!=="REST_VERIFIED_PAPER"&&feed.readiness?.payload.rest?.lastResponse&&!feed.readiness.payload.ws.socket&&<span>REST отвечает</span>}
        {active&&run&&<span>До конца входов {timeLeft(+new Date(run.ends_at),now)}</span>}</div>
      {online&&feed.readiness&&<p className="muted">Проверка источников {dateTime(feed.readiness.checked_at)} по Киеву{!ready?" · новые входы ждут данных":""}</p>}
      {run&&<p className="muted">{dateTime(run.starts_at)} — {dateTime(run.ends_at)} по Киеву</p>}
      {!authenticated&&<p>Откройте Mini App из Telegram, чтобы увидеть свои сделки и управлять тестом.</p>}
      {authenticated&&(!active?<button className="action" disabled={busy||!online||!ready} onClick={()=>void mutate("start",{})}>Запустить эксперимент</button>:
        <details className="trade-details"><summary>Управление всем экспериментом</summary><div className="weather-actions">
          <button className="action secondary" disabled={busy} onClick={()=>void mutate("control",{id:run.id,status:run.status==="paused"?"running":"paused"})}>{run.status==="paused"?"Возобновить входы":"Пауза всех входов"}</button>
          <button className="text-action" disabled={busy} onClick={()=>{if(window.confirm("Завершить новые входы всех стратегий до конца этого теста?"))void mutate("control",{id:run.id,status:"stopped"});}}>Завершить входы</button>
        </div></details>)}
    </section>
    {banks.length>0&&<section className="run"><h3>Сводка по виртуальным банкам</h3><Facts items={[
      ["Стартовый банк",money(sum("initial"))],["Свободно",money(sum("cash"))],["Вложено в позиции",money(sum("locked"))],
      ["Реализовано",<Result value={sum("realized")}/>],["PnL открытых позиций",<Result value={subtotal}/>],
      ["Общий PnL",<Result value={subtotal==null?null:subtotal+sum("realized")}/>],
    ]}/><p className="muted">Сумма {banks.length} независимых банков по {money(banks[0].initial)}. Стратегии могут входить в один рынок параллельно.</p>
      {lastMark>0&&<p className="muted">Оценка продажи по проверенному стакану от {dateTime(lastMark)} по Киеву.</p>}
      <EquityChart rows={equitySeries(feed,run!.id,banks.map(b=>b.strategy))}/></section>}
    <section className="weather-stack"><h3 className="weather-section-title">Открытые позиции</h3>
      {feed.positions.length?<div className="run weather-rows">{feed.positions.slice(0,6).map(p=><Row key={p.experiment+"/"+p.strategy+"/"+p.token}
        title={cityName(p.city)+" · "+p.outcome} note={kindName(p.kind)+" · "+weatherStrategies[p.strategy]} value={money(p.basis)} onClick={()=>openPosition(p)}/>)}</div>
        :<Empty>Открытых виртуальных позиций пока нет.</Empty>}
      {feed.positions.length>6&&<button className="text-action weather-start" onClick={journal}>Все открытые позиции</button>}
    </section>
    <section className="weather-stack"><h3 className="weather-section-title">Последние исполнения</h3>
      {feed.fills.length?<div className="run weather-rows">{feed.fills.slice(0,4).map(f=><Row key={f.id}
        title={actionName[f.side]+" · "+cityName(f.city)+" · "+f.outcome} note={weatherStrategies[f.strategy]+" · "+dateTime(f.at)}
        value={price(f.gross/f.shares)} onClick={()=>openFill(f)}/>)}</div>:<Empty>Виртуальных исполнений пока нет.</Empty>}
    </section>
    <section className="weather-stack"><h3 className="weather-section-title">Последние пропуски</h3>
      {feed.decisions.length?<div className="run weather-rows">{feed.decisions.slice(0,3).map(d=><Row key={d.id} title={cityName(d.city)+" · "+reasonText(d.reason)}
        note={dateTime(d.at)} onClick={()=>openDecision(d)}/>)}</div>:<Empty>Записей о пропусках пока нет.</Empty>}
    </section>
    {banks.length>0&&<section className="weather-stack"><h3 className="weather-section-title">Результаты стратегий</h3>
      <div className="run weather-rows">{[...banks].sort((a,b)=>b.realized-a.realized).slice(0,4).map(b=><Row key={b.strategy}
        title={weatherStrategies[b.strategy]} note={strategyStatus(b.strategy,b,run,feed,now)} value={<Result value={b.realized}/>} onClick={()=>openStrategy(b.strategy)}/>)}</div>
    </section>}
  </div>;
}
export function StrategyResults({feed,run,banks,now,open}:{feed:Feed;run?:Run;banks:Bank[];now:number;open:(id:WeatherStrategy)=>void}) {
  if(!banks.length)return <Empty>Сравнение появится после запуска эксперимента.</Empty>;
  const summary=banks.map(bank=>({bank,...metrics(bank,feed,now),status:strategyStatus(bank.strategy,bank,run,feed,now)}));
  return <div className="weather-stack">
    <p className="muted">У каждой стратегии свой банк. ROI считается от её стартового банка. Пока недостаточно независимых завершённых сделок для оценки прибыльности стратегии.</p>
    <div className="weather-comparison-table run"><table>
      <caption className="sr-only">Сравнение виртуальных банков</caption>
      <thead><tr><th scope="col">Стратегия</th><th scope="col">Вложено</th><th scope="col">Реализовано</th>
        <th scope="col">Открытый PnL</th><th scope="col">Общий PnL</th><th scope="col">ROI</th><th scope="col">Открыто / покупки / продажи</th></tr></thead>
      <tbody>{summary.map(({bank,unrealized,total,status})=><tr key={bank.strategy}>
        <th scope="row"><button className="text-action" onClick={()=>open(bank.strategy)}>{weatherStrategies[bank.strategy]}</button><small>{status}</small></th>
        <td>{money(bank.locked)}</td><td><Result value={bank.realized}/></td><td><Result value={unrealized}/></td><td><Result value={total}/></td>
        <td>{total==null?"Нет оценки":pct(total/bank.initial)}</td><td>{bank.open} / {bank.buys} / {bank.sells}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="weather-comparison">{summary.map(({bank,unrealized,total,status})=>{
      return <article className="run weather-comparison-row" key={bank.strategy}>
        <Row title={weatherStrategies[bank.strategy]} note={status} onClick={()=>open(bank.strategy)}/>
        <Facts items={[["Вложено",money(bank.locked)],["Открыто",bank.open],["Реализовано",<Result value={bank.realized}/>],
          ["Нереализовано",<Result value={unrealized}/>],["Общий PnL",<Result value={total}/>],["ROI",total==null?"Нет оценки":pct(total/bank.initial)],
          ["Покупки / продажи",bank.buys+" / "+bank.sells]]}/>
      </article>;
    })}</div>
  </div>;
}
const healthNames:Record<string,string>={catalog:"Рынки и правила Polymarket",metar:"Метеостанции AWC",forecast:"ECMWF IFS, GFS, ICON",ensemble:"Ансамбль ECMWF",
  wallets:"Публичные кошельки",engine:"Проверка стратегий",rest:"Стаканы REST",heartbeat:"Связь с локальным сборщиком",notifications:"Очередь уведомлений"};
export function Sources({view,feed,source,busy,mutate}:{view?:Readiness;feed:Feed;source:string;busy:boolean;mutate:(path:string,value:object)=>Promise<boolean>}) {
  const categories={signals:"Сигналы",fills:"Покупки, продажи и расчёты",health:"Сбои данных",daily:"Дневной отчёт"} as const;
  return <div className="weather-stack">
    <article className="run"><h3>Исполнение по Polymarket</h3>
      <p>Источник · {sourceName[source as keyof typeof sourceName]??"Ожидание данных"}</p>
      <p>WebSocket · {view?.ws.socket?"Открыт":"Ожидает подключения"} · {view?.ws.subscribed??0} подписок</p>
      <p>REST · {view?.rest?.lastResponse?dateTime(view.rest.lastResponse):"Ожидание ответа"}</p>
      {view?.ws.error&&<p className="muted">{view.ws.error}</p>}{view?.rest?.error&&<p className="muted">{view.rest.error}</p>}
    </article>
    {Object.entries(view?.sources??{}).map(([key,s])=><article className="run" key={key}><h3>{healthNames[key]??key}</h3>
      <p>{s.ok?"Данные получены":s.error??"Данные недоступны"} · {dateTime(s.at)}</p></article>)}
    {feed.notifications&&<article className="run settings"><h3>Уведомления в Telegram</h3>
      {(Object.keys(categories) as (keyof typeof categories)[]).map(key=><div key={key}><label htmlFor={"weather-notify-"+key}>{categories[key]}</label>
        <input id={"weather-notify-"+key} type="checkbox" checked={feed.notifications![key]} disabled={busy}
          onChange={e=>void mutate("notifications",{...feed.notifications,[key]:e.target.checked})}/></div>)}</article>}
  </div>;
}
