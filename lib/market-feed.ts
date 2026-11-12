import type { Book, Level, MakerPrint } from "./simulator.ts";

type Packet = Record<string, unknown>;
type Trade = MakerPrint & { sourceAt: number; transactionHash?: string; feeRateBps?: number };
type Cursor = { at: number; keys: Set<string> };
type Result = { quotes: Book[]; trades: Trade[]; fault?: string; ignored: number; snapshots: number };

function object(value: unknown): Packet | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Packet : null;
}

function number(value: unknown) {
  return typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
}

function eventTime(value: unknown, receivedAt: number) {
  const at = number(value);
  return Number.isSafeInteger(at) && at >= 1e12 && at <= receivedAt + 500 ? at : null;
}

function readLevels(value: unknown, bids: boolean) {
  if (!Array.isArray(value)) return null;
  const seen = new Set<number>();
  const result: Level[] = [];
  for (const item of value) {
    const level = object(item);
    const price = number(level?.price);
    const size = number(level?.size);
    if (!(price > 0 && price < 1 && Number.isFinite(size) && size > 0) || seen.has(price)) return null;
    seen.add(price);
    result.push({ price, size });
  }
  return result.sort((a, b) => bids ? b.price - a.price : a.price - b.price);
}

function updateLevel(levels: Level[], price: number, size: number, bids: boolean) {
  const next = levels.filter(level => level.price !== price);
  if (size > 0) next.push({ price, size });
  return next.sort((a, b) => bids ? b.price - a.price : a.price - b.price);
}

/** Rebuilds books from the market channel. One instance belongs to one connection. */
export class MarketFeed {
  private assets = new Map<string, string>();
  private books = new Map<string, Book>();
  private quoteCursors = new Map<string, Cursor>();
  private tradeCursors = new Map<string, Cursor>();
  private prints = new Map<string, Trade[]>();

  subscribe(assets: ReadonlyMap<string, string>) {
    for (const [asset, condition] of this.assets) {
      if (assets.get(asset) === condition) continue;
      this.books.delete(asset);
      this.quoteCursors.delete(asset);
      this.tradeCursors.delete(asset);
      this.prints.delete(asset);
    }
    this.assets = new Map(assets);
  }

  book(asset: string) { return this.books.get(asset); }
  trades(asset: string, after: number) { return (this.prints.get(asset) ?? []).filter(t => t.receivedAt > after); }

  ingest(raw: string, receivedAt: number): Result {
    const result: Result = { quotes: [], trades: [], ignored: 0, snapshots: 0 };
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return { ...result, fault: "invalid_json" }; }
    for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
      const event = object(value);
      if (!event) return { ...result, fault: "invalid_event" };
      const error = this.apply(event, receivedAt, result);
      if (error) return { ...result, fault: error };
    }
    return result;
  }

  private cursor(map: Map<string, Cursor>, asset: string, at: number, key: string) {
    const prior = map.get(asset);
    if (prior && at < prior.at) return "older";
    if (prior?.at === at) {
      if (prior.keys.has(key)) return "duplicate";
      if (prior.keys.size >= 1000) return "overflow";
      prior.keys.add(key);
    } else map.set(asset, { at, keys: new Set([key]) });
    return "new";
  }

  private apply(event: Packet, receivedAt: number, result: Result): string | undefined {
    const type = event.event_type;
    if (type !== "book" && type !== "price_change" && type !== "last_trade_price") return;
    const market = typeof event.market === "string" ? event.market.toLowerCase() : null;
    const at = eventTime(event.timestamp, receivedAt);
    if (type === "price_change") {
      if (!Array.isArray(event.price_changes)) return "invalid_price_changes";
      const changesByAsset = new Map<string, Packet[]>();
      for (const row of event.price_changes) {
        const change = object(row);
        if (!change || typeof change.asset_id !== "string") return "invalid_price_change";
        if (!this.assets.has(change.asset_id)) continue;
        const batch = changesByAsset.get(change.asset_id) ?? [];
        batch.push(change);
        changesByAsset.set(change.asset_id, batch);
      }
      for (const [asset, changes] of changesByAsset) {
        if (market !== null && this.assets.get(asset) !== market) return "market_mismatch";
        const current = this.books.get(asset);
        if (!current) { result.ignored++; continue; }
        if (at === null || receivedAt - at > 30_000) return "invalid_quote_timestamp";
        const key = JSON.stringify(changes.map(c => [c.side, c.price, c.size, c.hash, c.best_bid, c.best_ask]));
        const sequence = this.cursor(this.quoteCursors, asset, at, key);
        if (sequence === "duplicate") { result.ignored++; continue; }
        if (sequence !== "new") return "out_of_order_quote";
        let { bids, asks } = current;
        for (const change of changes) {
          const price = number(change.price), size = number(change.size);
          if (!(price > 0 && price < 1 && size >= 0 && Number.isFinite(size))) return "invalid_depth";
          if (change.side === "BUY") bids = updateLevel(bids, price, size, true);
          else if (change.side === "SELL") asks = updateLevel(asks, price, size, false);
          else return "invalid_side";
        }
        const last = changes.at(-1)!;
        const bid = bids[0]?.price ?? 0, ask = asks[0]?.price ?? 1;
        if (bid >= ask
          || (last.best_bid != null && number(last.best_bid) !== bid)
          || (last.best_ask != null && number(last.best_ask) !== ask)) return "book_out_of_sync";
        const book = { ...current, bids, asks, sourceAt: at, receivedAt };
        this.books.set(asset, book);
        result.quotes.push(book);
      }
      return;
    }

    const asset = typeof event.asset_id === "string" ? event.asset_id : "";
    if (!this.assets.has(asset)) return;
    if (market !== null && this.assets.get(asset) !== market) return "market_mismatch";
    if (at === null) return "invalid_event_timestamp";
    if (type === "book") {
      if (receivedAt - at > 30_000) { result.ignored++; return; }
      const bids = readLevels(event.bids, true), asks = readLevels(event.asks, false);
      if (!bids || !asks || (bids[0]?.price ?? 0) >= (asks[0]?.price ?? 1)) return "invalid_snapshot";
      const key = JSON.stringify([event.hash, bids, asks]);
      const sequence = this.cursor(this.quoteCursors, asset, at, key);
      if (sequence === "duplicate" || sequence === "older") { result.ignored++; return; }
      if (sequence !== "new") return "snapshot_sequence_overflow";
      const book: Book = { asset, bids, asks, sourceAt: at, receivedAt, source: "ws" };
      this.books.set(asset, book);
      result.quotes.push(book);
      result.snapshots++;
      return;
    }

    const side = event.side, price = number(event.price), size = number(event.size);
    if (!(price > 0 && price < 1 && size > 0 && Number.isFinite(size)) || (side !== "BUY" && side !== "SELL")) return "invalid_trade";
    if (!this.books.has(asset) || receivedAt - at > 5_000) { result.ignored++; return; }
    const transactionHash = typeof event.transaction_hash === "string" ? event.transaction_hash : undefined;
    const sequence = this.cursor(this.tradeCursors, asset, at, JSON.stringify([transactionHash, side, price, size]));
    if (sequence === "duplicate") { result.ignored++; return; }
    if (sequence !== "new") return "out_of_order_trade";
    const fee = number(event.fee_rate_bps);
    const trade: Trade = { side, price, size, sourceAt: at, receivedAt, transactionHash, feeRateBps: Number.isFinite(fee) ? fee : undefined };
    const history = this.prints.get(asset) ?? [];
    let first = 0;
    while (first < history.length && history[first].receivedAt < receivedAt - 180_000) first++;
    if (first) history.splice(0, first);
    if (history.length >= 40_000) return "trade_buffer_overflow";
    history.push(trade);
    this.prints.set(asset, history);
    result.trades.push(trade);
  }
}
