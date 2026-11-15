import { request } from "../polymarket.ts";
import type { Contract, WeatherEvent } from "../../lib/weather/types.ts";
import { weatherFetch } from "./network.ts";

type Resolution = { condition_id: string; status: string; payouts?: number[] | null };
type ClobMarket = { condition_id?: string; closed?: boolean; tokens?: { token_id: string; winner?: boolean; price?: number }[] };

function publishedPayout(payout: number[] | null | undefined) {
  if (Array.isArray(payout) && payout.length === 2 && payout.every(value => [0,.5,1].includes(value)) && payout[0]+payout[1]===1) {
    return payout;
  }
  return null;
}

export async function weatherPayouts(events: WeatherEvent[], at: number, get = weatherFetch) {
  const targets = events.filter(event => event.verified && event.end <= at && event.contracts.some(c => !c.payout));
  const confirmed = new Map<string, number[]>();
  const missing: Contract[] = [];
  let failures = 0;
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i,i+20);
    try {
      const query = new URLSearchParams({event_id:batch.map(event=>event.id).join(",")});
      const response = await request<{data:Resolution[]}>("https://data-api.polymarket.com/v2/resolutions?"+query,get,2);
      const byCondition = new Map(response.data.map(row=>[row.condition_id,row]));
      for (const contract of batch.flatMap(event=>event.contracts.filter(c=>!c.payout))) {
        const row = byCondition.get(contract.condition);
        if (row?.status!=="resolved") continue;
        const payout = publishedPayout(row.payouts);
        if (payout) confirmed.set(contract.condition,payout);
        else missing.push(contract);
      }
    } catch { failures++; }
  }
  for (let i = 0; i < missing.length; i += 8) {
    const results = await Promise.allSettled(missing.slice(i,i+8).map(async contract => {
      const row = await request<ClobMarket>("https://clob.polymarket.com/markets/"+contract.condition,get,2);
      if (row.condition_id!==contract.condition || row.closed!==true || row.tokens?.length!==2) return;
      const yes = row.tokens.find(token=>token.token_id===contract.yes);
      const no = row.tokens.find(token=>token.token_id===contract.no);
      if (!yes || !no || typeof yes.winner!=="boolean" || typeof no.winner!=="boolean" || yes.winner===no.winner) return;
      if (yes.price===Number(yes.winner) && no.price===Number(no.winner)) confirmed.set(contract.condition,[yes.price,no.price]);
    }));
    failures += results.filter(result=>result.status==="rejected").length;
  }
  return {confirmed,failures};
}
