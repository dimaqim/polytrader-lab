import { freshBook, takerFee, type Fee } from "../simulator.ts";
import type { Contract, LiveBook } from "./types.ts";

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
