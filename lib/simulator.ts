export type Level = { price: number; size: number };
export type Book = {
  asset: string;
  bids: Level[];
  asks: Level[];
  sourceAt: number;
  receivedAt: number;
  source: "rest" | "ws";
};
export type Fee = { rate: number; exponent: number };
export type Fill = {
  shares: number; gross: number; fee: number; cost: number;
  price: number; slippageBps: number; partial: boolean;
};

export function takerFee(shares: number, price: number, fee: Fee) {
  return shares * fee.rate * (price * (1 - price)) ** fee.exponent;
}

export function marketBuy(book: Book, budget: number, reference: number, maxSlippageBps: number, fee: Fee, minShares = 0): Fill | null {
  if (![budget, reference, maxSlippageBps, fee.rate, fee.exponent, minShares].every(Number.isFinite)
    || budget <= 0 || reference <= 0 || reference >= 1 || maxSlippageBps < 0 || fee.rate < 0 || fee.exponent < 0) return null;
  const asks = [...book.asks].sort((a, b) => a.price - b.price);
  const limit = reference * (1 + maxSlippageBps / 10_000);
  let gross = 0;
  let fees = 0;
  let shares = 0;
  for (const { price, size } of asks) {
    if (price > limit + 1e-10) break;
    if (!(price > 0 && price < 1 && size > 0) || !Number.isFinite(size)) continue;
    const unitFee = takerFee(1, price, fee);
    const available = Math.max(0, budget - gross - fees) / (price + unitFee);
    const filled = Math.floor(Math.min(size, available) * 1e6) / 1e6;
    gross += filled * price;
    fees += filled * unitFee;
    shares += filled;
  }
  if (shares < Math.max(0.000001, minShares)) return null;
  const price = gross / shares;
  return { shares, gross, fee: fees, cost: gross + fees, price, slippageBps: (price / reference - 1) * 10_000, partial: budget - gross - fees > 0.000002 };
}

export function freshBook(book: Book | undefined, at: number, maximumAge: number) {
  return !!book && book.sourceAt <= book.receivedAt + 500 && book.receivedAt <= at
    && book.sourceAt <= at && at - book.sourceAt <= maximumAge;
}

export function favorite(books: Book[], at: number, threshold: number) {
  if (books.length !== 2 || books.some(book => !freshBook(book, at, 4_000))) return null;
  const quotes = books.map(book => ({ book, bid: book.bids[0]?.price, ask: book.asks[0]?.price }));
  if (quotes.some(({ bid, ask }) => !(bid > 0 && ask < 1 && ask > bid))) return null;
  const ranked = quotes.map(({ book, bid, ask }) => ({ book, ask, midpoint: (bid + ask) / 2 }))
    .sort((a, b) => b.midpoint - a.midpoint);
  return ranked[0].midpoint > 0.5 && ranked[0].midpoint > ranked[1].midpoint && ranked[0].ask >= threshold ? ranked[0] : null;
}

export type MakerPrint = { side: "BUY" | "SELL"; price: number; size: number; receivedAt: number };
export function makerProgress(prints: MakerPrint[], side: "BUY" | "SELL", limit: number, since: number, until: number) {
  return prints.reduce((sum, p) => {
    const through = side === "BUY" ? p.side === "SELL" && p.price < limit : p.side === "BUY" && p.price > limit;
    return through && p.receivedAt > since && p.receivedAt <= until ? sum + p.size : sum;
  }, 0);
}
