"use client";

import { useCallback,useEffect,useState } from "react";
import { RefreshCw } from "lucide-react";
import { weatherStrategies,type WeatherStrategy } from "../lib/weather/strategies";
import { resultMoney } from "./trade-journal";
import { cityName,pct,strategyStatus,type Decision,type Feed,type JournalRow,type Position,type PositionDetail } from "./weather/data";
import { Dashboard,EquityChart,equitySeries,Sources,StrategyResults } from "./weather/dashboard";
import { lessons } from "./weather/education";
import { defaultFilters,Journal } from "./weather/journal";
import { Guide,MarketCard,Wallets } from "./weather/market";
import { DecisionPanel,Empty,PositionPanel,Row,Sheet,StrategyPanel } from "./weather/panels";

const sections=[["overview","Обзор"],["markets","Рынки"],["strategies","Стратегии"],["journal","Журнал"],
  ["wallets","Кошельки"],["analysis","Аналитика"],["guide","Справка"],["health","Источники"]] as const;
type Section=typeof sections[number][0];
type Detail={type:"strategy";strategy:WeatherStrategy}|{type:"position";id:string;strategy:WeatherStrategy;token:string;title:string;fillId?:string}|{type:"decision";id:string};

export function WeatherLab({authenticated}:{authenticated:boolean}) {
  const [feed,setFeed]=useState<Feed|null>(null);
  const [tab,setTab]=useState<Section>("overview");
  const [detail,setDetail]=useState<Detail|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [city,setCity]=useState("");
  const [filters,setFilters]=useState(defaultFilters);
  const [now,setNow]=useState(()=>Date.now());
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    try {
      const response=await fetch("/api/weather",{cache:"no-store",signal});
      if(!response.ok)throw Error();
      if(!signal?.aborted) {
        setFeed(await response.json());
        setNow(Date.now());
        setError("");
      }
    }catch{if(!signal?.aborted)setError("Weather Lab временно недоступен. Повторите обновление.");}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    const update=()=>{if(!document.hidden)void refresh(controller.signal);};
    update();
    const timer=setInterval(update,15000);
    document.addEventListener("visibilitychange",update);
    return ()=>{controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",update);};
  },[refresh,authenticated]);
  const mutate=async(path:string,value:object)=>{
    setBusy(true);
    try {
      const response=await fetch("/api/weather/"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
      if(!response.ok)throw Error();
      await refresh();
      return true;
    }catch{setError("Действие не выполнено. Проверьте состояние эксперимента и повторите.");return false;}
    finally{setBusy(false);}
  };
  const run=feed?.runs[0];
  const banks=feed?.banks.filter(row=>row.experiment===run?.id)??[];
  const view=feed?.readiness?.payload;
  const source=feed?.readiness&&now-+new Date(feed.readiness.checked_at)<45000&&view?.process
    ?view.source??"NO_EXECUTABLE_DATA":"NO_EXECUTABLE_DATA";
  const cities=[...new Set(feed?.markets.map(e=>e.station.city))];
  const openStrategy=(strategy:WeatherStrategy)=>setDetail({type:"strategy",strategy});
  const openPosition=(p:Pick<Position,"experiment"|"strategy"|"token"|"city">,fillId?:string)=>setDetail({
    type:"position",id:p.experiment,strategy:p.strategy,token:p.token,title:cityName(p.city),fillId,
  });
  const openDecision=(d:Pick<Decision,"id">)=>setDetail({type:"decision",id:d.id});
  const openJournalRow=(row:JournalRow)=>{
    if(row.category==="signals"||row.category==="skips")openDecision(row);
    else if(row.experiment&&row.token&&row.strategy!=="system")openPosition({
      experiment:row.experiment,token:row.token,strategy:row.strategy,city:row.city,
    },["buys","sells"].includes(row.category)?row.id:undefined);
  };
  const showJournal=(strategy="",kind="open")=>{setDetail(null);setFilters({...filters,strategy,kind,page:0});setTab("journal");};
  const visibleMarkets=feed?.markets.filter(e=>(!city||e.station.city===city)&&((e.end>now&&e.contracts.some(c=>c.open))
    ||feed.positions.some(p=>p.event===e.id)))??[];
  const inTab=()=>{
    if(!feed)return <Empty>{error?"Данные пока недоступны.":"Загружаем данные…"}</Empty>;
    switch(tab) {
      case "overview":return <Dashboard feed={feed} run={run} banks={banks} now={now} authenticated={authenticated} busy={busy} mutate={mutate}
        openPosition={openPosition} openFill={f=>openPosition(f,f.id)} openDecision={openDecision} openStrategy={openStrategy} journal={()=>showJournal()}/>;
      case "markets":return <div className="weather-stack">
        <label className="weather-city">Город<select value={city} onChange={e=>setCity(e.target.value)}>
          <option value="">Все города</option>{cities.map(c=><option key={c} value={c}>{cityName(c)}</option>)}</select></label>
        {visibleMarkets.length?visibleMarkets.map(m=><MarketCard key={m.id} event={m} live={feed.live?.data.find(x=>x.event===m.id)} now={now}
          held={feed.positions.filter(p=>p.event===m.id).map(p=>p.token)}/>):<Empty>Рынков для выбранного города пока нет.</Empty>}
      </div>;
      case "strategies":return <section className="weather-stack"><h2>Стратегии</h2><div className="run weather-rows">
        {(Object.keys(weatherStrategies) as WeatherStrategy[]).map(id=><Row key={id} title={weatherStrategies[id]}
          note={<>{lessons[id].plain}<br/>{strategyStatus(id,banks.find(x=>x.strategy===id),run,feed,now)}</>}
          onClick={()=>openStrategy(id)}/>)}</div></section>;
      case "journal":return authenticated?<Journal filters={filters} onChange={setFilters} onOpen={openJournalRow} cities={cities}/>
        :<Empty>Откройте Mini App в Telegram, чтобы увидеть журнал своего эксперимента.</Empty>;
      case "wallets":return <Wallets wallets={feed.live?.wallets??[]} events={feed.live?.walletEvents??[]} markets={feed.markets}/>;
      case "analysis":return <Analysis feed={feed} run={run?.id} banks={banks} now={now} open={openStrategy}/>;
      case "guide":return <Guide/>;
      case "health":return <Sources view={view} feed={feed} source={source} busy={busy} mutate={mutate}/>;
    }
  };
  return <section className="weather" aria-label="Weather Lab">
    <div className="weather-nav-line"><nav className="combo-filters weather-tabs" aria-label="Разделы Weather Lab">
      {sections.map(([id,label])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}
    </nav><button className="icon-action weather-refresh" aria-label="Обновить данные" onClick={()=>void refresh()}><RefreshCw size={16}/></button></div>
    {error&&!detail&&<p role="status" className="notice">{error}</p>}
    {inTab()}
    {detail&&(authenticated||detail.type==="strategy")&&<Sheet title={detail.type==="strategy"?weatherStrategies[detail.strategy]:
      detail.type==="position"?detail.title:"Решение по сигналу"} onClose={()=>setDetail(null)}>
      {error&&<p role="status" className="notice">{error}</p>}
      {detail.type==="strategy"&&feed?<StrategyPanel strategy={detail.strategy} bank={banks.find(b=>b.strategy===detail.strategy)}
        run={run} feed={feed} now={now} busy={busy} onToggle={paused=>mutate("strategy",{id:run?.id,strategy:detail.strategy,paused})}
        showJournal={()=>showJournal(detail.strategy,"buys")}/>
        :detail.type!=="strategy"&&<RemoteDetail key={JSON.stringify(detail)} detail={detail} now={now} feedOnline={!!feed?.readiness?.payload.process&&now-+new Date(feed.readiness.checked_at)<45000}/>}
    </Sheet>}
  </section>;
}

function RemoteDetail({detail,now,feedOnline}:{detail:Exclude<Detail,{type:"strategy"}>;now:number;feedOnline:boolean}) {
  const [result,setResult]=useState<PositionDetail|Decision|null>(null);
  const [problem,setProblem]=useState("");
  const params=new URLSearchParams({id:detail.id,...(detail.type==="position"?{strategy:detail.strategy,token:detail.token}:{})});
  const url="/api/weather/"+detail.type+"?"+params;
  useEffect(()=>{
    const c=new AbortController();
    const refresh=async()=>{
      try{
        const response=await fetch(url,{cache:"no-store",signal:c.signal});
        if(!response.ok)throw Error();
        const data=await response.json();
        if(!c.signal.aborted){setResult(data);setProblem("");}
      }catch{if(!c.signal.aborted)setProblem("Данные записи недоступны.");}
    };
    void refresh();
    const timer=detail.type==="position"?setInterval(()=>{if(!document.hidden)void refresh();},15000):undefined;
    return ()=>{c.abort();clearInterval(timer);};
  },[url,detail.type]);
  if(!result)return <Empty>{problem||"Загружаем подробности…"}</Empty>;
  return <>{problem&&<p className="notice" role="status">{problem}</p>}
    {detail.type==="position"&&"position" in result?<PositionPanel detail={result} now={now} fillId={detail.fillId} feedOnline={feedOnline}/>
      :"evidence" in result?<DecisionPanel row={result}/>:null}</>;
}

type Scores={accuracy:{horizon:number;n:number;paired:number;brier:number|null;logLoss:number|null;pairedWeatherBrier:number|null;marketBrier:number|null;
  bins:{bottom:number;top:number;n:number;predicted:number|null;observed:number|null}[]}[];
  financial:{experiment:string;strategy:WeatherStrategy;n:number;interval:[number,number]|null}[]};
function Analysis({feed,run,banks,now,open}:{feed:Feed;run?:string;banks:Feed["banks"];now:number;open:(id:WeatherStrategy)=>void}) {
  const [scores,setScores]=useState<Scores|null>(null);
  const [failed,setFailed]=useState(false);
  const [selected,setSelected]=useState<WeatherStrategy>("favorite");
  useEffect(()=>{
    const c=new AbortController();
    fetch("/api/weather/scores",{cache:"no-store",signal:c.signal}).then(response=>{
      if(!response.ok)throw Error();return response.json();
    }).then(setScores).catch(()=>{if(!c.signal.aborted)setFailed(true);});
    return ()=>c.abort();
  },[]);
  const financial=scores?.financial.find(x=>x.experiment===run&&x.strategy===selected);
  return <div className="weather-stack">
    <h2>Доходность стратегий</h2>
    <StrategyResults feed={feed} run={feed.runs.find(x=>x.id===run)} banks={banks} now={now} open={open}/>
    <section className="run"><h3>Капитал стратегии</h3><label>Стратегия<select value={selected} onChange={e=>setSelected(e.target.value as WeatherStrategy)}>
      {Object.entries(weatherStrategies).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <EquityChart rows={run?equitySeries(feed,run,[selected]):[]}/>
      <p className="muted">{financial?.interval?"95% интервал среднего результата на станцию и день от "+resultMoney(financial.interval[0])+" до "+resultMoney(financial.interval[1]):
        "Для доверительного интервала нужно 20 закрытых групп «станция и день». Сейчас "+(financial?.n??0)+"."}</p></section>
    <h2>Точность прогнозов</h2>
    {failed?<Empty>Не получилось загрузить оценки прогнозов.</Empty>:scores?.accuracy.some(row=>row.n>0)
      ?scores.accuracy.filter(row=>row.n>0).map(row=><article className="run" key={row.horizon}>
        <h3>За {row.horizon} ч · {row.n} рассчитанных событий</h3>
        <p>Brier {row.brier?.toFixed(3)} · Log Loss {row.logLoss?.toFixed(3)}</p>
        {row.paired>0&&<p className="muted">Brier на одних и тех же {row.paired} событиях · прогноз {row.pairedWeatherBrier?.toFixed(3)} · рынок {row.marketBrier?.toFixed(3)}</p>}
        <details className="trade-details"><summary>Калибровка вероятностей</summary>
          {row.bins.filter(bin=>bin.n>0).map(bin=><p key={bin.bottom}>{pct(bin.bottom)}–{pct(bin.top)} · прогноз {pct(bin.predicted)} · сбылось {pct(bin.observed)} · {bin.n} исходов</p>)}</details>
      </article>):<Empty>{scores?"Точность появится после официального расчёта рынков с сохранённым прогнозом.":"Загружаем оценки прогнозов…"}</Empty>}
  </div>;
}
