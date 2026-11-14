import { freshBook, takerFee, type Fee } from "../simulator.ts";
import type { Contract, ExecutionSource, LiveBook } from "./types.ts";

export const restAge = 6000;
export type TradingSource = Exclude<ExecutionSource,"NO_EXECUTABLE_DATA">;

export function restFresh(quote: LiveBook | undefined, token: string, at: number): quote is LiveBook & {rest:NonNullable<LiveBook["rest"]>} {
  return !!quote?.rest && quote.book.source==="rest" && quote.book.asset===token
    && quote.rest.receivedAt===quote.book.receivedAt && quote.rest.requestedAt<=quote.rest.receivedAt
    && quote.rest.receivedAt-quote.rest.requestedAt<=3500 && freshBook(quote.book,at,restAge);
}

export function restRecheck(signal: LiveBook, quote: LiveBook | undefined, token: string, readyAt: number, at: number) {
  return restFresh(quote,token,at) && !!signal.rest && quote.session===signal.session
    && quote.rest.condition===signal.rest.condition && quote.rest.requestId!==signal.rest.requestId
    && quote.rest.requestedAt>=readyAt && quote.book.sourceAt>=signal.book.sourceAt;
}

export type PaperFill = { shares: number; gross: number; fee: number; price: number; partial: boolean };

export function executable(quote: LiveBook | undefined, session: string | null, token: string, at: number, age: number,
  earliest = 0): quote is LiveBook {
  return !!quote && quote.session === session && quote.book.asset === token && quote.book.source === "ws"
    && quote.book.receivedAt >= earliest && freshBook(quote.book, at, age);
}

export function takeDepth(quote: LiveBook, market: Pick<Contract, "tick" | "minimum">, side: "BUY" | "SELL",
  budgetOrShares: number, limit: number, schedule: Fee): PaperFill | null {
  if (!(market.tick > 0 && market.minimum > 0 && budgetOrShares > 0 && limit > 0 && limit < 1)
    || ![market.tick, market.minimum, budgetOrShares, limit, schedule.rate, schedule.exponent].every(Number.isFinite)
    || schedule.rate < 0 || schedule.exponent < 0) return null;
  const levels = side === "BUY" ? quote.book.asks : quote.book.bids;
  let shares = 0, gross = 0, fee = 0;
  for (const { price, size } of levels) {
    if (side === "BUY" ? price > limit + 1e-9 : price < limit - 1e-9) break;
    if (Math.abs(price / market.tick - Math.round(price / market.tick)) > 1e-5 || !(size > 0)) return null;
    const feePerShare = takerFee(1, price, schedule);
    const left = side === "BUY" ? (budgetOrShares - gross - fee) / (price + feePerShare) : budgetOrShares - shares;
    const quantity = Math.max(0, Math.floor(Math.min(size, left) * 1e6 + 1e-8) / 1e6);
    shares += quantity;
    gross += quantity * price;
    fee += quantity * feePerShare;
  }
  shares = Math.round(shares * 1e6) / 1e6;
  if (shares + 1e-9 < market.minimum) return null;
  return { shares, gross, fee, price: gross / shares, partial: budgetOrShares - (side === "BUY" ? gross + fee : shares) > .00001 };
}

export function payoffTable(buckets: number, legs: { bucket: number; yes: boolean; shares: number }[]) {
  return Array.from({ length: buckets }, (_, winner) => legs.reduce((sum, leg) =>
    sum + ((leg.bucket === winner) === leg.yes ? leg.shares : 0), 0));
}
