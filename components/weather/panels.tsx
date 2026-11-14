"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, ChevronRight } from "lucide-react";
import { weatherStrategies, risk, type WeatherStrategy } from "../../lib/weather/strategies";
import { dateTime, money, walletLink } from "../trade-journal";
import { exits, lessons } from "./education";
import { actionName,cash,cityName,currentMark,kindName,liquidValue,marketDay,marketUrl,metrics,modelName,needsStream,pct,pnl,price,qty,quoteIssue,reasonText,sourceName,strategyStatus,tone,
  type Bank,type Decision,type Feed,type Mark,type PositionDetail,type Run,type Evidence } from "./data";

export function Sheet({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=ref.current;
    dialog?.showModal();
    const previous=document.body.style.overflow;
    document.body.style.overflow="hidden";
    return ()=>{dialog?.close();document.body.style.overflow=previous;};
  },[]);
  return <dialog ref={ref} className="weather-sheet" aria-labelledby="weather-sheet-title"
    onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current)onClose();}}>
    <div className="weather-sheet-inner"><header className="weather-sheet-head">
      <button autoFocus className="text-action" onClick={onClose}><ArrowLeft size={17}/> Назад</button>
      <h2 id="weather-sheet-title">{title}</h2>
    </header><div className="weather-sheet-body">{children}</div></div>
  </dialog>;
}

export function Facts({items}:{items:[string,ReactNode][]}) {
  return <dl className="weather-kpis">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function Result({value}:{value:number|null}) {return <span className={tone(value)}>{pnl(value)}</span>;}
export function Empty({children}:{children:ReactNode}) {return <p className="weather-empty muted">{children}</p>;}
export function Row({title,note,value,onClick}:{title:string;note?:ReactNode;value?:ReactNode;onClick:()=>void}) {
  return <button className="weather-row" onClick={onClick}>
    <span><strong>{title}</strong>{note!=null&&<small>{note}</small>}</span>{value!=null&&<span className="weather-row-value">{value}</span>}
    <ChevronRight aria-hidden size={17}/></button>;
}
export function StrategyPanel({strategy,bank,run,feed,now,busy,onToggle,showJournal}:{
  strategy:WeatherStrategy;bank?:Bank;run?:Run;feed:Feed;now:number;busy:boolean;
  onToggle:(paused:boolean)=>Promise<boolean>;showJournal:()=>void;
}) {
  const [confirm,setConfirm]=useState(false);
  const item=lessons[strategy];
  const {unrealized,total}=bank?metrics(bank,feed,now):{unrealized:null,total:null};
  const cfg=run?.configuration;
  const editable=!!bank&&!!run&&run.status!=="stopped"&&+new Date(run.ends_at)>now&&strategy!=="complete";
  const wallet=strategy.includes("wallet")||strategy.startsWith("replay_");
  const parameters:[string,ReactNode][]=[
    ["Задержка",strategy.startsWith("replay_")?strategy.split("_")[1]+" с":strategy==="complete"?"Наблюдение":(cfg?.delay??risk.delay)/1000+" с"],
    ["Максимальный спред",strategy==="complete"?"По стоимости комплекта":price(cfg?.spread??risk.spread)],
    ["Лимит на позицию",strategy==="complete"?"Нет покупок":money(cfg?.cost??risk.cost)],
    ["Лимит вложений",strategy==="complete"?"Нет покупок":money(cfg?.exposure??risk.exposure)],
    ["Минимальное преимущество",strategy==="tail"?"Сигнал >4,5¢":strategy==="observation"?"Полная цена NO <95¢":strategy==="complete"?"Выплата выше цены":strategy==="favorite"||strategy.startsWith("replay_")?"Свой критерий":">"+price(cfg?.edge??risk.edge)],
    ["Источник",strategy==="complete"||needsStream(strategy)?"WebSocket":"WebSocket или REST"],
    ["Данные кошельков",wallet?"Использует":"Не использует"],
    ["Погодные модели",["favorite","complete","observation"].includes(strategy)||strategy.startsWith("replay_")?"Не обязательны для входа":"ECMWF IFS, GFS, ICON и ансамбль при наличии"],
  ];
  return <>
    <section className="run"><h3>{item.plain}</h3><p className="muted">{strategyStatus(strategy,bank,run,feed,now)}</p>
      {editable&&<div className="weather-controls">
        <p><strong>{bank.entries_paused?"Новые входы приостановлены":"Новые входы включены"}</strong></p>
        {confirm?<div className="weather-confirm" role="group" aria-label="Подтверждение действия">
          <p>{bank.entries_paused?"Разрешить новые покупки этой стратегии?":"Приостановить новые покупки? Открытые позиции продолжат сопровождаться."}</p>
          <button className="action" disabled={busy} onClick={async()=>{if(await onToggle(!bank.entries_paused))setConfirm(false);}}>Подтвердить</button>
          <button className="text-action" disabled={busy} onClick={()=>setConfirm(false)}>Отмена</button>
        </div>:<button className="action secondary" disabled={busy} onClick={()=>setConfirm(true)}>{bank.entries_paused?"Возобновить":"Приостановить"}</button>}
      </div>}
    </section>
    <section className="run"><h3>Результаты стратегии</h3>
      {bank?<Facts items={[
        ["Стартовый банк",money(bank.initial)],["Свободно",money(bank.cash)],["Вложено",money(bank.locked)],
        ["Реализовано",<Result value={bank.realized}/>],["Открытые позиции",<Result value={unrealized}/>],["Общий PnL",<Result value={total}/>],
        ["Сигналы",bank.total],["Покупки / продажи",bank.buys+" / "+bank.sells],["Открыто / закрыто",bank.open+" / "+bank.closed],
        ["Доля прибыльных",bank.closed?pct(bank.wins/bank.closed):"Нет закрытых"],["Комиссии",money(bank.fees)],
        ["Макс. просадка",money(bank.max_drawdown)],["Последняя запись",bank.last?dateTime(bank.last):"Записей пока нет"],
      ]}/>:<Empty>Статистика появится после запуска.</Empty>}
      {bank?.last_reason&&<p className="muted">Последняя причина · {reasonText(bank.last_reason)}</p>}
      {(!bank || bank.closed<20)&&<p className="muted">Пока недостаточно независимых завершённых сделок для оценки прибыльности стратегии.</p>}
      {bank&&<button className="text-action" onClick={showJournal}>История стратегии</button>}
    </section>
    <section className="run"><h3>Как работает</h3><dl className="weather-explain">
      <dt>Данные</dt><dd>{item.inputs}</dd><dt>Что считает</dt><dd>{item.calc}</dd>
      <dt>Когда входит</dt><dd>{item.entry}</dd><dt>Когда выходит</dt><dd>{exits(strategy)}</dd>
      <dt>Когда пропускает</dt><dd>{item.skip}</dd></dl></section>
    <section className="run"><h3>Параметры {cfg?"эксперимента":"по умолчанию"}</h3><Facts items={parameters}/>
    </section>
    <section className="run"><h3>Учебный пример</h3><p>{item.example}</p><p className="muted">{exits(strategy)} Пример не входит в статистику.</p></section>
  </>;
}

function ModelValues({evidence}:{evidence?:Evidence}) {
  const models=evidence?.estimate?.forecasts??[];
  return models.length>0?<ul className="weather-plain-list">{[...new Set(models.map(row=>row.model))].map(model=>{
    const values=models.filter(row=>row.model===model);
    const low=Math.min(...values.map(row=>row.value)),high=Math.max(...values.map(row=>row.value));
    return <li key={model}>{modelName(model)} · {low.toFixed(1)}{low!==high?"…"+high.toFixed(1):""} °C</li>;
  })}</ul>:<Empty>Прогнозы для этой записи не сохранены.</Empty>;
}
function BookEvidence({evidence}:{evidence:Evidence}) {
  const books=[["На момент сигнала",evidence.signalBook],["Проверка после задержки",evidence.executionBook]] as const;
  return <>{books.map(([label,q])=>q&&<details className="trade-details" key={label}><summary>{label} · {q.book.receivedAt?dateTime(q.book.receivedAt):"время не сохранено"}</summary>
    <p>{q.book.source==="rest"?"Снимок REST":"WebSocket"}{evidence.compact?" · краткая запись": " · уровней покупателей "+(q.book.bids?.length??0)+" · продавцов "+(q.book.asks?.length??0)}</p>
    {q.rest&&<p>Запрос {new Date(q.rest.requestedAt).toISOString()} · ответ {new Date(q.rest.receivedAt).toISOString()}</p>}
    <p>Покупатель предлагал {price(q.book.bids?.[0]?.price)} · продавец просил {price(q.book.asks?.[0]?.price)}</p>
    {!evidence.compact&&<details><summary>Цены и объёмы сохранённых уровней</summary><div className="weather-depth">
      {[["Покупатели",q.book.bids],["Продавцы",q.book.asks]].map(([side,levels])=><div key={String(side)}><strong>{String(side)}</strong>
        {Array.isArray(levels)&&levels.map(level=><p key={level.price}>{price(level.price)} · {qty(level.size)}</p>)}</div>)}
    </div></details>}
  </details>)}</>;
}
function SaleDetail({fill}:{fill:PositionDetail["fills"][number]}) {
  const evidence=fill.evidence;
  const net=fill.gross-fill.fee;
  const sold=fill.side==="SELL";
  const actualNet=net/fill.shares;
  const basis=fill.basis/fill.shares;
  const fair=evidence.executionFair??evidence.fair;
  const upper=evidence.executionUpper??evidence.modelUpper;
  return <section className="weather-sale">
    <p><strong>{actionName[fill.side]} · {dateTime(fill.at)} по Киеву</strong></p>
    <p>{sold?reasonText(evidence.reason??""):"Polymarket подтвердил выплату по исходу."}</p>
    {sold&&evidence.reason==="FAIR_VALUE_EXIT"&&fair!=null&&<p>
      Модель оценивала удержание в {price(fair)} за контракт. Доступная продажа принесла {price(actualNet)} после комиссии при себестоимости {price(basis)}.
      {evidence.policy&&actualNet<basis&&upper!=null? " Для продажи в минус использована верхняя оценка модели "+price(upper)+".":""}
    </p>}
    {sold&&evidence.reason==="FORECAST_REVERSAL_RISK"&&<p>Оценка упала с {price(evidence.entryFair)} до {price(fair)}. Продажа ограничила дальнейший риск.</p>}
    {sold&&evidence.reason==="REPRICING_TARGET"&&<p>Чистая цена вышла выше себестоимости на {price(actualNet-basis)} за контракт.</p>}
    {sold&&evidence.walletSell&&<p>Обнаружена продажа кошелька {evidence.walletSell.name} по {price(evidence.walletSell.price)}.</p>}
    <Facts items={[
      [sold?"Цена продажи":"Выплата за контракт",price(fill.gross/fill.shares)],["Контракты",qty(fill.shares)],
      ["Комиссия выхода",money(fill.fee)],["Получено чистыми",money(net)],
      ["Себестоимость закрытой части",money(fill.basis)],["Зафиксировано",<Result value={fill.pnl}/>],
    ]}/>
    {sold&&evidence.fill?.partial&&<p>Исполнена доступная часть. Остаток продолжил отслеживаться.</p>}
  </section>;
}

function saleAvailability(mark:Mark|null,previous:Mark|null,now:number,online:boolean) {
  if(mark?.reason==="PARTIAL"||mark?.reason==="FULL") return null;
  if(mark?.reason==="NO_BUYERS") return "Стакан свежий, но покупателей этого контракта сейчас нет.";
  if(mark?.reason==="POSITION_BELOW_MINIMUM") return "Остаток меньше минимального объёма заявки ("+qty(mark.minimum??0)+" шт.).";
  if(mark?.reason==="DEPTH_BELOW_MINIMUM") return "Покупатели есть, но их общий объём меньше минимальной заявки ("+qty(mark.minimum??0)+" шт.).";
  if(mark?.reason==="UNVERIFIED_LEVELS") return "Полученные заявки не прошли проверку допустимой цены и объёма.";
  if(!online) return "Сборщик пока не подтверждает свежие котировки.";
  if(!mark&&previous&&now-previous.at>75_000) return "Проверка этого контракта устарела. Ждём следующий снимок.";
  return quoteIssue(mark?.quote,now) ?? "Объём для продажи ещё не подтверждён.";
}

export function PositionPanel({detail,now,fillId,feedOnline}:{detail:PositionDetail;now:number;fillId?:string;feedOnline:boolean}) {
  const {position:p,fills,live,timeline}=detail;
  const open=p.closed_at==null;
  const buy=fills.find(f=>f.side==="BUY");
  const selected=fills.find(f=>f.id===fillId);
  const ev=buy?.evidence;
  const c=ev?.candidate;
  const contract=p.market.contracts.find(x=>x.yes===p.token||x.no===p.token);
  const probability=live?.distribution.find(x=>x.condition===contract?.condition);
  const current=probability&&contract?(contract.yes===p.token?probability.p:1-probability.p):null;
  const mark=feedOnline?currentMark(detail.mark,p,now):null;
  const liquidation=liquidValue(mark,p);
  const saleIssue=saleAvailability(mark,detail.mark,now,feedOnline);
  const available=mark?.fill;
  const freshQuote=mark&&!quoteIssue(mark.quote,now)?mark.quote:null;
  const purchaseReason=reasonText(ev?.reason??c?.reason??"");
  const contractPayout=contract?.payout?.[contract.yes===p.token?0:1];
  const last=timeline.findLast(row=>row.action==="HOLD"||row.action==="SELL"||row.action==="SKIP");
  const marketAtEntry=ev?.estimate?.distribution.find(x=>x.condition===contract?.condition)?.market;
  const entryProbability=p.strategy==="favorite"?marketAtEntry:c?.probability;
  type Step={key:string;at:number;label:string;detail?:string;proof?:Evidence};
  const steps:Step[]=[];
  for(const fill of fills) {
    if(fill.side==="BUY"&&fill.evidence.at!=null) steps.push({key:fill.id+"signal",at:fill.evidence.at,label:"Обнаружен сигнал",detail:reasonText(fill.evidence.reason??fill.evidence.candidate?.reason??"")});
    if(fill.evidence.executionBook) steps.push({key:fill.id+"book",at:fill.evidence.executionBook.book.receivedAt,label:"Проверен стакан",proof:fill.evidence});
    steps.push({key:fill.id,at:+new Date(fill.at),label:actionName[fill.side],detail:qty(fill.shares)+" шт. · "+price(fill.gross/fill.shares)+(fill.pnl==null?"":" · "+pnl(fill.pnl))});
  }
  for(const item of timeline) if(item.action==="HOLD"||item.action==="SKIP"||item.action==="SELL"&&(item.reason==="PUBLIC_WALLET_SELL"||item.reason==="FAIR_VALUE_EXIT"||item.reason==="REPRICING_TARGET"||item.reason==="FORECAST_REVERSAL_RISK")) {
    steps.push({key:item.id,at:item.evaluated_at?Number(item.evaluated_at):+new Date(item.at),label:actionName[item.action]??"Решение",detail:reasonText(item.reason)});
  }
  return <>
    <section className="run weather-position-summary"><h3>{p.outcome} · {marketDay(p.market.date)}</h3>
      <p>{kindName(p.market.kind)} · {p.market.station.code}</p>
      <p className="muted">{weatherStrategies[p.strategy]} · {open?"Открыта":"Закрыта"}</p>
      <p><strong>Почему открылась</strong> · {purchaseReason}{c?.wallet?" · "+c.wallet.name:""}</p>
      {buy&&<p>Вход {dateTime(buy.at)} по Киеву · {price(buy.gross/buy.shares)} за контракт · {money(buy.basis)} с комиссией</p>}
      <a className="weather-link" href={marketUrl(p.market,contract?.slug)} target="_blank" rel="noreferrer">Открыть рынок на Polymarket <ArrowUpRight size={14}/></a>
      {selected?.side==="BUY"&&<div className="weather-inline"><strong>{actionName[selected.side]} · {dateTime(selected.at)}</strong><p>{price(selected.gross/selected.shares)} · {qty(selected.shares)} шт. · комиссия {money(selected.fee)}</p></div>}
    </section>
    {fills.some(fill=>fill.side!=="BUY")&&<section className="run"><h3>{open?"Почему продали часть позиции":"Почему закрыли позицию"}</h3>
      {(selected&&selected.side!=="BUY"?[selected]:fills.filter(fill=>fill.side!=="BUY")).map(fill=><SaleDetail key={fill.id} fill={fill}/>)}
    </section>}
    {open&&<section className="run"><h3>Когда закроется</h3>
      <p>{contractPayout!=null ? "Polymarket опубликовал исход. Бот проведёт расчёт позиции."
        : now>=p.market.end ? "Местные сутки закончились. Бот ждёт официальный исход Polymarket."
        : "Бот может продать раньше, если правило выхода подтвердится по свежим заявкам покупателей."}</p>
      <p><strong>Конец погодных суток</strong> · {dateTime(p.market.end)} по Киеву. Официальный расчёт может прийти позже.</p>
      <p className="muted">{last?"Последняя запись · "+reasonText(last.reason)+" · "+dateTime(last.at):"Записей о решении по выходу пока нет."}</p>
      <details className="trade-details"><summary>Условия выхода</summary><p>{exits(p.strategy)}</p></details>
    </section>}
    {open&&<section className="run"><h3>Сколько можно получить</h3>
      <Facts items={[
        ["Вложено в остаток",money(p.basis)],["Контрактов осталось",qty(p.shares)],
        ["Если выиграет · выплата",money(p.shares)],["Если выиграет · прибыль",<Result value={p.shares-p.basis}/>],
        ["Если проиграет · результат",<Result value={-p.basis}/>],["Уже зафиксировано",<Result value={p.realized}/>],
      ]}/>
      <h4>Если продать по последней проверке</h4>
      {liquidation!=null?<Facts items={[["Получили бы чистыми",money(liquidation)],["Результат по остатку",<Result value={liquidation-p.basis}/>]]}/>
        :<p className="weather-inline">{available?.partial ? "Доступна частичная продажа. За "+qty(available.shares)+" из "+qty(p.shares)+" контрактов покупатели предложили бы "+money(available.gross-available.fee)+" после комиссии."
          :saleIssue}</p>}
      {mark?.quote.at!=null&&<p className="muted">Снимок котировок · {dateTime(mark.quote.at)} по Киеву · {mark.quote.source?sourceName[mark.quote.source]:"Polymarket"}</p>}
      <details className="trade-details"><summary>Цены, объём и комиссия продажи</summary>
        <Facts items={[
          ["Цена покупателя (bid)",freshQuote?freshQuote.bid==null?"Покупателей нет":price(freshQuote.bid):"Не подтверждена"],
          ["Цена продавца (ask)",freshQuote?freshQuote.ask==null?"Продавцов нет":price(freshQuote.ask):"Не подтверждена"],
          ["Объём покупателей",mark?.depth==null?"Не подтверждён":qty(mark.depth)+" шт."],
          ["Комиссия продажи",available?money(available.fee):"Пока неизвестна"],
        ]}/>
        <p className="muted">Bid показывает, по какой цене у вас готовы купить. Ask показывает, по какой цене вам готовы продать. При сделке на несколько контрактов бот учитывает цены и объёмы всех использованных заявок.</p>
      </details>
    </section>}
    <section className="run"><details className="trade-details"><summary>Данные на входе</summary>
      <Facts items={[["Вероятность при покупке",pct(entryProbability)],["Последняя оценка модели",pct(current)],
        ["Консервативная оценка",c?.reason==="OBSERVED_RANGE_EXCLUDED"?"95% · порог правила":pct(c?.conservative)],
        ["Цена продавца в момент сигнала",price(c?.reference)],["Преимущество после расходов",price(c?.ev)],
        ["Комиссия покупки",buy?money(buy.fee):"Нет записи"]]}/>
      {live&&<p className="muted">Оценка модели от {dateTime(live.at)} по Киеву.</p>}
      <ModelValues evidence={ev}/>
      {c?.wallet&&<p>Кошелёк в сигнале · <a className="weather-link" href={walletLink(c.wallet.wallet)} target="_blank" rel="noreferrer">{c.wallet.name}</a> · {price(c.wallet.price)} · {dateTime(c.wallet.receivedAt)}</p>}
      {ev&&<BookEvidence evidence={ev}/>}
    </details></section>
    <section className="run"><details className="trade-details"><summary>История позиции</summary><ol className="weather-timeline">
      {steps.sort((a,b)=>a.at-b.at).map(step=><li key={step.key}><small>{dateTime(step.at)} по Киеву</small>
        <strong>{step.label}</strong>{step.detail&&<p>{step.detail}</p>}{step.proof&&<BookEvidence evidence={step.proof}/>}</li>)}
    </ol></details></section>
  </>;
}

export function DecisionPanel({row}:{row:Decision}) {
  const c=row.evidence.candidate;
  return <><section className="run"><h3>{reasonText(row.reason)}</h3>
    <p>{cityName(row.market.station.city)} · {kindName(row.market.kind)} · {dateTime(row.at)}</p>
    {c&&<Facts items={[["Исход",(c.yes?"YES ":"NO ")+c.contract.bucket.label],["Оценка",pct(c.probability)],
      ["Ask",price(c.reference)],["Преимущество",price(c.ev)]]}/>}
    <a className="weather-link" href={marketUrl(row.market,c?.contract.slug)} target="_blank" rel="noreferrer">Открыть рынок на Polymarket <ArrowUpRight size={14}/></a>
  </section><section className="run"><h3>Данные решения</h3><ModelValues evidence={row.evidence}/><BookEvidence evidence={row.evidence}/></section></>;
}
