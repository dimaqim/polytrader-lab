import assert from "node:assert/strict";
import test from "node:test";
import { MarketFeed } from "../lib/market-feed.ts";
import { btcObservation } from "../lib/collector-window.ts";
import { btcRule } from "../lib/strategies.ts";

const now = 1_789_000_000_000;
const market = "0xabc";
const assets = new Map([["1001", market], ["1002", market]]);
const level = (price: number, size: number) => ({ price: String(price), size: String(size) });
const snapshot = (asset: string, timestamp: number, bid: number, ask: number) => ({
  event_type: "book", market, asset_id: asset, timestamp: String(timestamp), bids: [level(bid, 10)], asks: [level(ask, 8)],
});
const delta = (timestamp: number, ...changes: object[]) => ({
  event_type: "price_change", timestamp: String(timestamp), price_changes: changes,
});
const change = (price: number, size: number, side: string, bid: number, ask: number) => ({
  asset_id: "1001", ...level(price, size), side, best_bid: String(bid), best_ask: String(ask),
});
const ingest = (feed: MarketFeed, event: unknown, at: number) => feed.ingest(JSON.stringify(event), at);

test("a new subscription waits for a full snapshot and rebuilds depth from batched updates", () => {
  const feed = new MarketFeed();
  feed.subscribe(assets);
  assert.equal(ingest(feed, delta(now, change(.9, 50, "BUY", .9, .95)), now).ignored, 1);
  assert.equal(feed.book("1001"), undefined);
  assert.equal(ingest(feed, [snapshot("1001", now, .9, .96), snapshot("1002", now, .04, .1)], now).quotes.length, 2);
  const before = feed.book("1001");
  const event = delta(now + 20, change(.96, 0, "SELL", .9, 1), change(.95, 12, "SELL", .9, .95));
  const result = ingest(feed, event, now + 30);
  assert.equal(result.fault, undefined);
  assert.deepEqual(result.quotes[0].asks, [{ price: .95, size: 12 }]);
  assert.deepEqual(before?.asks, [{ price: .96, size: 8 }]);
  assert.equal(ingest(feed, event, now + 500).ignored, 1);
  assert.equal(feed.book("1001")?.receivedAt, now + 30);
  assert.equal(ingest(feed, delta(now + 20, change(.89, 11, "BUY", .9, .95)), now + 40).fault, undefined);
  assert.equal(ingest(feed, delta(now + 19, change(.89, 4, "BUY", .9, .95)), now + 41).fault, "out_of_order_quote");
});

test("mismatch invalidates execution, and removing or reconnecting drops the prior order book", () => {
  const feed = new MarketFeed();
  feed.subscribe(assets);
  ingest(feed, snapshot("1001", now, .9, .95), now);
  assert.equal(ingest(feed, delta(now + 1, change(.85, 10, "SELL", .9, .85)), now + 3).fault, "book_out_of_sync");
  feed.subscribe(new Map([["1002", market]]));
  assert.equal(feed.book("1001"), undefined);
  assert.equal(ingest(feed, snapshot("1001", now + 9, .91, .96), now + 9).quotes.length, 0);
  const next = new MarketFeed();
  next.subscribe(assets);
  assert.equal(ingest(next, delta(now + 20, change(.95, 10, "SELL", .9, .95)), now + 20).ignored, 1);
  assert.equal(ingest(next, snapshot("1001", now, .9, .95), now + 40_000).ignored, 1);
  assert.equal(ingest(next, snapshot("1001", now + 40_000, .9, .95), now + 40_000).quotes.length, 1);
});

test("duplicate prints cannot inflate Market Making volume", () => {
  const feed = new MarketFeed();
  feed.subscribe(assets);
  ingest(feed, snapshot("1001", now, .9, .95), now);
  const trade = { event_type: "last_trade_price", market, asset_id: "1001", timestamp: String(now + 20),
    price: ".88", size: "25", side: "SELL", transaction_hash: "0xdeadbeef", fee_rate_bps: "30" };
  assert.equal(ingest(feed, trade, now + 25).trades[0].feeRateBps, 30);
  assert.equal(ingest(feed, trade, now + 30).ignored, 1);
  assert.equal(feed.trades("1001", now).length, 1);
});

test("BTC v1 uses the exact T−60/T−30 cutoff and rejects post-window, stale and disconnected books", () => {
  const feed = new MarketFeed();
  feed.subscribe(assets);
  ingest(feed, [snapshot("1001", now - 2, .88, .9), snapshot("1002", now - 2, .1, .12)], now - 1);
  const books = [feed.book("1001"), feed.book("1002")];
  assert.deepEqual(btcRule(15, now + 60_000), { strategy: "btc15", target: now, threshold: .9 });
  assert.deepEqual(btcRule(5, now + 30_000), { strategy: "btc5", target: now, threshold: .5 });
  assert.equal(btcObservation(books, now, now + 40, .9, true).selection?.ask, .9);
  assert.equal(btcObservation(books, now, now + 40, .91, true).reason, "below_threshold");
  assert.equal(btcObservation(books, now, now + 1501, .9, true).reason, "missing_collector_window");
  assert.equal(btcObservation(books, now, now, .9, false).reason, "missing_collector_window");
  assert.equal(btcObservation([{ ...books[0]!, receivedAt: now + 1 }, books[1]], now, now + 40, .9, true).selection, null);
  assert.equal(btcObservation(books, now + 4001, now + 4001, .9, true).selection, null);
});

test("weather can quarantine one token until a new snapshot without exposing its bad depth", () => {
  const feed = new MarketFeed(true);
  feed.subscribe(assets);
  ingest(feed, [snapshot("1001", now, .9, .95), snapshot("1002", now, .04, .1)], now);
  const result=ingest(feed, delta(now+1, change(.85,10,"SELL",.9,.85)), now+2);
  assert.deepEqual(result.invalidated,[{asset:"1001",reason:"book_out_of_sync"}]);
  assert.equal(result.fault,undefined);
  assert.equal(feed.book("1001"),undefined);
  assert.equal(feed.book("1002")?.asks[0].price,.1);
  assert.equal(ingest(feed,delta(now+3,change(.9,20,"BUY",.9,.95)),now+3).ignored,1);
  assert.equal(ingest(feed,snapshot("1001",now+4,.9,.95),now+5).snapshots,1);
});
