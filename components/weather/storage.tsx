import { useEffect, useState } from "react";
import { dateTime } from "../trade-journal";
import { Facts } from "./panels";

type Status={at:string;bytes:number;limit:number;growth:number|null;seconds:number|null;
  migrationPending?:boolean;
  tables:{name:string;bytes:number}[];archive:{at:string;details:{verified:boolean;rows:Record<string,number>}}|null;
  error:{at:string;message:string;repetitions:number}|null};

const mib=(bytes:number)=>(bytes/1024**2).toLocaleString("ru-RU",{maximumFractionDigits:2})+" МиБ";

export function StorageStatus() {
  const [status,setStatus]=useState<Status|null>(null);
  const [problem,setProblem]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=async()=>{
      try {
        const result=await fetch("/api/weather/storage",{cache:"no-store",signal:controller.signal});
        if (!result.ok) throw Error();
        const data=await result.json();
        if(!controller.signal.aborted){setStatus(data);setProblem(data?"":"Ожидаем первое измерение.");}
      }catch{if(!controller.signal.aborted)setProblem("Измерение хранилища временно недоступно.");}
    };
    void refresh();
    const timer=setInterval(()=>{if(!document.hidden)void refresh();},60000);
    return ()=>{clearInterval(timer);controller.abort();};
  },[]);
  if(!status)return <article className="run"><h3>Хранилище Neon</h3><p>{problem||"Загружаем данные…"}</p></article>;
  const used=status.bytes/status.limit*100;
  const archive=status.archive;
  return <article className="run"><h3>Хранилище Neon</h3>
    <Facts items={[["Занято",mib(status.bytes)],["Свободно в основной базе",mib(Math.max(0,status.limit-status.bytes))],
      ["Использовано",used.toLocaleString("ru-RU",{maximumFractionDigits:1})+"%"],
      ["Рост за период",status.growth==null||!status.seconds?"Ожидаем замеры":`${mib(status.growth)} за ${Math.round(status.seconds/60)} мин`]]}/>
    <p className={used>=80?"loss":"muted"}>{used>=90?"Критический порог 90%":used>=80?"Порог риска 80%":used>=70?"Порог уведомления 70%":"Замер "+dateTime(status.at)+" по Киеву"}</p>
    {status.migrationPending&&<p className="muted">Замеры роста и автоматические предупреждения ожидают обновления базы.</p>}
    <p>{archive?`Проверка архивов: ${dateTime(archive.at)} по Киеву. Перенесено строк за проход: ${Object.values(archive.details.rows).reduce((a,b)=>a+b,0)}.`:"Ожидаем проверку архивов на Mac."}</p>
    {problem&&<p className="muted">{problem}</p>}
    {status.error&&<p className="muted">Последняя ошибка обслуживания · {dateTime(status.error.at)} · {status.error.message}</p>}
    <details className="trade-details"><summary>Крупнейшие таблицы</summary><dl>{status.tables.map(row=><div key={row.name}><dt>{row.name}</dt><dd>{mib(row.bytes)}</dd></div>)}</dl></details>
  </article>;
}
