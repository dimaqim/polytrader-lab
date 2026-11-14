import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { takerFee } from "../../lib/simulator";
import type { Contract, WalletEvent, WeatherEvent } from "../../lib/weather/types";
import { dateTime, walletLink } from "../trade-journal";
import { cityName,kindName,marketDay,marketUrl,modelName,pct,price,qty,quoteIssue,sourceName,timeLeft,type Quote,type View } from "./data";
import { Empty } from "./panels";
import { glossary } from "./education";

export function MarketCard({event,live,held,now}:{event:WeatherEvent;live?:View;held:string[];now:number}) {
  const [all,setAll]=useState(false);
  const ranked=[...event.contracts].sort((a,b)=>(live?.distribution.find(x=>x.condition===b.condition)?.p??-1)
    -(live?.distribution.find(x=>x.condition===a.condition)?.p??-1));
  const displayed=all?ranked:ranked.filter((c,i)=>{
    const row=live?.distribution.find(p=>p.condition===c.condition);
    const book=live?.books.find(b=>b.condition===c.condition);
    const yes=book?.yes&&!quoteIssue(book.yes,now)?book.yes.ask:null;
    const no=book?.no&&!quoteIssue(book.no,now)?book.no.ask:null;
    const edge=row&&c.fee&&live?.confidence&&(
      yes!=null&&row.low-yes-takerFee(1,yes,c.fee)>.045 || no!=null&&1-row.high-no-takerFee(1,no,c.fee)>.045);
    return i<3||edge||held.includes(c.yes)||held.includes(c.no);
  });
  const yields=live?.forecasts??[];
  const models=[...new Set(yields.map(row=>row.model))];
  const mostLikely=ranked[0];
  const range=mostLikely&&live?.distribution.length?mostLikely.bucket.label:"Ожидается прогноз";
  return <article className="run weather-market">
    <header><div><h3>{cityName(event.station.city)}</h3><p>{kindName(event.kind)} · <time dateTime={event.date}>{marketDay(event.date)}</time></p></div>
      <span className={"trade-state "+(event.verified?"active":"loss")}>{event.verified?(live?.confidence?"Прогноз готов":"Наблюдение"):"Правила проверяются"}</span></header>
    <div className="weather-kpis weather-market-facts">
      <div><small>Станция</small><strong>{event.station.code}</strong></div>
      <div><small>{event.kind==="highest"?"Измеренный максимум":"Измеренный минимум"}</small><strong>{live?.observed==null?"Нет замера":live.observed.toFixed(1)+" °C"}</strong></div>
      <div><small>Самый вероятный диапазон</small><strong>{range}</strong></div>
      <div><small>До конца местного дня</small><strong>{event.end>now?timeLeft(event.end,now):"День завершён"}</strong></div>
    </div>
    {held.length>0&&<p className="weather-inline">Открытые позиции отмечены у исходов ниже.</p>}
    <details className="trade-details"><summary>Что прогнозируют модели</summary>
      {!models.length&&<Empty>Для этого события данные моделей ещё не получены.</Empty>}
      {models.map(model=>{
        const ranges=yields.filter(x=>x.model===model);
        const low=Math.min(...ranges.map(x=>x.value)),high=Math.max(...ranges.map(x=>x.value));
        const calibration=live?.calibration.find(x=>x.model===model);
        return <div className="weather-model" key={model}><strong>{modelName(model)}</strong><p>{low.toFixed(1)}{low!==high?"…"+high.toFixed(1):""} °C
          {model.startsWith("ecmwf")&&ranges.length>1?" · включая ансамбль":""}</p>
          {calibration&&<small>Историческая погрешность около {calibration.sigma.toFixed(1)} °C по {calibration.n} наблюдениям.</small>}
        </div>;
      })}
      <p className="muted">Комбинированная оценка для каждого диапазона состоит из 25% оценки погоды и 75% оценки рынка. Модельные стратегии для входа проверяют свою консервативную оценку.</p>
    </details>
    <div className="weather-outcomes"><h4>{all?"Все исходы":"Наиболее вероятные исходы"}</h4>
      {displayed.map(c=><Outcome key={c.condition} contract={c} live={live} now={now} held={held}/>)}
      {ranked.length>displayed.length||all&&ranked.length>3?<button className="text-action" onClick={()=>setAll(!all)}>{all?"Свернуть исходы":"Показать все исходы"}</button>:null}
    </div>
    <p className="weather-links"><a className="weather-link" href={event.source} target="_blank" rel="noreferrer">Метеостанция <ArrowUpRight size={13}/></a>
      <a className="weather-link" href={marketUrl(event)} target="_blank" rel="noreferrer">Polymarket <ArrowUpRight size={13}/></a></p>
    <details className="trade-details"><summary>Правила официального расчёта</summary><p className="weather-rules">{event.rules}</p></details>
  </article>;
}
function Outcome({contract:c,live,now,held}:{contract:Contract;live?:View;now:number;held:string[]}) {
  const p=live?.distribution.find(row=>row.condition===c.condition);
  const pair=live?.books.find(row=>row.condition===c.condition);
  const coverage=live?.marketCoverage;
  const yesIssue=quoteIssue(pair?.yes,now);
  const noIssue=quoteIssue(pair?.no,now);
  const marketIssue = coverage && coverage.priced<coverage.total
    ? "Свежие цены покупки и продажи есть у "+coverage.priced+" из "+coverage.total+" исходов."
    : coverage && !coverage.coherent ? "Цены разных исходов пришли из разных источников."
    : p?.market!=null ? "Последняя рыночная оценка устарела."
    : coverage ? "Цены исходов не прошли проверку общего распределения."
    : "Для рыночной оценки нужны свежие цены покупки и продажи всех исходов.";
  return <details className="weather-outcome"><summary>
    <span><strong>{c.bucket.label}</strong>{held.includes(c.yes)||held.includes(c.no)?<small> · Есть позиция</small>:null}</span>
    <span>{pct(p?.p)}</span></summary>
    <p><strong>Прогноз погоды</strong> · {pct(p?.p)}</p>
    {p?.market!=null && live && now-live.at<=75_000
      ? <p>Оценка по ценам рынка · {pct(p.market)} · Комбинированная · {pct(p.blended)}</p>
      : <p className="muted">Рыночная и комбинированная оценки пока недоступны. {marketIssue}</p>}
    {yesIssue&&yesIssue===noIssue ? <p className="weather-inline">{yesIssue}. Цены YES и NO пока не подтверждены.</p> :
      ([["YES",pair?.yes,yesIssue],["NO",pair?.no,noIssue]] as const).map(([side,quote,issue])=>
        <OutcomeQuote key={side} side={side} quote={quote} issue={issue}/>)}
  </details>;
}
function OutcomeQuote({side,quote,issue}:{side:string;quote?:Quote;issue:string|null}) {
  return <p><strong>{side}</strong> · {issue ? issue :
    (quote?.ask==null?"Продавцов нет":"Купить за "+price(quote.ask))+" · "+
    (quote?.bid==null?"Покупателей нет":"Продать за "+price(quote.bid))}
    {!issue&&quote?.source&&quote.at!=null&&<small> · {sourceName[quote.source]} · {dateTime(quote.at)}</small>}
  </p>;
}
export function Wallets({wallets,events,markets}:{wallets:{name:string;address:string}[];events:WalletEvent[];markets:WeatherEvent[]}) {
  return <div className="weather-stack"><div className="run"><h3>Как используются кошельки</h3>
    <dl className="weather-explain"><dt>Погодная модель</dt><dd>Оценивает исход по прогнозам и наблюдениям.</dd>
      <dt>Подтверждение кошельком</dt><dd>Требует погодное преимущество и публичную покупку того же исхода.</dd>
      <dt>Wallet Replay</dt><dd>Пробует повторить наблюдаемую сделку с задержкой и проверкой реальной ликвидности. Видна публичная активность кошелька.</dd></dl></div>
    {wallets.map(wallet=><details className="run weather-wallet" key={wallet.address}><summary><strong>{wallet.name}</strong><small>{wallet.address.slice(0,8)}…{wallet.address.slice(-6)}</small></summary>
      <a className="weather-link" href={walletLink(wallet.address)} target="_blank" rel="noreferrer">Профиль Polymarket <ArrowUpRight size={14}/></a>
      {events.filter(e=>e.wallet===wallet.address).slice(-10).reverse().map(e=>{
        const market=markets.find(m=>m.contracts.some(c=>c.condition===e.condition));
        const c=market?.contracts.find(c=>c.condition===e.condition);
        return <div className="weather-model" key={e.id}><strong>{e.side==="BUY"?"Покупка":e.side==="SELL"?"Продажа":e.type} · {c?(c.yes===e.token?"YES ":"NO ")+c.bucket.label:"Исход не сопоставлен"}</strong>
          <p>{market?cityName(market.station.city)+" · "+kindName(market.kind):"Рынок вне текущего каталога"} · {price(e.price)} · {qty(e.shares)} шт.</p>
          <small>Обнаружено {dateTime(e.receivedAt)} по Киеву</small>
          {market&&<p><a className="weather-link" href={marketUrl(market,c?.slug)} target="_blank" rel="noreferrer">Рынок <ArrowUpRight size={13}/></a></p>}
        </div>;
      })}
      {!events.some(e=>e.wallet===wallet.address)&&<Empty>В текущем списке погодных действий записей нет.</Empty>}
    </details>)}
    {!wallets.length&&<Empty>Сборщик ещё не подтвердил публичные профили.</Empty>}
  </div>;
}
export function Guide() {
  return <div className="weather-stack"><article className="run"><h3>Как бот принимает решения</h3>
    <ol className="weather-timeline"><li>Читает исходы и правила метеостанции.</li><li>Сравнивает прогнозы с измерениями и ценами.</li>
      <li>Проверяет условия выбранной стратегии, комиссию и лимиты банка.</li><li>После задержки проверяет стакан повторно и записывает исполнение или причину пропуска.</li></ol></article>
    {glossary.map(([name,text])=><details className="run" key={name}><summary>{name}</summary><p>{text}</p></details>)}
    <details className="run"><summary>Формулы</summary><p>Преимущество модельного сигнала = консервативная вероятность × $1 − ask − комиссия на контракт.</p>
      <p>Нереализованный PnL = чистая выручка по доступным bid для всего остатка − его себестоимость.</p>
      <p>Общий PnL = реализованный + нереализованный. ROI = общий PnL ÷ стартовый банк.</p></details>
  </div>;
}
