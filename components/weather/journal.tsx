import { useEffect,useState } from "react";
import { weatherStrategies,weatherStrategyGroup,weatherStrategyGroups } from "../../lib/weather/strategies";
import { dateTime,money } from "../trade-journal";
import { cityName,kindName,marketDay,pnl,price,reasonText,tone,type JournalRow } from "./data";
import { Empty,Row } from "./panels";

export const journalSections=[["signals","Сигналы"],["buys","Покупки"],["sells","Продажи и расчёты"],["open","Открытые"],["closed","Закрытые"],["skips","Пропуски"]] as const;
export type Filters={kind:string;strategy:string;group:string;city:string;source:string;day:string;dateBy:string;pnl:string;page:number};
export const defaultFilters:Filters={kind:"buys",strategy:"",group:"",city:"",source:"",day:"",dateBy:"execution",pnl:"",page:0};

export function Journal({filters,onChange,onOpen,cities,now}:{filters:Filters;onChange:(value:Filters)=>void;onOpen:(row:JournalRow)=>void;cities:string[];now:number}) {
  const [result,setResult]=useState<{key:string;rows:JournalRow[];more:boolean;error:boolean}|null>(null);
  const {kind,strategy,group,city,source,day,dateBy,pnl:profit,page}=filters;
  const key=new URLSearchParams({kind,strategy,group,city,source,day,dateBy,pnl:profit,page:String(page)}).toString();
  useEffect(()=>{
    const controller=new AbortController();
    const load=async()=>{
      try{
        const response=await fetch("/api/weather/journal?"+key,{signal:controller.signal,cache:"no-store"});
        if(!response.ok) throw Error();
        const data=await response.json();
        if(!controller.signal.aborted)setResult({key,...data,error:false});
      }catch{if(!controller.signal.aborted)setResult({key,rows:[],more:false,error:true});}
    };
    void load();
    const timer=setInterval(()=>{if(!document.hidden)void load();},20000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[key]);
  const state=result?.key===key?result:null;
  const change=(field:keyof Omit<Filters,"page">,value:string)=>onChange({...filters,[field]:value,page:0});
  const dateBase=Date.parse(new Date(now).toLocaleDateString("sv-SE",{timeZone:"Europe/Kyiv"}));
  const groups=weatherStrategyGroups.filter(item=>!group||item.id===group);
  const advanced=[strategy,city,source,profit].filter(Boolean).length;
  return <div className="weather-stack">
    <nav className="weather-journal-tabs" aria-label="Тип записей">
      {journalSections.map(([id,label])=><button key={id} aria-pressed={kind===id} onClick={()=>change("kind",id)}>{label}</button>)}
    </nav>
    <div className="run weather-journal-controls">
      <label>Источник сигнала<select value={group} onChange={e=>onChange({...filters,group:e.target.value,strategy:"",page:0})}>
        <option value="">Все группы</option>{weatherStrategyGroups.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <div className="weather-selects weather-journal-date">
        <label>Показывать по дате<select value={dateBy} onChange={e=>change("dateBy",e.target.value)}>
          <option value="execution">Дата записи</option><option value="market">Дата рынка</option>
        </select></label>
        <label>{dateBy==="market"?"День в городе":"Дата по Киеву"}<input type="date" value={day} onChange={e=>change("day",e.target.value)}/></label>
      </div>
      <div className="weather-journal-tabs weather-day-tabs" role="group" aria-label="Быстрый выбор даты">
        {["Позавчера","Вчера","Сегодня","Завтра","Все дни"].map((label,index)=>{
          const value=index===4?"":new Date(dateBase+(index-2)*86400_000).toISOString().slice(0,10);
          return <button key={label} aria-pressed={day===value} onClick={()=>change("day",value)}>{label}</button>;
        })}
      </div>
    </div>
    <details className="run weather-filter"><summary>Дополнительные фильтры{advanced>0?" · "+advanced:""}</summary>
      <div className="weather-selects">
        <label>Стратегия<select value={strategy} onChange={e=>change("strategy",e.target.value)}><option value="">Все</option>
          {groups.map(item=><optgroup key={item.id} label={item.label}>{item.strategies.map(id=><option value={id} key={id}>{weatherStrategies[id]}</option>)}</optgroup>)}</select></label>
        <label>Город<select value={city} onChange={e=>change("city",e.target.value)}><option value="">Все</option>{cities.map(c=><option value={c} key={c}>{cityName(c)}</option>)}</select></label>
        <label>Источник<select value={source} onChange={e=>change("source",e.target.value)}><option value="">Все</option>
          <option value="WEBSOCKET_L2">WebSocket</option><option value="REST_VERIFIED_PAPER">Снимки REST</option></select></label>
        <label>Зафиксированный результат<select value={profit} onChange={e=>change("pnl",e.target.value)}><option value="">Любой</option>
          <option value="profit">Прибыль</option><option value="loss">Убыток</option></select></label>
        <button className="text-action" onClick={()=>onChange({...defaultFilters,kind})}>Сбросить фильтры</button>
      </div>
    </details>
    {!state?<Empty>Загружаем записи…</Empty>:state.error?<Empty>Журнал временно недоступен. Данные обновятся автоматически.</Empty>
      :state.rows.length===0?<Empty>По выбранным фильтрам записей пока нет.</Empty>
      :<div className="run weather-rows">{state.rows.map(row=><Row key={[row.experiment,row.strategy,row.id].join("/")}
        title={cityName(row.city)+(row.outcome?" · "+row.outcome:"")+(row.market_day?" · "+marketDay(row.market_day):"")}
        note={<>{row.strategy==="system"?"Проверка источников":weatherStrategyGroup(row.strategy)?.label+" · "+weatherStrategies[row.strategy]}
          {row.wallet_name&&<> · {row.wallet_name}</>}
          <br/>{kindName(row.kind)} · {dateTime(row.at)} по Киеву
          <br/>{reasonText(row.reason)}
          {(row.repetitions??1)>1&&<> · повторов {row.repetitions}</>}</>}
        value={<>{row.amount!=null&&<strong>{money(row.amount)}</strong>} {row.price!=null&&<small>{price(row.price)}</small>}
          {row.pnl!=null&&<small className={tone(row.pnl)}>{pnl(row.pnl)}</small>}</>}
        onClick={()=>onOpen(row)}/>)}</div>}
    {(page>0||state?.more)&&<div className="weather-actions">
      <button className="action secondary" disabled={page===0} onClick={()=>onChange({...filters,page:page-1})}>Предыдущая</button>
      <span className="muted">Страница {page+1}</span>
      <button className="action secondary" disabled={!state?.more} onClick={()=>onChange({...filters,page:page+1})}>Следующая</button>
    </div>}
  </div>;
}
