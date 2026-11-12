import { favorite, freshBook, type Book } from "./simulator.ts";

export const maxBtcBookAgeMs = 4_000;
export const maxWindowDelayMs = 1_500;

export function btcObservation(books: (Book | undefined)[], target: number, observed: number, threshold: number, connected: boolean) {
  const timingErrorMs = observed - target;
  const usable = books.filter((book): book is Book => book?.source === "ws" && freshBook(book, target, maxBtcBookAgeMs));
  if (!connected || timingErrorMs < 0 || timingErrorMs > maxWindowDelayMs || usable.length !== 2
    || usable[0].asset === usable[1].asset
    || usable.some(book => !book.bids.length || !book.asks.length || book.bids[0].price >= book.asks[0].price)) {
    return { timingErrorMs, selection: null, reason: "missing_collector_window" as const, books: usable };
  }
  const selection = favorite(usable, target, threshold);
  return { timingErrorMs, selection, reason: selection ? undefined : "below_threshold" as const, books: usable };
}
