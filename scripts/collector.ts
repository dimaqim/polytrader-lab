import { database, log } from "../server/db.ts";
import { marketBySlug, marketSocket, numeric, orderBook, parseBook, timestamp, type Market } from "../server/polymarket.ts";
import { distributeSignals, executeDecision, recordSignal, upsertMarket } from "../server/signals.ts";
import { btcRule } from "../lib/strategies.ts";
import { favorite, freshBook, makerProgress, type Book, type MakerPrint } from "../lib/simulator.ts";
import { deliverNotifications } from "../server/telegram.ts";

type Packet = Record<string, unknown>;
type MakerState = { market: Market; token: string; at: number; bid: number; ask: number; bidQueue: number; askQueue: number; generation: number };
const markets = new Map<string, Market>();
const books = new Map<string, Book>();
const makerQuotes = new Map<string, MakerState>();
const prints = new Map<string, MakerPrint[]>();
const done = new Set<string>();
let socket: WebSocket | undefined;
let generation = 0;
let lastPacket = 0;
let reconnectAt = 0;
let retries = 0;
let subscribed = new Set<string>();

function subscribe() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const active = new Set([...markets.values()].flatMap(m => m.endsAt > Date.now() ? m.tokens : []));
  const add = [...active].filter(token => !subscribed.has(token));
  const remove = [...subscribed].filter(token => !active.has(token));
  if (add.length) socket.send(JSON.stringify(subscribed.size ? { assets_ids: add, operation: "subscribe" } : { assets_ids: add, type: "market" }));
  if (remove.length) socket.send(JSON.stringify({ assets_ids: remove, operation: "unsubscribe" }));
  for (const token of remove) { books.delete(token); prints.delete(token); }
  subscribed = active;
}
function onPacket(event: Packet, at: number) {
  const asset = String(event.asset_id ?? "");
  const sourceAt = timestamp(event.timestamp);
  if (event.event_type === "book" && subscribed.has(asset)) {
    const book = parseBook(event, asset, at, "ws");
    if (book && (!books.has(asset) || book.sourceAt >= books.get(asset)!.sourceAt)) books.set(asset, book);
  } else if (event.event_type === "price_change" && Array.isArray(event.price_changes)) {
    for (const change of event.price_changes) {
      const current = books.get(String(change.asset_id));
      const size = numeric(change.size), price = numeric(change.price);
      if (!current || !Number.isFinite(sourceAt) || sourceAt < current.sourceAt || !(price > 0 && price < 1)
        || !(size >= 0 && Number.isFinite(size)) || !["BUY", "SELL"].includes(change.side)) continue;
      const side = change.side === "BUY" ? "bids" : "asks";
      const updated = current[side].filter(level => level.price !== price);
      if (size > 0) updated.push({ price, size });
      updated.sort((a, b) => side === "bids" ? b.price - a.price : a.price - b.price);
      books.set(current.asset, { ...current, [side]: updated, sourceAt, receivedAt: at });
    }
  } else if (event.event_type === "last_trade_price" && subscribed.has(asset)) {
    const price = numeric(event.price), size = numeric(event.size), side = event.side;
    if (!(price > 0 && price < 1 && size > 0 && Number.isFinite(size)) || (side !== "BUY" && side !== "SELL")) return;
    if (!Number.isFinite(sourceAt) || sourceAt > at + 500 || at - sourceAt > 5000) return;
    const series = prints.get(asset) ?? [];
    const last = series.at(-1);
    // Identical consecutive prints without a unique trade ID cannot safely be counted twice.
    if (last && last.price === price && last.size === size && last.side === side && at - last.receivedAt < 150) return;
    series.push({ side, price, size, receivedAt: at });
    prints.set(asset, series.filter(p => p.receivedAt > at - 180_000));
  }
}
function connect() {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  if (Date.now() < reconnectAt) return;
  const current = new WebSocket(marketSocket);
  socket = current;
  current.addEventListener("open", () => {
    generation++;
    books.clear(); prints.clear(); subscribed = new Set(); lastPacket = Date.now();
    subscribe();
  });
  current.addEventListener("message", ({ data }) => {
    const at = Date.now();
    lastPacket = at;
    retries = 0;
    if (typeof data !== "string" || data === "PONG") return;
    try {
      const parsed = JSON.parse(data);
      for (const event of Array.isArray(parsed) ? parsed : [parsed]) onPacket(event, at);
    } catch { /* A frame without a documented event shape does not change the book. */ }
  });
  current.addEventListener("close", () => {
    generation++;
    books.clear(); prints.clear(); lastPacket = 0;
    reconnectAt = Date.now() + Math.min(30_000, 500 * 2 ** retries++) + Math.random() * 300;
  });
  current.addEventListener("error", () => current.close());
}
async function catalog() {
  const now = Date.now();
  const jobs = [5, 15].flatMap(interval => {
    const duration = interval * 60_000, start = Math.floor(now / duration) * duration;
    return [start, start + duration].map(async time => {
      const market = await marketBySlug(`btc-updown-${interval}m-${time / 1000}`);
      if (!market?.open) return;
      await upsertMarket(market);
      markets.set(market.slug, market);
    });
  });
  for (const result of await Promise.allSettled(jobs)) if (result.status === "rejected") await log("collector_catalog", result.reason);
  for (const m of markets.values()) if (m.endsAt < now - 60_000) {
    markets.delete(m.slug); makerQuotes.delete(m.slug); done.delete("btc:" + m.slug); done.delete("maker:" + m.slug);
  }
  subscribe();
}
async function emitBtc(market: Market, observedAt: number) {
  const rule = btcRule(market.interval!, market.endsAt);
  const snapshots = market.tokens.map(token => books.get(token)).filter((book): book is Book => !!book);
  const selection = favorite(snapshots, observedAt, rule.threshold);
  const timingErrorMs = observedAt - rule.target;
  let reason = timingErrorMs > 1500 || snapshots.length !== 2 || !snapshots.every(b => freshBook(b, observedAt, 4000))
    ? "missing_collector_window" : selection ? undefined : "below_threshold";
  let minimum: number | undefined;
  if (!reason && selection) {
    try {
      minimum = (await orderBook(selection.book.asset))?.minimum;
      if (!minimum) reason = "missing_market_parameters";
    } catch { reason = "quote_api_error"; }
  }
  await recordSignal({ key: rule.strategy + ":" + market.slug, strategy: rule.strategy, condition: market.condition,
    token: selection?.book.asset, label: market.title, targetAt: rule.target, observedAt, expiresAt: market.endsAt - 1_000,
    reference: selection?.ask, reason, delayMs: 1000,
    evidence: { timingErrorMs, minimum, books: snapshots, source: "ws", threshold: rule.threshold } });
  await distributeSignals();
  if (!reason) {
    await Promise.allSettled([deliverNotifications(), (async () => {
      const wait = observedAt + 1000 - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      for (let i = 0; i < 12; i++) {
        const book = selection ? books.get(selection.book.asset) : undefined;
        if (!await executeDecision(undefined, rule.strategy, book)) break;
      }
    })()]);
  }
}
async function emitMaker(m: Market, at: number) {
  const q = makerQuotes.get(m.slug);
  const continuous = !!q && q.generation === generation && socket?.readyState === WebSocket.OPEN && at - lastPacket < 20_000;
  const series = q && continuous ? prints.get(q.token) ?? [] : [];
  const bought = q ? makerProgress(series, "BUY", q.bid, q.at, at) : 0;
  const buyConfirmedAt = q ? series.find(p => makerProgress(series, "BUY", q.bid, q.at, p.receivedAt) > q.bidQueue)?.receivedAt : undefined;
  const sold = q && buyConfirmedAt ? makerProgress(series, "SELL", q.ask, buyConfirmedAt, at) : 0;
  const modeledShares = q && continuous ? Math.max(0, Math.min(bought - q.bidQueue, sold - q.askQueue)) : 0;
  await recordSignal({ key: "maker:" + m.slug, strategy: "maker", condition: m.condition, token: q?.token,
    label: m.title, targetAt: m.endsAt - 120_000, observedAt: at, expiresAt: m.endsAt,
    reason: !continuous ? "maker_continuity_gap" : modeledShares > 0 ? "maker_research_estimate" : "maker_no_trade_through",
    evidence: { model: "strict_trade_through", quote: q, bought, sold, modeledShares,
      modeledSpread: q ? modeledShares * (q.ask - q.bid) : null, buyConfirmedAt, observedAt: at } });
  await distributeSignals();
}

const pending = new Set<Promise<unknown>>();
function schedule(work: Promise<unknown>) {
  pending.add(work);
  void work.catch(error => log("collector", error)).finally(() => pending.delete(work));
}
function checkWindows() {
  const at = Date.now();
  for (const m of markets.values()) {
    const rule = btcRule(m.interval!, m.endsAt);
    if (at >= rule.target && at < m.endsAt && !done.has("btc:" + m.slug)) {
      done.add("btc:" + m.slug);
      schedule(emitBtc(m, at));
    }
    if (m.interval !== 15) continue;
    if (!makerQuotes.has(m.slug) && at >= m.endsAt - 120_000 && at < m.endsAt - 117_000) {
      const book = books.get(m.tokens[0]);
      if (book && freshBook(book, at, 4000)) {
        const bid = book.bids[0], ask = book.asks[0];
        if (bid && ask && ask.price - bid.price >= 0.019999) makerQuotes.set(m.slug, {
          market: m, token: book.asset, at, bid: bid.price, ask: ask.price, bidQueue: bid.size, askQueue: ask.size, generation,
        });
      }
    }
    if (at >= m.endsAt - 10_000 && at < m.endsAt && !done.has("maker:" + m.slug)) {
      done.add("maker:" + m.slug);
      schedule(emitMaker(m, at));
    }
  }
}

let catalogRunning = false;
function refreshCatalog() {
  if (catalogRunning) return;
  catalogRunning = true;
  schedule(catalog().finally(() => { catalogRunning = false; }));
}
const timers = [
  setInterval(checkWindows, 125),
  setInterval(connect, 500),
  setInterval(refreshCatalog, 20_000),
  setInterval(() => {
    const connected = socket?.readyState === WebSocket.OPEN && Date.now() - lastPacket < 25_000;
    if (connected) socket?.send("PING"); else if (socket?.readyState === WebSocket.OPEN) socket.close();
    schedule(database()`insert into lab.heartbeats(source,at,details) values('collector',now(),${JSON.stringify({ connected, subscribed: subscribed.size })})
      on conflict(source) do update set at=excluded.at,details=excluded.details`);
  }, 10_000),
];
process.on("SIGINT", async () => {
  timers.forEach(clearInterval);
  socket?.close();
  await Promise.allSettled(pending);
});
connect();
refreshCatalog();
console.log("PolyTrader collector started");
