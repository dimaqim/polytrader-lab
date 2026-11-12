import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { database, log } from "../server/db.ts";
import { marketBySlug, marketSocket, orderBook, type Market } from "../server/polymarket.ts";
import { distributeSignals, executeDecision, recordSignal, upsertMarket } from "../server/signals.ts";
import { btcRule } from "../lib/strategies.ts";
import { freshBook, makerProgress } from "../lib/simulator.ts";
import { btcObservation, maxBtcBookAgeMs } from "../lib/collector-window.ts";
import { deliverNotifications } from "../server/telegram.ts";
import { MarketFeed } from "../lib/market-feed.ts";

type MakerQuote = { token: string; at: number; bid: number; ask: number; bidQueue: number; askQueue: number; session: string };
type Connection = { socket: WebSocket; feed: MarketFeed; session: string; subscribed: Set<string>; initialized: boolean;
  openedAt: number; lastFrameAt: number; lastPongAt: number; nextPingAt: number; pingSentAt: number; steady: boolean };
type Fault = { code: string; at: string };

const probeArgument = process.argv.find(arg => arg.startsWith("--probe="));
const probe = probeArgument !== undefined;
const seconds = probe ? Number(probeArgument!.slice("--probe=".length)) : 0;
if (probe && (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600)) {
  console.error("Provide --probe=SECONDS (15–3600).");
  process.exit(64);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing.");
  process.exit(78);
}

const markets = new Map<string, Market>();
const minimums = new Map<string, { shares: number; at: number }>();
const makerQuotes = new Map<string, MakerQuote>();
const handled = new Map<string, number>();
const pending = new Set<Promise<void>>();
const latency: { at: number; ms: number }[] = [];
let connection: Connection | undefined;
let lastError: Fault | undefined;
let lastQuoteAt = 0;
let reconnectAt = 0;
let attempts = 0;
let stopping = false;
let drainUntil = 0;
let catalogRunning = false;
let heartbeatRunning = false;
let executionRunning = false;
let catalogError: Fault | undefined;
let clockSkewMs: number | null = null;
let lastLogged: Fault | undefined;
const totals = { connections: 0, subscriptions: 0, unsubscriptions: 0, snapshots: 0, updates: 0, quotes: 0, trades: 0, ignored: 0, observed: 0, missed: 0 };

function report(event: string, detail: object = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

function issue(code: string) {
  const fault = { code, at: new Date().toISOString() };
  lastError = fault;
  report("websocket_error", fault);
  if (!probe && (lastLogged?.code !== code || Date.now() - Date.parse(lastLogged.at) >= 300_000)) {
    lastLogged = fault;
    schedule("websocket_log", () => log("collector_ws", new Error(code)));
  }
}

function schedule(area: string, action: () => Promise<unknown>) {
  const task = Promise.resolve().then(action).then(() => {}).catch(async () => {
    report("collector_error", { code: area });
    if (!probe && area !== "heartbeat") await log("collector", new Error(area));
  }).finally(() => pending.delete(task));
  pending.add(task);
}

function synchronizeSubscriptions(c: Connection) {
  if (c.socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const tokens = new Map([...markets.values()].filter(m => m.endsAt > now && m.seenAt >= now - 240_000)
    .flatMap(m => m.tokens.map(t => [t, m.condition] as const)));
  const add = [...tokens.keys()].filter(t => !c.subscribed.has(t));
  const remove = [...c.subscribed].filter(t => !tokens.has(t));
  c.feed.subscribe(tokens);
  if (add.length) {
    c.socket.send(JSON.stringify(c.initialized ? { assets_ids: add, operation: "subscribe" } : { assets_ids: add, type: "market" }));
    c.initialized = true;
    totals.subscriptions += add.length;
    report("subscribed", { tokens: add.length, markets: tokens.size / 2 });
  }
  if (remove.length) {
    c.socket.send(JSON.stringify({ assets_ids: remove, operation: "unsubscribe" }));
    totals.unsubscriptions += remove.length;
    report("unsubscribed", { tokens: remove.length });
  }
  c.subscribed = new Set(tokens.keys());
}

function connected(c: Connection | undefined, now = Date.now()): c is Connection {
  return !!c && c.socket.readyState === WebSocket.OPEN && c.openedAt > 0
    && now - c.lastPongAt < 22_000 && (!c.pingSentAt || now - c.pingSentAt < 8_000);
}

function abortConnection(c: Connection, code: string) {
  if (c !== connection) return;
  issue(code);
  connection = undefined;
  reconnectAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempts++, 8)) + Math.random() * 300;
  c.socket.terminate();
}

function connect() {
  if (stopping || connection || Date.now() < reconnectAt || !markets.size) return;
  const socket = new WebSocket(marketSocket, { handshakeTimeout: 8_000, maxPayload: 2_000_000 });
  const c: Connection = { socket, feed: new MarketFeed(), session: randomUUID(), subscribed: new Set(), initialized: false,
    openedAt: 0, lastFrameAt: 0, lastPongAt: 0, nextPingAt: 0, pingSentAt: 0, steady: false };
  connection = c;
  socket.on("upgrade", response => {
    if (connection === c) report("websocket_upgrade", { httpStatus: response.statusCode });
  });
  socket.on("open", () => {
    if (connection !== c) return;
    const now = Date.now();
    c.openedAt = now;
    c.lastFrameAt = now;
    c.nextPingAt = now;
    totals.connections++;
    synchronizeSubscriptions(c);
    report("websocket_open");
  });
  socket.on("message", (raw, binary) => {
    if (connection !== c) return;
    const at = Date.now();
    c.lastFrameAt = at;
    const data = raw.toString();
    if (data === "PONG") {
      c.lastPongAt = at;
      c.pingSentAt = 0;
      return;
    }
    if (binary) { abortConnection(c, "binary_frame"); return; }
    // Freeze every due decision before applying a frame received after its target.
    checkWindows(at);
    const result = c.feed.ingest(data, at);
    if (result.fault) { abortConnection(c, result.fault); return; }
    if (result.snapshots && totals.snapshots === 0) report("first_book", { snapshots: result.snapshots });
    const updates = result.quotes.length - result.snapshots;
    if (updates && totals.updates === 0) report("first_quote_update", { updates });
    totals.snapshots += result.snapshots;
    totals.updates += updates;
    totals.quotes += result.quotes.length;
    totals.trades += result.trades.length;
    totals.ignored += result.ignored;
    if (result.quotes.length) {
      lastQuoteAt = at;
      if (!latency.length || at - latency.at(-1)!.at >= 125) {
        latency.push({ at, ms: Math.max(0, at - result.quotes.at(-1)!.sourceAt) });
        while (latency.length > 2_400) latency.shift();
      }
    }
    if (!c.steady && connected(c, at) && at - c.openedAt >= 15_000 && result.quotes.length) {
      c.steady = true;
      attempts = 0;
    }
  });
  socket.on("error", (error: Error & { code?: string }) => {
    const code = error.code && /^[A-Z][A-Z0-9_]{1,59}$/.test(error.code) ? error.code
      : /opening handshake.*timed out/i.test(error.message) ? "handshake_timeout"
      : /^Unexpected server response: \d{3}$/.test(error.message) ? "http_" + error.message.slice(-3) : "socket_error";
    abortConnection(c, code);
  });
  socket.on("close", code => abortConnection(c, "close_" + code));
}

async function catalog() {
  const now = Date.now();
  const rows = await database()`select condition,slug,title,ends_at,interval_minutes,tokens,outcomes,prices,fee,payout,open,seen_at,statement_timestamp() as server_at
    from lab.markets where open and interval_minutes in (5,15) and ends_at>now()
    and ends_at<now()+interval '35 minutes' and seen_at>now()-interval '4 minutes'`;
  const received = Date.now();
  if (rows.length && received - now < 2_000) clockSkewMs = Math.round(+new Date(rows[0].server_at) - (now + received) / 2);
  const candidates = new Map<string, Market>();
  for (const m of rows) candidates.set(m.slug, {
    condition: m.condition, slug: m.slug, title: m.title, endsAt: +new Date(m.ends_at), interval: m.interval_minutes,
    tokens: m.tokens, outcomes: m.outcomes, prices: m.prices, fee: m.fee, payout: m.payout, open: m.open, seenAt: +new Date(m.seen_at),
  });
  const missing: string[] = [];
  for (const interval of [5, 15]) {
    const duration = interval * 60_000;
    const start = Math.floor(now / duration) * duration;
    for (const at of [start, start + duration]) {
      const slug = `btc-updown-${interval}m-${at / 1000}`;
      if (!candidates.has(slug)) missing.push(slug);
    }
  }
  // The regular Neon worker is the first source. Look up a missing round by its official Gamma slug.
  const refresh = Promise.allSettled(missing.map(async slug => {
    const market = await marketBySlug(slug);
    if (!market?.open || market.endsAt <= Date.now()) return;
    if (!probe) await upsertMarket(market);
    markets.set(slug, market);
    if (connection) synchronizeSubscriptions(connection);
  }));
  // Subscribe to known markets immediately instead of waiting for REST metadata or a Gamma miss.
  for (const [slug, market] of candidates) markets.set(slug, market);
  for (const [slug, market] of markets) {
    if (market.endsAt >= now - 60_000 && market.seenAt >= now - 240_000) continue;
    markets.delete(slug);
    makerQuotes.delete(slug);
    for (const token of market.tokens) minimums.delete(token);
  }
  for (const [key, until] of handled) if (until <= now - 60_000) handled.delete(key);
  if (connection) synchronizeSubscriptions(connection); else connect();
  const missingResults = await refresh;
  const metadata = probe ? [] : await Promise.allSettled([...markets.values()].filter(m => m.endsAt > now)
    .flatMap(m => m.tokens.filter(t => !minimums.has(t))).map(async token => {
      const quote = await orderBook(token);
      if (quote) minimums.set(token, { shares: quote.minimum, at: Date.now() });
    }));
  if (missingResults.some(result => result.status === "rejected")) {
    catalogError = { code: "catalog_gamma_unavailable", at: new Date().toISOString() };
    report("catalog_warning", catalogError);
  } else if (metadata.some(result => result.status === "rejected")) {
    catalogError = { code: "market_minimum_unavailable", at: new Date().toISOString() };
    report("catalog_warning", catalogError);
  } else catalogError = undefined;
}

function watchBtc(market: Market, observedAt: number) {
  const rule = btcRule(market.interval!, market.endsAt);
  const c = connection;
  const result = btcObservation(market.tokens.map(token => c?.feed.book(token)), rule.target, observedAt,
    rule.threshold, connected(c, observedAt) && Math.abs(clockSkewMs ?? 0) < 1_000);
  const selection = result.selection;
  const marketMinimum = selection ? minimums.get(selection.book.asset) : undefined;
  const minimum = marketMinimum && marketMinimum.at <= rule.target ? marketMinimum.shares : undefined;
  const fee = market.seenAt <= rule.target ? market.fee : null;
  const reason = result.reason ?? (minimum && fee ? undefined : "missing_market_parameters");
  if (result.reason === "missing_collector_window") totals.missed++; else totals.observed++;
  report("btc_window", { strategy: rule.strategy, targetAt: new Date(rule.target).toISOString(),
    timingErrorMs: result.timingErrorMs, result: result.reason ?? "favorite", reason: probe ? result.reason : reason });
  if (probe) return;
  const signal = { key: rule.strategy + ":" + market.slug, strategy: rule.strategy, condition: market.condition,
    token: selection?.book.asset, label: market.title, targetAt: rule.target, observedAt, expiresAt: market.endsAt - 1_000,
    reference: selection?.ask, reason, delayMs: 1000,
    evidence: { timingErrorMs: result.timingErrorMs, windowObserved: result.reason !== "missing_collector_window",
      minimum, minimumObservedAt: marketMinimum?.at, clockSkewMs, books: result.books, source: "ws", threshold: rule.threshold, feedSession: c?.session, fee,
      bestBid: selection?.book.bids[0], bestAsk: selection?.book.asks[0], availableShares: selection?.book.asks.reduce((sum, level) => sum + level.size, 0) } };
  schedule("btc_signal", async () => {
    let signalId: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try { signalId = await recordSignal(signal); break; }
      catch (error) { if (attempt === 2) throw error; await sleep(250 * 2 ** attempt); }
    }
    if (!signalId) return;
    if (!reason) drainUntil = Math.max(drainUntil, signal.expiresAt);
    await distributeSignals(signalId);
    if (!reason) await deliverNotifications(signalId);
  });
}

function watchMaker(m: Market, at: number) {
  const q = makerQuotes.get(m.slug), c = connection;
  const continuous = !!q && connected(c, at) && q.session === c.session && Math.abs(clockSkewMs ?? 0) < 1_000;
  const series = q && continuous ? c.feed.trades(q.token, q.at) : [];
  const bought = q ? makerProgress(series, "BUY", q.bid, q.at, at) : 0;
  let boughtAt: number | undefined;
  let volume = 0;
  if (q) for (const print of series) {
    if (print.receivedAt > at || print.side !== "SELL" || print.price >= q.bid) continue;
    volume += print.size;
    if (volume > q.bidQueue) { boughtAt = print.receivedAt; break; }
  }
  const sold = q && boughtAt ? makerProgress(series, "SELL", q.ask, boughtAt, at) : 0;
  const modeledShares = q && continuous ? Math.max(0, Math.min(bought - q.bidQueue, sold - q.askQueue)) : 0;
  const reason = !continuous ? "maker_continuity_gap" : modeledShares > 0 ? "maker_research_estimate" : "maker_no_trade_through";
  report("maker_window", { reason, prints: series.length });
  if (probe) return;
  schedule("maker_signal", async () => {
    await recordSignal({ key: "maker:" + m.slug, strategy: "maker", condition: m.condition, token: q?.token,
      label: m.title, targetAt: m.endsAt - 120_000, observedAt: at, expiresAt: m.endsAt, reason,
      evidence: { model: "strict_trade_through", quote: q, bought, sold, modeledShares,
        tradeThrough: q ? series.filter(p => (p.side === "SELL" && p.price < q.bid) ||
          (boughtAt != null && p.side === "BUY" && p.price > q.ask && p.receivedAt > boughtAt)) : [],
        modeledSpread: q ? modeledShares * (q.ask - q.bid) : null, buyConfirmedAt: boughtAt, observedAt: at } });
    await distributeSignals();
  });
}

function checkWindows(at: number) {
  if (stopping) return;
  for (const m of markets.values()) {
    const rule = btcRule(m.interval!, m.endsAt);
    const key = "btc:" + m.slug;
    if (at >= rule.target && at < m.endsAt && !handled.has(key)) {
      handled.set(key, m.endsAt);
      watchBtc(m, at);
    }
    if (m.interval !== 15) continue;
    const c = connection;
    if (!makerQuotes.has(m.slug) && at >= m.endsAt - 120_000 && at < m.endsAt - 117_000 && connected(c, at)) {
      const book = c.feed.book(m.tokens[0]);
      const bid = book?.bids[0], ask = book?.asks[0];
      if (book && bid && ask && freshBook(book, at, 4_000) && ask.price - bid.price >= 0.019999) {
        makerQuotes.set(m.slug, { token: book.asset, at, bid: bid.price, ask: ask.price,
          bidQueue: bid.size, askQueue: ask.size, session: c.session });
      }
    }
    const makerKey = "maker:" + m.slug;
    if (at >= m.endsAt - 10_000 && at < m.endsAt && !handled.has(makerKey)) {
      handled.set(makerKey, m.endsAt);
      watchMaker(m, at);
    }
  }
}

const live = {
  isCurrent(session: string) { const c = connection; return connected(c) && c.session === session && Math.abs(clockSkewMs ?? 0) < 1_000; },
  async get({ token, session, readyAt, expiresAt }: { token: string; session: string; readyAt: number; expiresAt: number }) {
    const until = Math.min(expiresAt, Date.now() + 2_000);
    const earliestReceipt = readyAt + Math.max(0, -(clockSkewMs ?? 0));
    while (Date.now() < until && live.isCurrent(session)) {
      const book = connection?.feed.book(token);
      if (book && book.receivedAt >= earliestReceipt && freshBook(book, Date.now(), maxBtcBookAgeMs)) return book;
      await sleep(50);
    }
    return undefined;
  },
};

function heartbeatDetails(now: number) {
  const c = connection;
  const tracked = [...markets.values()].filter(m => m.endsAt > now && m.seenAt >= now - 240_000);
  const ready = connected(c, now) ? tracked.filter(m => m.tokens.every(t => freshBook(c.feed.book(t), now, maxBtcBookAgeMs))).length : 0;
  const status = stopping ? "disconnected" : ready > 0 && Math.abs(clockSkewMs ?? 0) < 1_000 ? "connected" : c?.socket.readyState === WebSocket.OPEN ? "syncing"
    : lastError ? "reconnecting" : "connecting";
  const recent = latency.filter(sample => now - sample.at <= 300_000).map(sample => sample.ms).sort((a, b) => a - b);
  return { connected: status === "connected", socketOpen: !stopping && c?.socket.readyState === WebSocket.OPEN, status, trackedMarkets: tracked.length, readyMarkets: ready,
    lastQuoteAt: lastQuoteAt ? new Date(lastQuoteAt).toISOString() : null,
    averageLatencyMs: recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
    p50LatencyMs: recent.length ? recent[Math.ceil(recent.length * .5) - 1] : null,
    p95LatencyMs: recent.length ? recent[Math.ceil(recent.length * .95) - 1] : null, latencySamples: recent.length,
    clockSkewMs, lastError, catalogError, totals };
}

async function publishHeartbeat() {
  const details = heartbeatDetails(Date.now());
  report("heartbeat", details);
  if (probe) return;
  await database()`insert into lab.heartbeats(source,at,details) values('collector',now(),${JSON.stringify(details)})
    on conflict(source) do update set at=excluded.at,details=excluded.details`;
}

function refreshCatalog() {
  if (catalogRunning || stopping) return;
  catalogRunning = true;
  schedule("catalog", async () => {
    try { await catalog(); }
    catch (error) { catalogError = { code: "catalog_db_unavailable", at: new Date().toISOString() }; throw error; }
    finally { catalogRunning = false; }
  });
}
function heartbeat() {
  if (heartbeatRunning || stopping) return;
  heartbeatRunning = true;
  schedule("heartbeat", () => publishHeartbeat().finally(() => { heartbeatRunning = false; }));
}
function connectionTick() {
  const c = connection;
  if (!c) { connect(); return; }
  if (c.socket.readyState !== WebSocket.OPEN || !c.initialized) return;
  const now = Date.now();
  if (c.pingSentAt && now - c.pingSentAt >= 8_000) { abortConnection(c, "pong_timeout"); return; }
  if (now >= c.nextPingAt) {
    c.pingSentAt = now;
    c.nextPingAt = now + 10_000;
    c.socket.send("PING");
  }
  if (now - c.lastFrameAt >= 25_000) abortConnection(c, "frame_timeout");
  else if (trackedExpired(c, now)) synchronizeSubscriptions(c);
}
function trackedExpired(c: Connection, now: number) {
  return [...markets.values()].some(m => m.endsAt <= now && m.tokens.some(t => c.subscribed.has(t)));
}

const timers = [
  setInterval(() => checkWindows(Date.now()), 50),
  setInterval(connectionTick, 250),
  setInterval(refreshCatalog, 15_000),
  setInterval(heartbeat, 10_000),
];
if (!probe) timers.push(setInterval(() => {
  if (executionRunning || stopping || Date.now() >= drainUntil) return;
  executionRunning = true;
  schedule("btc_execution", async () => {
    try { for (let i = 0; i < 12 && !stopping && await executeDecision(undefined, undefined, live); i++) { /* drain ready decisions */ } }
    finally { executionRunning = false; }
  });
}, 750));

async function stop(exitCode?: number) {
  if (stopping) return;
  stopping = true;
  timers.forEach(clearInterval);
  const c = connection;
  connection = undefined;
  c?.socket.terminate();
  const finished = Promise.allSettled(pending).then(() => publishHeartbeat());
  await Promise.race([finished.catch(() => report("collector_error", { code: "final_heartbeat" })), sleep(4_000, undefined, { ref: false })]);
  report("stopped", { totals });
  if (exitCode != null) process.exitCode = exitCode;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
if (probe) timers.push(setTimeout(() => void stop(totals.snapshots > 0 && totals.updates > 0 ? 0 : 1), seconds * 1000));
refreshCatalog();
heartbeat();
report("started", { probe, pid: process.pid });
