import type { Book, Fee } from "../simulator.ts";
import type { Bucket, Kind, Station } from "./rules.ts";

export type Contract = {
  id: string; condition: string; slug: string; bucket: Bucket; yes: string; no: string; open: boolean;
  tick: number; minimum: number; fee: Fee | null; payout: number[] | null;
};
export type WeatherEvent = {
  id: string; slug: string; title: string; station: Station; date: string; kind: Kind; start: number; end: number;
  rules: string; source: string; verified: boolean; exhaustive: boolean; contracts: Contract[]; receivedAt: number;
};
export type Observation = {
  station: string; observedAt: number; publishedAt: number | null; providerReceivedAt: number | null;
  receivedAt: number; raw: string; temperature: number | null; type: string; correction: boolean; precision: string | null;
};
export type Forecast = {
  station: string; model: string; runAt: number | null; receivedAt: number; hash: string;
  points: [number, number][]; member?: string;
};
export type Calibration = { model: string; bias: number; sigma: number; n: number; windows: Record<string, { n: number; bias: number | null }> };
export type Probability = { condition: string; p: number; low: number; high: number; market: number | null; blended: number | null };
export type Estimate = {
  at: number; distribution: Probability[]; forecasts: { model: string; value: number; weight: number; receivedAt: number; hash: string }[];
  observed: number | null; observation: Observation | null; confidence: boolean; calibration: Calibration[];
};
export type ExecutionSource = "WEBSOCKET_L2" | "REST_VERIFIED_PAPER" | "NO_EXECUTABLE_DATA";
export type RestProof = { requestId:string; requestedAt:number; receivedAt:number; minimum:number; tick:number; hash:string; condition:string };
export type LiveBook = { session: string; book: Book; rest?:RestProof };
export type WalletEvent = {
  id: string; wallet: string; name: string; condition: string; token: string; side: string;
  type: string; at: number; receivedAt: number; price: number; shares: number; value: number;
};
