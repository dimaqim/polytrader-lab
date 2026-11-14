import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBounds, parseBucket, parseMetar, roundedTemperature, stations, exhaustive, verifyRules } from "../lib/weather/rules.ts";
import { estimate } from "../lib/weather/probability.ts";
import { executable, payoffTable, restRecheck, takeDepth } from "../lib/weather/execution.ts";
import { clusteredInterval, forecastScore } from "../lib/weather/scoring.ts";
import type { Forecast, LiveBook, WeatherEvent } from "../lib/weather/types.ts";

test("Weather rules use the station calendar, DST, half-up rounding and eligible routine reports", () => {
  for (const [date, hours] of [["2026-03-08",23],["2026-11-01",25]] as const) {
    const [start,end] = dayBounds(date,"America/New_York");
    assert.equal((end-start)/3600_000,hours);
  }
  assert.equal(roundedTemperature(-8.5,"C"),-8);
  assert.equal(roundedTemperature(.5,"F"),33);
  assert.equal(parseMetar("METAR RKSI 130000Z COR 15/11 RMK T01450110").temperature,14.5);
  assert.equal(parseMetar("SPECI RKSI 130000Z 15/11").temperature,null);
  assert.equal(parseMetar("METAR RKSI 130000Z M03/M05").temperature,-3);
  assert.equal(parseMetar("METAR RKSI 130000Z").temperature,null);
  assert.equal(verifyRules("the highest temperature (RKSI)","https://aviationweather.gov/api/data/metar?ids=RKSI",stations.seoul,"highest"),false);
  assert.equal(exhaustive(["10°C or below","12°C or higher"].map(x=>parseBucket(x)!)),false);
});

test("Weather distribution sums to one and ignores forecast and observation versions from the future", () => {
  const [start,end] = dayBounds("2026-11-14","Asia/Seoul");
  const at = start+2*3600_000;
  const contracts = ["10°C or below","11°C","12°C or higher"].map((label,i) => ({
    id:String(i),condition:String(i),slug:"x"+i,bucket:parseBucket(label)!,yes:"y"+i,no:"n"+i,
    open:true,tick:.01,minimum:5,fee:{rate:.05,exponent:1},payout:null
  }));
  const event: WeatherEvent = { id:"e",slug:"e",title:"fixture",station:stations.seoul,date:"2026-11-14",kind:"highest",start,end,
    rules:"fixture",source:"",verified:true,exhaustive:true,contracts,receivedAt:at };
  const forecasts: Forecast[] = [
    {station:"RKSI",model:"gfs",receivedAt:at-1,runAt:null,hash:"old",points:[[at,11]]},
    {station:"RKSI",model:"gfs",receivedAt:at+1,runAt:null,hash:"future",points:[[at,100]]},
  ];
  const observations = [{ station:"RKSI", observedAt:start+1, receivedAt:at-1, temperature:11.8,
    raw:"", publishedAt:null, providerReceivedAt:at-5, type:"METAR", correction:false, precision:"tenths" },
    { station:"RKSI", observedAt:start+1, receivedAt:at+1, temperature:25,
      raw:"", publishedAt:null, providerReceivedAt:at+1, type:"METAR", correction:true, precision:"tenths" }];
  const result = estimate(event,forecasts,observations,[],new Map(),at);
  assert.equal(result.observed,11.8);
  assert.equal(result.distribution[0].p,0);
  assert.equal(result.distribution[2].p,1);
  assert.equal(result.forecasts[0].hash,"old");
  assert.equal(result.confidence,false);
  assert.ok(result.distribution.every(x=>x.p>=0&&x.p<=1));
  assert.ok(Math.abs(result.distribution.reduce((sum,row)=>sum+row.p,0)-1)<1e-9);
});

test("Weather taker execution requires fresh post-delay WS depth and handles partial bids and asks", () => {
  const at = 1_800_000_000_000;
  const quote: LiveBook = { session:"live",book:{ asset:"a", source:"ws", sourceAt:at-30, receivedAt:at-15,
    bids:[{price:.40,size:2},{price:.38,size:5}], asks:[{price:.51,size:2},{price:.52,size:5}] } };
  const market = { tick:.01,minimum:5 };
  const fee = { rate:.05,exponent:1 };
  assert.equal(executable(quote,"live","a",at,2000,at-20),true);
  assert.equal(executable(quote,"earlier","a",at,2000),false);
  assert.equal(executable(quote,"live","a",at,2000,at-10),false);
  assert.equal(executable(quote,"live","a",at+3000,2000),false);
  assert.equal(takeDepth(quote,market,"BUY",2,.53,fee),null);
  const buy = takeDepth(quote,market,"BUY",5,.53,fee)!;
  assert.equal(buy.shares,7);
  assert.equal(buy.partial,true);
  assert.ok(buy.fee>0 && buy.gross+buy.fee<5);
  const sold = takeDepth(quote,market,"SELL",9,.38,fee)!;
  assert.equal(sold.shares,7);
  assert.equal(sold.partial,true);
  assert.ok(sold.price>.38 && sold.price<.4);
  assert.equal(takeDepth(quote,{...market,tick:.02},"BUY",5,.53,fee),null);
});

test("Complete-set arithmetic exposes a missing outcome and correlated legs", () => {
  assert.deepEqual(payoffTable(3,[{bucket:0,yes:true,shares:5},{bucket:0,yes:false,shares:5}]),[5,5,5]);
  assert.deepEqual(payoffTable(3,[{bucket:0,yes:true,shares:5},{bucket:1,yes:false,shares:5}]),[10,0,5]);
});
test("Weather scores use resolved events and a minimum count of independent financial groups", () => {
  const score=forecastScore([.7,.2,.1],0);
  assert.ok(score && Math.abs(score.brier-.14)<1e-10);
  assert.equal(score.logLoss,-Math.log(.7));
  assert.equal(forecastScore([.7,null,.3],0),null);
  assert.equal(forecastScore([.8,.3],0),null);
  assert.equal(clusteredInterval(Array(19).fill(2)),null);
  assert.deepEqual(clusteredInterval(Array(20).fill(2)),[2,2]);
});

test("REST recheck requires a distinct request sent after the delay and rejects stale or future depth", () => {
  const t=Date.now();
  const rest = (id:string, request:number, received:number, sourceAt:number) => ({
    session:"rest-session", book:{asset:"token",source:"rest" as const,sourceAt,receivedAt:received,
      bids:[{price:.4,size:10}],asks:[{price:.5,size:10}]},
    rest:{requestId:id,requestedAt:request,receivedAt:received,minimum:5,tick:.01,condition:"condition",hash:"hash"},
  });
  const signal=rest("first",t-100,t,t);
  const ready=t+1000, end=t+1250;
  const quote=rest("second",ready,ready+100,ready+50);
  assert.equal(restRecheck(signal,quote,"token",ready,end),true);
  assert.equal(restRecheck(signal,{...quote,session:"new"}, "token",ready,end),false);
  assert.equal(restRecheck(signal,rest("second",ready-1,end,ready),"token",ready,end),false);
  assert.equal(restRecheck(signal,rest("first",ready,end,ready),"token",ready,end),false);
  assert.equal(restRecheck(signal,rest("second",ready,end,end+1),"token",ready,end),false);
  assert.equal(restRecheck(signal,quote,"token",ready,end+6500),false);
});
