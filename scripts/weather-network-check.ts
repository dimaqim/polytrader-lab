import WebSocket from "ws";
import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { marketSocket } from "../server/polymarket.ts";
import { socketOptions, weatherAddresses } from "../server/weather/network.ts";
import { getRestBook } from "../server/weather/rest.ts";
import { takeDepth } from "../lib/weather/execution.ts";

const asset=process.argv[2];
const condition=process.argv[3];
if (!asset || !/^\d+$/.test(asset) || !/^0x[0-9a-f]{64}$/.test(condition ?? "")) throw new Error("Usage: npm run weather:network -- TOKEN_ID CONDITION_ID [ADDITIONAL_TOKENS...]");
const host=new URL(marketSocket).hostname;
const now=()=>new Date().toISOString();
const report=(stage:string,details:object)=>console.log(JSON.stringify({at:now(),stage,...details}));
const dns=await Promise.allSettled([lookup(host,{all:true}),resolve4(host),resolve6(host)]);
report("system_dns",{lookup:dns[0],ipv4:dns[1],ipv6:dns[2]});

async function probe(tokens: string[], terminate = false) {
  return new Promise<boolean>(resolve=>{
    let snapshots=0,updates=0,pongs=0;
    const ws = new WebSocket(marketSocket,socketOptions(report));
    const send=()=>{ if(ws.readyState===WebSocket.OPEN) ws.send("PING"); };
    const deadline=setTimeout(()=>{ if(ws.readyState===WebSocket.OPEN) ws.close(); else ws.terminate(); }, terminate ? 6000 : 40000);
    const ping=setInterval(send,10000);
    ws.on("upgrade",res=>report("upgrade",{status:res.statusCode}));
    ws.on("unexpected-response",(_req,res)=>{ report("unexpected-response",{status:res.statusCode}); res.resume(); ws.terminate(); });
    ws.on("open",()=>{report("open",{tokens:tokens.length}); ws.send(JSON.stringify({assets_ids:tokens,type:"market",custom_feature_enabled:true}));send();});
    ws.on("message",raw=>{
      const str=raw.toString();
      if(str==="PONG"){pongs++; report("pong",{pongs}); return;}
      try {
        const msg=JSON.parse(str);
        for (const row of Array.isArray(msg)?msg:[msg]) {
          if(row.event_type==="book"){snapshots++;if(snapshots<=2) report("book",{token:row.asset_id,bids:row.bids?.length,asks:row.asks?.length});}
          if(row.event_type==="price_change"){updates++;if(updates===1)report("price_change",{updates});}
        }
      } catch { report("invalid_frame",{}); }
    });
    ws.on("error",(err)=>report("error",{error:err.message,code:(err as NodeJS.ErrnoException).code}));
    ws.on("close",(code,reason)=>{clearTimeout(deadline);clearInterval(ping);report("close",{code,reason:reason.toString(),snapshots,updates,pongs});resolve(snapshots>0&&pongs>0);});
  });
}

const rest = async () => {
  const signal=await getRestBook(asset,condition);
  if(!signal) return report("rest_missing",{});
  await new Promise(resolve=>setTimeout(resolve,1000));
  const execution=await getRestBook(asset,condition);
  if(!execution) return report("rest_missing_after_delay",{});
  const {book,rest}=execution;
  const market={minimum:rest!.minimum,tick:rest!.tick};
  const fee={rate:Number(process.env.WEATHER_PROBE_FEE ?? ".05"),exponent:1};
  report("rest_pair",{signal:signal.rest,execution:rest,sourceAt:book.sourceAt,ageMs:Date.now()-book.sourceAt,bid:book.bids[0],ask:book.asks[0],
    bidLevels:book.bids.length,askLevels:book.asks.length,buy:takeDepth(execution,market,"BUY",25,.999,fee),
    sell:takeDepth(execution,market,"SELL",10,.001,fee)});
};
const one=await Promise.allSettled([probe([asset],true),rest(),weatherAddresses(host,(source,addresses)=>report("resolved",{source,addresses})).catch(()=>[])]);
for(const result of one) if(result.status==="rejected") report("probe_error",{error:String(result.reason)});
const next=await probe([asset,...process.argv.slice(4)]);
if(!next) process.exitCode=1;
