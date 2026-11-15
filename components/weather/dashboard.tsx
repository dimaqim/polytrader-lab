import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { weatherStrategies,weatherStrategyGroups,type WeatherStrategy } from "../../lib/weather/strategies";
import { dateTime,money } from "../trade-journal";
import { actionName,cityName,kindName,marketDay,metrics,outcomeName,pct,sourceName,strategyStatus,
  type Bank,type Feed,type Fill,type Position,type Run,type Readiness } from "./data";
import { Empty,Facts,Result,Row } from "./panels";
import { StorageStatus } from "./storage";

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
export function Dashboard({feed,run,banks,now,authenticated,busy,mutate,openPosition,openFill,showHistory}:{
  feed:Feed;run?:Run;banks:Bank[];now:number;authenticated:boolean;busy:boolean;
  mutate:(path:string,value:object)=>Promise<boolean>;openPosition:(p:Position)=>void;openFill:(f:Fill)=>void;
  showHistory:(kind:string)=>void;
}) {
  const online=!!feed.readiness?.payload.process&&now-+new Date(feed.readiness.checked_at)<45_000;
  const ready=online&&feed.readiness?.payload.ready;
  const active=!!run&&run.status!=="stopped"&&+new Date(run.ends_at)>now;
  const status=!run?"Тест не запущен":!active?"Новые покупки завершены":run.status==="paused"?"Покупки на паузе"
    :ready?"Тест идёт":"Покупки ждут данных";
  const openPositions=feed.positions.filter(p=>p.experiment===run?.id);
  const days=[...new Set(openPositions.map(p=>p.market_day??""))].sort();
  const sum=(key:"cash"|"initial"|"locked"|"realized")=>banks.reduce((total,b)=>total+b[key],0);
  const unrealized=banks.map(b=>metrics(b,feed,now).unrealized);
  const subtotal=unrealized.every(p=>p!=null)?unrealized.reduce<number>((sum,x)=>sum+(x??0),0):null;
  const recentFills=feed.fills.filter(f=>f.experiment===run?.id).slice(0,4);
  return <div className="weather-stack">
    <section className="run weather-overview">
      <div className="weather-overview-title">
        <h2>Виртуальные ставки</h2>
        <span className={"trade-state "+(active&&run?.status==="running"&&ready?"active":"")}>{status}</span>
      </div>
      {banks.length>0&&<Facts items={[
        ["Открыто",openPositions.length],["Вложено",money(sum("locked"))],["Итог закрытых",<Result value={sum("realized")}/>],
      ]}/>}
      {!authenticated&&<p className="muted">Откройте приложение из Telegram, чтобы увидеть свои ставки и их результат.</p>}
      {authenticated&&!active&&<button className="action" disabled={busy||!ready} onClick={()=>void mutate("start",{})}>Начать погодный тест</button>}
      {run&&<details className="trade-details"><summary>Баланс и управление тестом</summary>
        <Facts items={[["Стартовый банк",money(sum("initial"))],["Свободные средства",money(sum("cash"))],
          ["Общий результат",subtotal==null?"Нужны свежие цены":<Result value={subtotal+sum("realized")}/>]]}/>
        <p className="muted">Новые покупки разрешены до {dateTime(run.ends_at)} по Киеву.</p>
        {active&&authenticated&&<div className="weather-actions">
          <button className="action secondary" disabled={busy} onClick={()=>void mutate("control",{id:run.id,status:run.status==="paused"?"running":"paused"})}>{run.status==="paused"?"Возобновить покупки":"Пауза покупок"}</button>
          <button className="text-action" disabled={busy} onClick={()=>{if(window.confirm("Завершить новые покупки всех стратегий до конца этого теста?"))void mutate("control",{id:run.id,status:"stopped"});}}>Завершить покупки</button>
        </div>}
      </details>}
    </section>
    {authenticated&&<section className="weather-stack" aria-label="Открытые ставки">
      <h2 className="weather-section-title">Открытые ставки</h2>
      {days.length===0&&<Empty>Открытых ставок в текущем тесте пока нет.</Empty>}
      {days.map(day=><section className="weather-stack" key={day}>
        <h3 className="weather-section-title">{day?marketDay(day):"Дата уточняется"}</h3>
        <div className="run weather-rows">{openPositions.filter(p=>(p.market_day??"")===day).map(p=><Row key={p.strategy+"/"+p.token}
          title={cityName(p.city)+" · "+outcomeName(p.outcome)}
          note={<>{kindName(p.kind)} · {weatherStrategies[p.strategy]}
            {p.market_end!=null&&<><br/>{p.market_end>now?"Итог после "+dateTime(p.market_end)+" по Киеву":"Ожидаем итог Polymarket"}</>}
          </>}
          value={<><strong>{money(p.basis)}</strong><small>Вложено</small></>}
          onClick={()=>openPosition(p)}/>)}</div>
      </section>)}
      {feed.positions.length>openPositions.length&&<button className="text-action weather-start" onClick={()=>showHistory("open")}>Открытые ставки прошлых тестов</button>}
    </section>}
    {recentFills.length>0&&<section className="weather-stack">
      <h2 className="weather-section-title">Последние операции</h2>
      <div className="run weather-rows">{recentFills.map(f=><Row key={f.id}
        title={actionName[f.side]+" · "+cityName(f.city)+" · "+outcomeName(f.outcome)}
        note={weatherStrategies[f.strategy]+" · "+dateTime(f.at)+" по Киеву"}
        value={f.pnl==null?money(f.gross+f.fee):<Result value={f.pnl}/>} onClick={()=>openFill(f)}/>)}</div>
      <button className="text-action weather-start" onClick={()=>showHistory("sells")}>Все продажи и выплаты</button>
    </section>}
  </div>;
}
export function StrategyResults({feed,run,banks,now,open}:{feed:Feed;run?:Run;banks:Bank[];now:number;open:(id:WeatherStrategy)=>void}) {
  if(!banks.length)return <Empty>Сравнение появится после запуска эксперимента.</Empty>;
  const summary=weatherStrategyGroups.flatMap(group=>banks.filter(bank=>group.strategies.includes(bank.strategy)).map(bank=>({
    bank,group:group.label,...metrics(bank,feed,now),status:strategyStatus(bank.strategy,bank,run,feed,now),
  })));
  return <div className="weather-stack">
    <p className="muted">У каждой стратегии свой банк. Доходность считается от стартового банка.</p>
    <div className="weather-comparison-table run"><table>
      <caption className="sr-only">Сравнение виртуальных банков</caption>
      <thead><tr><th scope="col">Стратегия</th><th scope="col">Старт / свободно</th><th scope="col">Вложено</th><th scope="col">Реализовано</th>
        <th scope="col">По открытым</th><th scope="col">Общий итог</th><th scope="col">Доходность</th><th scope="col">Открыто / покупки / продажи</th></tr></thead>
      <tbody>{summary.map(({bank,group,unrealized,total,status})=><tr key={bank.strategy}>
        <th scope="row"><button className="text-action" onClick={()=>open(bank.strategy)}>{weatherStrategies[bank.strategy]}</button><small>{group} · {status}</small></th>
        <td>{money(bank.initial)} / {money(bank.cash)}</td><td>{money(bank.locked)}</td><td><Result value={bank.realized}/></td><td><Result value={unrealized}/></td><td><Result value={total}/></td>
        <td>{total==null?"Нет оценки":pct(total/bank.initial)}</td><td>{bank.open} / {bank.buys} / {bank.sells}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="weather-comparison">{summary.map(({bank,group,unrealized,total,status})=>{
      return <article className="run weather-comparison-row" key={bank.strategy}>
        <Row title={weatherStrategies[bank.strategy]} note={group+" · "+status} onClick={()=>open(bank.strategy)}/>
        <Facts items={[["Стартовый банк",money(bank.initial)],["Свободно",money(bank.cash)],["Вложено",money(bank.locked)],["Открыто",bank.open],["Реализовано",<Result value={bank.realized}/>],
          ["По открытым",<Result value={unrealized}/>],["Общий итог",<Result value={total}/>],["Доходность",total==null?"Нет оценки":pct(total/bank.initial)],
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
    {feed.notifications&&<StorageStatus/>}
    <article className="run"><h3>Исполнение по Polymarket</h3>
      <p>Источник · {sourceName[source as keyof typeof sourceName]??"Ожидание данных"}</p>
      <p>WebSocket · {view?.ws.socket?(view.ws.route==="neon"?"Подключён через Neon":"Подключён напрямую"):"Ожидает подключения"} · {view?.ws.subscribed??0} контрактов</p>
      {view?.ws.lastQuote&&<p>Последнее сообщение Polymarket · {dateTime(view.ws.lastQuote)} по Киеву</p>}
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
