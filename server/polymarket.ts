import type { Book, Fee, Level } from "../lib/simulator.ts";

const gamma = "https://gamma-api.polymarket.com";
const clob = "https://clob.polymarket.com";
const data = "https://data-api.polymarket.com/v2";
export const marketSocket = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`Polymarket ${path} HTTP ${status}`);
    this.status = status;
  }
}
export async function request<T>(url: string, get = fetch, attempts = 3): Promise<T> {
  const path = new URL(url).pathname;
  for (let attempt = 0; ; attempt++) {
    let retry = 0;
    try {
      const response = await get(url, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      if (response.ok) return await response.json() as T;
      const header = response.headers.get("retry-after");
      if (header) retry = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
      throw new UpstreamError(response.status, path);
    } catch (error) {
      if (attempt + 1 >= attempts || retry > 5_000
        || (error instanceof UpstreamError && ![429, 500, 502, 503, 504].includes(error.status))) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.max(retry, 250 * 2 ** attempt + Math.random() * 100)));
    }
  }
}
type Obj = Record<string, unknown>;
const list = (value: unknown): unknown[] => {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
};
export function numeric(value: unknown) {
  return typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
}
export function timestamp(value: unknown) {
  const n = numeric(value);
  return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : typeof value === "string" ? Date.parse(value) : NaN;
}
export type Market = {
  condition: string; slug: string; title: string; endsAt: number; interval: number | null;
  tokens: string[]; outcomes: string[]; prices: (number | null)[]; fee: Fee | null;
  payout: number[] | null; open: boolean; seenAt: number;
};
export function parseMarket(raw: Obj, seenAt: number): Market | null {
  const slug = String(raw.slug ?? "");
  const btc = /^btc-updown-(5|15)m-(\d+)$/.exec(slug);
  const interval = btc ? Number(btc[1]) : null;
  const endsAt = btc ? (Number(btc[2]) + Number(interval) * 60) * 1000 : Date.parse(String(raw.endDate));
  const tokens = list(raw.clobTokenIds).map(String);
  const outcomes = list(raw.outcomes).map(String);
  const prices = list(raw.outcomePrices).map(v => {
    const p = numeric(v);
    return p >= 0 && p <= 1 ? p : null;
  });
  const condition = String(raw.conditionId ?? "").toLowerCase();
  if (!/^0x[\da-f]{64}$/.test(condition) || !slug || !Number.isFinite(endsAt)
    || tokens.length !== 2 || tokens.some(t => !/^\d+$/.test(t)) || new Set(tokens).size !== 2 || outcomes.length !== 2) return null;
  const schedule = raw.feeSchedule as Obj | undefined;
  const rate = numeric(schedule?.rate);
  const exponent = numeric(schedule?.exponent);
  const fee = raw.feesEnabled === false ? { rate: 0, exponent: 1 }
    : rate >= 0 && rate <= 1 && exponent >= 0 && exponent <= 5 ? { rate, exponent } : null;
  const payout = raw.closed === true && raw.umaResolutionStatus === "resolved" && prices.length === 2
    && prices.every(p => p === 0 || p === 0.5 || p === 1) && Number(prices[0]) + Number(prices[1]) === 1 ? prices as number[] : null;
  return { condition, slug, title: String(raw.question ?? slug), endsAt, interval, tokens, outcomes, prices, fee, payout,
    open: raw.closed === false && raw.acceptingOrders === true && raw.enableOrderBook !== false, seenAt };
}
export async function marketBySlug(slug: string) {
  try {
    const raw = await request<Obj>(gamma + "/markets/slug/" + encodeURIComponent(slug));
    return parseMarket(raw, Date.now());
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}
export async function marketByCondition(condition: string) {
  const rows = await request<Obj[]>(gamma + "/markets?" + new URLSearchParams({ condition_ids: condition, limit: "1" }));
  return rows[0] ? parseMarket(rows[0], Date.now()) : null;
}
export function levels(value: unknown, descending = false): Level[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const price = numeric(row?.price);
    const size = numeric(row?.size);
    return price > 0 && price < 1 && Number.isFinite(size) && size > 0 ? [{ price, size }] : [];
  }).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}
export function parseBook(raw: Obj, asset: string, receivedAt: number, source: Book["source"]): Book | null {
  const sourceAt = timestamp(raw.timestamp);
  if (String(raw.asset_id) !== asset || !Number.isFinite(sourceAt) || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) return null;
  return { asset, bids: levels(raw.bids, true), asks: levels(raw.asks), sourceAt, receivedAt, source };
}
export async function orderBook(asset: string) {
  try {
    const raw = await request<Obj>(clob + "/book?" + new URLSearchParams({ token_id: asset }), fetch, 2);
    const book = parseBook(raw, asset, Date.now(), "rest");
    const minimum = numeric(raw.min_order_size);
    return book && minimum > 0 && Number.isFinite(minimum) ? { book, minimum } : null;
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}
export type Page<T> = { data: T[]; pagination: { next_cursor: string | null; has_more: boolean } };
export function page<T>(path: string, params: Record<string, string>) {
  return request<Page<T>>(data + path + "?" + new URLSearchParams(params));
}
export type Activity = {
  id?: string; sequence_id?: string | number; transaction_hash: string; timestamp: number; type: string;
  side: string; condition_id: string; asset: string; token_id?: string; slug: string; title: string;
  price: number; size: number; usdc_size: number; outcome?: string;
};
export type ComboPosition = {
  combo_condition_id: string; combo_position_id: string; proxy_wallet: string; entry_cost_usdc: number;
  gross_entry_cost_usdc: number; realized_payout_usdc: number; first_entry_at: string; status: string;
  legs: Combo["legs"];
};
export type Combo = {
  id: string; type: string; proxy_wallet: string; amount_usdc: number | null;
  combo_condition_id: string; combo_position_id: string; timestamp: number;
  legs: { leg_outcome_label: string; market: { title: string; slug?: string } }[];
};
export type Leader = { user_id: string; user_name?: string; name?: string; pnl: number; volume: number };
