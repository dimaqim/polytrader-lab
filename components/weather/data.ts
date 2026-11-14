import type { PaperFill } from "../../lib/weather/execution";
import type { Candidate, WeatherStrategy } from "../../lib/weather/strategies";
import type { Estimate, ExecutionSource, LiveBook, WalletEvent, WeatherEvent } from "../../lib/weather/types";
import { money, resultMoney } from "../trade-journal";

export type Run = { id:string; status:string; starts_at:string; ends_at:string; configuration?:{cost:number;exposure:number;drawdown:number;delay:number;spread:number;edge:number} };
export type Bank = { experiment:string; strategy:WeatherStrategy; cash:number; initial:number; realized:number; max_drawdown:number;
  risk_blocked:boolean; entries_paused:boolean; total:number; last:string|null; last_reason:string|null;
  locked:number; open:number; events:number; wins:number; closed:number; fees:number; buys:number; sells:number };
export type Quote = { bid:number|null;ask:number|null;at?:number;source?:ExecutionSource };
export type Mark = { experiment:string;strategy:WeatherStrategy;token:string;shares:number;basis:number;at:number;quote:Quote;
  depth:number;fill:PaperFill|null };
export type Position = { experiment:string;strategy:WeatherStrategy;token:string;event:string;city:string;kind:string;outcome:string;
  shares:number;basis:number;realized:number;original_cost?:number;price:number|null;opened_at:string;closed_at:string|null };
export type Evidence = { reason?:string;at?:number;policy?:string;fair?:number|null;modelUpper?:number;
  executionFair?:number;executionUpper?:number;netPerShare?:number|null;basisPerShare?:number;entryFair?:number|null;candidate?:Candidate;estimate?:Estimate;delayMs?:number;readyAt?:number;source?:ExecutionSource;
  signalBook?:LiveBook;executionBook?:LiveBook;fill?:PaperFill;walletSell?:WalletEvent;payout?:number;checkedAt?:number };
export type Fill = { id:string;experiment:string;strategy:WeatherStrategy;token:string;event:string;city:string;kind:string;outcome:string;
  side:"BUY"|"SELL"|"SETTLE";at:string;shares:number;gross:number;fee:number;basis:number;pnl:number|null;evidence:Evidence;source?:ExecutionSource };
export type Decision = { id:string;experiment:string|null;strategy:WeatherStrategy|"system";city:string;kind:string;event:string;
  at:string;action:string;reason:string;reference:string|null;ev:string|null;market:WeatherEvent;evidence:Evidence };
export type Readiness = { ready:boolean;process:boolean;source?:ExecutionSource;rest?:{lastResponse:number|null;error:string|null};
  ws:{socket:boolean;subscribed:number;snapshots:number;updates:number;lastPong?:number|null;error:string|null};
  sources:Record<string,{ok:boolean;at:number;count?:number;error?:string}> };
export type View = Estimate & {event:string;books:{condition:string;yes?:Quote;no?:Quote}[]};
export type Feed = { readiness:{checked_at:string;payload:Readiness}|null;
  live:{data:View[];opportunities?:WeatherStrategy[];wallets:{name:string;address:string}[];walletEvents:WalletEvent[]}|null;
  marks:Mark[];markets:WeatherEvent[];runs:Run[];banks:Bank[];positions:Position[];fills:Fill[];decisions:Decision[];
  equity:{experiment:string;strategy:WeatherStrategy;at:string;equity:number|null}[];
  notifications:Record<"signals"|"fills"|"health"|"daily",boolean>|null };
export type PositionDetail={position:Position&{market:WeatherEvent};fills:Fill[];live:View|null;mark:Mark|null;
  timeline:{id:string;at:string;action:string;reason:string;evaluated_at:string|null;fair:string|null;net_bid:string|null;ready_at:string|null}[]};
export type JournalRow={id:string;experiment:string|null;strategy:WeatherStrategy|"system";token:string|null;event:string;city:string;kind:string;
  at:string;reason:string;outcome:string|null;price:number|null;amount:number|null;pnl:number|null;source:ExecutionSource|null;category:string};

export const cityName=(city:string)=>({Seoul:"Сеул",Tokyo:"Токио",London:"Лондон",Munich:"Мюнхен","New York City":"Нью-Йорк",Dallas:"Даллас"}[city]??city);
export const kindName=(kind:string)=>kind==="highest"?"Максимальная температура":kind==="lowest"?"Минимальная температура":"Температура";
export const price=(value:number|null|undefined)=>value==null?"—":(value*100).toLocaleString("ru",{maximumFractionDigits:2})+"¢";
export const pct=(value:number|null|undefined)=>value==null?"—":(value*100).toLocaleString("ru",{maximumFractionDigits:1})+"%";
export const qty=(value:number)=>value.toLocaleString("ru",{maximumFractionDigits:4});
export const cash=(value:number|null)=>value==null?"Нет оценки":money(value);
export const pnl=(value:number|null)=>value==null?"Нет оценки":resultMoney(value);
export const tone=(value:number|null)=>value==null||value===0?"":value>0?"profit":"loss";
export const sourceName:Record<ExecutionSource,string>={WEBSOCKET_L2:"WebSocket",REST_VERIFIED_PAPER:"Снимки REST",NO_EXECUTABLE_DATA:"Нет свежих котировок"};
export const marketUrl=(market:WeatherEvent,bucket?:string)=>"https://polymarket.com/event/"+encodeURIComponent(market.slug)+(bucket?"/"+encodeURIComponent(bucket):"");
export const modelName=(model:string)=>model.startsWith("ecmwf")?"ECMWF IFS":model.startsWith("gfs")?"GFS":"ICON";
export const timeLeft=(end:number,now=Date.now())=>{const h=Math.max(0,Math.ceil((end-now)/3600000));return h>=24?Math.floor(h/24)+" д "+h%24+" ч":h+" ч";};
export const actionName:Record<string,string>={BUY:"Покупка",SELL:"Продажа",SETTLE:"Официальный расчёт",HOLD:"Удержание",SKIP:"Пропуск",OPEN:"Открыта",CLOSED:"Закрыта"};
export const reasons:Record<string,string>={
  RULES_UNVERIFIED:"Правила расчёта ещё не подтверждены",STALE_BOOK:"Нет подтверждённого свежего стакана",SIGNAL_ONLY:"Записан сигнал, нужен WebSocket",
  REST_VERIFIED_PAPER:"Исполнение по двум снимкам REST",INSUFFICIENT_MODEL_CONFIDENCE:"Недостаточно погодных данных",
  NO_CONSERVATIVE_EDGE:"Преимущество после расходов не подтверждено",MARKET_FAVORITE:"Самый вероятный исход по рынку",
  PUBLIC_WALLET_BUY:"Обнаружена публичная покупка трейдера",PUBLIC_WALLET_SELL:"Обнаружена публичная продажа того же трейдера",
  OBSERVED_RANGE_EXCLUDED:"Зафиксированная температура исключила диапазон",CONSERVATIVE_DISTRIBUTION_EDGE:"Среди диапазонов найдено преимущество",
  WEATHER_VALUE:"Консервативная оценка выше полной цены",WEATHER_VALUE_AND_WALLET:"Погодное преимущество подтверждено покупкой трейдера",
  REMAINING_DAY_EDGE:"Прогноз на остаток дня даёт преимущество",CALIBRATED_TAIL_EDGE:"У недорогого YES есть преимущество после комиссии",
  FORECAST_REVISION_EXCEEDS_MARKET:"Модели изменили оценку сильнее рынка",FAIR_VALUE_EXIT:"Чистая цена продажи выше оценки удержания",
  FORECAST_REVERSAL_RISK:"Новый прогноз ухудшил оценку позиции",REPRICING_TARGET:"Достигнута цель переоценки",
  SETTLEMENT_HOLD:"Последняя проверка дала решение удерживать до расчёта",PAPER_FILLED:"Виртуальная покупка исполнена",
  PAPER_PARTIAL:"Исполнена доступная часть",PAPER_SELL_FILLED:"Виртуальная продажа исполнена",SETTLED:"Рынок рассчитан",
  PRICE_MOVED:"Цена изменилась после сигнала",NO_LIQUIDITY_OR_MINIMUM:"Недостаточно объёма по подходящей цене",
  COPY_EDGE_LOST:"Копирование пропущено: запаса после комиссии уже нет",EXIT_CONDITION_CHANGED:"Продажа пропущена: цена после задержки не подтвердила выход",
  RISK_REJECTED:"Ограничение риска или состояния теста",ENTRIES_PAUSED:"Новые входы приостановлены",
  PUBLIC_INVENTORY_UNVERIFIED:"Не подтверждён остаток позиции трейдера",COMPLETE_SET_MONITOR_ONLY:"Обнаружен комплект для наблюдения",
  CORRELATED_EVENT:"Этот банк уже использует связанный рынок станции и даты",DUPLICATE_POSITION:"Позиция по этому исходу уже была",
};
export const reasonText=(reason:string)=>reasons[reason]??actionName[reason]??"Причина не расшифрована";
export function currentMark(mark:Mark|null|undefined, position:Position, now=Date.now()) {
  return mark && mark.at<=now && now-mark.at<=75_000 && mark.shares===position.shares && mark.basis===position.basis ? mark : null;
}
export function liquidValue(mark:Mark|null, position:Position) {
  if(position.shares===0) return 0;
  return mark?.fill && !mark.fill.partial && Math.abs(mark.fill.shares-position.shares)<.00001 ? mark.fill.gross-mark.fill.fee : null;
}
export function metrics(bank:Bank,feed:Feed,now:number) {
  const positions=feed.positions.filter(p=>p.experiment===bank.experiment&&p.strategy===bank.strategy);
  const hasFeed=!!feed.readiness?.payload.process&&now-+new Date(feed.readiness.checked_at)<=45000
    && feed.readiness.payload.source!=="NO_EXECUTABLE_DATA";
  const values=positions.map(p=>liquidValue(hasFeed?currentMark(feed.marks.find(m=>m.experiment===p.experiment&&m.strategy===p.strategy&&m.token===p.token),p,now):null,p));
  const unrealized=positions.length===bank.open&&values.every(v=>v!=null) ? values.reduce<number>((sum,v)=>sum+(v??0),0)-bank.locked : null;
  return {unrealized,total:unrealized==null?null:bank.realized+unrealized};
}
export function strategyStatus(key:WeatherStrategy,bank:Bank|undefined,run:Run|undefined,feed:Feed,now:number) {
  if (key==="complete") return "Только мониторинг";
  if (!run || !bank) return "Ожидает запуска";
  if(run.status==="stopped" || +new Date(run.ends_at)<=now) return "Новые входы завершены";
  if(bank.entries_paused) return "Входы приостановлены вами";
  if(run.status==="paused") return "Эксперимент на паузе";
  if(bank.risk_blocked) return "Достигнут лимит просадки";
  if(bank.locked>=(run.configuration?.exposure??15) || bank.cash<=0) return "Свободный лимит исчерпан";
  const connection=feed.readiness;
  const view=connection?.payload;
  if (!connection || now-+new Date(connection.checked_at)>45000 || !view?.process) return "Сборщик недоступен";
  if (!view.source || view.source==="NO_EXECUTABLE_DATA") return "Нет свежего стакана";
  if (view.source==="REST_VERIFIED_PAPER" && needsStream(key)) return "Для входа нужен WebSocket";
  if (!view.ready || !feed.live?.data.some(x=>x.confidence) && ["late","smart","smart_wallet","tail","distribution","revision"].includes(key)) return "Недостаточно данных для входа";
  if (!feed.live?.opportunities) return "Проверяет рынки";
  return feed.live.opportunities.includes(key)?"Есть подходящие сигналы":"Подходящих сигналов сейчас нет";
}
export const needsStream=(key:WeatherStrategy)=>key.startsWith("replay_")||key==="observation"||key==="revision";
