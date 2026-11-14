import { takerFee } from "../simulator.ts";
import { roundedTemperature } from "./rules.ts";
import type { Contract, Estimate, WalletEvent, WeatherEvent } from "./types.ts";

export const weatherStrategies = {
  late: "Late Temperature Edge",
  observation: "Official Observation Repricing",
  revision: "Forecast Revision Edge",
  distribution: "Weather Distribution Value",
  smart: "Smart Weather Value",
  smart_wallet: "Smart Weather Value + Wallets",
  tail: "Cheap YES",
  replay_5: "Wallet Replay · 5 с",
  replay_15: "Wallet Replay · 15 с",
  replay_30: "Wallet Replay · 30 с",
  replay_60: "Wallet Replay · 60 с",
  complete: "Complete-Set Monitor",
  favorite: "Market Favorite",
} as const;
export type WeatherStrategy = keyof typeof weatherStrategies;
export const strategyKeys = Object.keys(weatherStrategies) as WeatherStrategy[];
export const risk = { bank: 100, cost: 5, exposure: 15, drawdown: 15, delay: 1000, maxAge: 2000, spread: .12, edge: .025 } as const;

export type Candidate = {
  strategy: WeatherStrategy; contract: Contract; token: string; yes: boolean; reference: number; probability: number | null;
  conservative: number | null; ev: number | null; reason: string; wallet?: WalletEvent;
};

export function candidates(event: WeatherEvent, current: Estimate, previous: Estimate | undefined,
  quotes: Map<string, { bid: number; ask: number }>, wallet: WalletEvent[], at: number) {
  const result: Candidate[] = [];
  if (!event.verified || !event.exhaustive || at >= event.end) return result;
  const hours = (event.end - at) / 3600_000;
  const favorite = current.distribution.filter(row => row.market != null).sort((a, b) => b.market! - a.market!)[0];
  for (const contract of event.contracts) for (const yes of [true, false]) {
    const token = yes ? contract.yes : contract.no;
    const quote = quotes.get(token);
    if (!contract.open || !quote || !contract.fee || quote.ask - quote.bid > risk.spread) continue;
    const p = current.distribution.find(row => row.condition === contract.condition);
    const prior = previous?.distribution.find(row => row.condition === contract.condition);
    const probability = p ? (yes ? p.p : 1 - p.p) : null;
    const conservative = p ? (yes ? p.low : 1 - p.high) : null;
    const ev = conservative == null ? null : conservative - quote.ask - takerFee(1, quote.ask, contract.fee);
    const base = { contract, token, yes, probability, conservative, ev, reference: quote.ask };
    const add = (strategy: WeatherStrategy, reason: string, trade?: WalletEvent) => result.push({ ...base, strategy, reason, wallet: trade });
    if (yes && favorite?.condition === contract.condition && hours <= 12 && quote.ask <= .94 && (favorite.market ?? 0) >= .5) add("favorite", "MARKET_FAVORITE");
    const trades = wallet.filter(row => row.token === token && row.type === "TRADE" && row.side === "BUY" && row.at <= at
      && row.receivedAt <= at && at - row.receivedAt < 120_000 && row.price > 0 && row.price < 1);
    const latest = trades[0];
    if (latest && Math.abs(quote.ask - latest.price) <= .04) for (const seconds of [5,15,30,60] as const) {
      add(`replay_${seconds}`, "PUBLIC_WALLET_BUY", latest);
    }
    const obs = current.observation;
    if (!yes && current.observed != null && obs && at - obs.receivedAt < 120_000 && at - obs.observedAt < 3600_000) {
      const observed = roundedTemperature(current.observed, contract.bucket.unit);
      const excluded = event.kind === "highest" ? contract.bucket.high != null && observed > contract.bucket.high
        : contract.bucket.low != null && observed < contract.bucket.low;
      if (excluded && quote.ask + takerFee(1, quote.ask, contract.fee) < .95) {
        result.push({ ...base, probability: null, conservative: .95, ev: .95 - quote.ask - takerFee(1, quote.ask, contract.fee),
          strategy: "observation", reason: "OBSERVED_RANGE_EXCLUDED" });
      }
    }
    if (!current.confidence || ev == null || ev <= risk.edge) continue;
    add("distribution", "CONSERVATIVE_DISTRIBUTION_EDGE");
    add("smart", "WEATHER_VALUE");
    if (latest) add("smart_wallet", "WEATHER_VALUE_AND_WALLET", latest);
    if (current.observed != null && hours <= 8) add("late", "REMAINING_DAY_EDGE");
    if (yes && quote.ask <= .20 && ev > .045) add("tail", "CALIBRATED_TAIL_EDGE");
    const revised = current.forecasts.some(row => previous?.forecasts.some(old => old.model === row.model && row.hash !== old.hash
      && Math.abs(row.value - old.value) >= 1));
    if (revised && p && prior && p.market != null && prior.market != null
      && (yes ? 1 : -1) * ((p.p - prior.p) - (p.market - prior.market)) >= .08) add("revision", "FORECAST_REVISION_EXCEEDS_MARKET");
  }
  return result.sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
}
