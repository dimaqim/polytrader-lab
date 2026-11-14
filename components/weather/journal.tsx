import { useEffect,useState } from "react";
import { weatherStrategies,type WeatherStrategy } from "../../lib/weather/strategies";
import { dateTime,money } from "../trade-journal";
import { cityName,kindName,pnl,price,reasonText,sourceName,tone,type JournalRow } from "./data";
import { Empty,Row } from "./panels";

export const journalSections=[["signals","Сигналы"],["buys","Покупки"],["sells","Продажи и расчёты"],["open","Открытые"],["closed","Закрытые"],["skips","Пропуски"]] as const;
export type Filters={kind:string;strategy:string;city:string;source:string;since:string;pnl:string;page:number};
export const defaultFilters:Filters={kind:"signals",strategy:"",city:"",source:"",since:"",pnl:"",page:0};

export function Journal({filters,onChange,onOpen,cities}:{filters:Filters;onChange:(value:Filters)=>void;onOpen:(row:JournalRow)=>void;cities:string[]}) {
  const [result,setResult]=useState<{key:string;rows:JournalRow[];more:boolean;error:boolean}|null>(null);
  const {kind,strategy,city,source,since,pnl:profit,page}=filters;
  const key=new URLSearchParams({kind,strategy,city,source,since,pnl:profit,page:String(page)}).toString();
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
  return <div className="weather-stack">
    <nav className="weather-journal-tabs" aria-label="Тип записей">
      {journalSections.map(([id,label])=><button key={id} aria-pressed={kind===id} onClick={()=>change("kind",id)}>{label}</button>)}
    </nav>
    <details className="run weather-filter"><summary>Фильтры{[strategy,city,source,since,profit].filter(Boolean).length>0?" · "+[strategy,city,source,since,profit].filter(Boolean).length:""}</summary>
      <div className="weather-selects">
        <label>Стратегия<select value={strategy} onChange={e=>change("strategy",e.target.value)}><option value="">Все</option>
          {Object.entries(weatherStrategies).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>
        <label>Город<select value={city} onChange={e=>change("city",e.target.value)}><option value="">Все</option>{cities.map(c=><option value={c} key={c}>{cityName(c)}</option>)}</select></label>
        <label>Источник<select value={source} onChange={e=>change("source",e.target.value)}><option value="">Все</option>
          <option value="WEBSOCKET_L2">WebSocket</option><option value="REST_VERIFIED_PAPER">Снимки REST</option></select></label>
        <label>Начиная с даты<input type="date" value={since} onChange={e=>change("since",e.target.value)}/></label>
        <label>Зафиксированный результат<select value={profit} onChange={e=>change("pnl",e.target.value)}><option value="">Любой</option>
          <option value="profit">Прибыль</option><option value="loss">Убыток</option></select></label>
        <button className="text-action" onClick={()=>onChange({...defaultFilters,kind})}>Сбросить фильтры</button>
      </div>
    </details>
    {!state?<Empty>Загружаем записи…</Empty>:state.error?<Empty>Журнал временно недоступен. Данные обновятся автоматически.</Empty>
      :state.rows.length===0?<Empty>По выбранным фильтрам записей пока нет.</Empty>
      :<div className="run weather-rows">{state.rows.map(row=><Row key={[row.experiment,row.strategy,row.id].join("/")}
        title={cityName(row.city)+(row.outcome?" · "+row.outcome:"")}
        note={<>{kindName(row.kind)} · {row.strategy==="system"?"Проверка источников":weatherStrategies[row.strategy as WeatherStrategy]}
          <br/>{dateTime(row.at)} · {reasonText(row.reason)}{row.source?" · "+sourceName[row.source]:""}</>}
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
