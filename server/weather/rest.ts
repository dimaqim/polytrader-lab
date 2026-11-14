import { randomUUID } from "node:crypto";
import { numeric, parseBook, UpstreamError } from "../polymarket.ts";
import type { LiveBook } from "../../lib/weather/types.ts";
import { weatherFetch } from "./network.ts";

const base="https://clob.polymarket.com";
const maximumBatch=48;
const restSession="rest:"+randomUUID();
let blockedUntil=0;

async function images(assets: Map<string,string>, batch: boolean) {
  if (Date.now()<blockedUntil) throw new Error("CLOB REST backoff");
  const url=base+(batch ? "/books" : "/book?"+new URLSearchParams({token_id:assets.keys().next().value!}));
  const requestId=randomUUID(),requestedAt=Date.now();
  const response=await weatherFetch(url,{method:batch?"POST":"GET",cache:"no-store",signal:AbortSignal.timeout(3500),
    headers:{"cache-control":"no-cache, no-store",...(batch?{"content-type":"application/json"}:{})},
    body:batch?JSON.stringify([...assets.keys()].map(token_id=>({token_id}))):undefined});
  if ([429,500,502,503,504].includes(response.status)) {
    const header=response.headers.get("retry-after")??"";
    const ms=/^\d+$/.test(header) ? Number(header)*1000 : Date.parse(header)-Date.now();
    blockedUntil=Date.now()+Math.max(2000,Number.isFinite(ms)?ms:0);
  }
  if (response.status===404 && !batch) return [];
  if (!response.ok) throw new UpstreamError(response.status,batch?"/books":"/book");
  const raw=await response.json();
  const receivedAt=Date.now();
  if (Number(response.headers.get("age")??0)>0 || /\bHIT\b/i.test(response.headers.get("cf-cache-status")??"")) return [];
  const rows:Record<string,unknown>[] = Array.isArray(raw)?raw:[raw];
  const seen=new Set<string>();
  const duplicate=new Set<string>();
  for(const row of rows) {
    if(typeof row?.asset_id!=="string") continue;
    if(seen.has(row.asset_id)) duplicate.add(row.asset_id);
    seen.add(row.asset_id);
  }
  return rows.flatMap(row=>{
    const token=String(row?.asset_id??""),condition=assets.get(token);
    if (!condition || duplicate.has(token) || String(row.market).toLowerCase()!==condition.toLowerCase()) return [];
    const book=parseBook(row,token,receivedAt,"rest");
    const minimum=numeric(row.min_order_size),tick=numeric(row.tick_size);
    if (!book || !Number.isFinite(minimum) || minimum<=0 || !(tick>0 && tick<1) || book.bids.length!==(row.bids as unknown[]).length
      || book.asks.length!==(row.asks as unknown[]).length || new Set(book.bids.map(x=>x.price)).size!==book.bids.length
      || new Set(book.asks.map(x=>x.price)).size!==book.asks.length || (book.bids[0]?.price??0)>=(book.asks[0]?.price??1)
      || typeof row.hash!=="string" || !row.hash.length) return [];
    return [{session:restSession,book,rest:{requestId,requestedAt,receivedAt,condition,minimum,tick,hash:row.hash}} satisfies LiveBook];
  });
}
export async function getRestBook(token: string, condition: string) {
  return (await images(new Map([[token,condition]]),false))[0];
}

export class WeatherRest {
  private readonly books=new Map<string,LiveBook>();
  lastResponse=0;
  lastError="";
  async refresh(assets: [string,string][]) {
    const batches: Map<string,string>[]=[];
    for (let i=0;i<assets.length;i+=maximumBatch) batches.push(new Map(assets.slice(i,i+maximumBatch)));
    const results=await Promise.allSettled(batches.map(batch=>images(batch,true)));
    const books=results.flatMap(result=>result.status==="fulfilled"?result.value:[]);
    const failure=results.find(result=>result.status==="rejected");
    if (!books.length) {
      this.lastError=failure?.status==="rejected"?String(failure.reason):"No books verified";
      throw new Error(this.lastError);
    }
    this.lastError=failure?.status==="rejected"?String(failure.reason):"";
    const at=Date.now();
    for(const [key,book] of this.books) if(at-book.book.receivedAt>15*60_000) this.books.delete(key);
    for(const quote of books) {
      const previous=this.books.get(quote.book.asset);
      if(!previous||quote.book.sourceAt>=previous.book.sourceAt) this.books.set(quote.book.asset,quote);
    }
    this.lastResponse=at;
    return books.length;
  }
  book(token: string) { return this.books.get(token); }
}
