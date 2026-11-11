import assert from "node:assert/strict";
import { test } from "node:test";
import { freshBook, favorite, marketBuy, makerProgress, takerFee, type Book } from "../lib/simulator.ts";
import { btcRule } from "../lib/strategies.ts";
import { maximumDrawdown, wilson } from "../lib/metrics.ts";

const book: Book = { asset: "1", asks: [{ price: 0.52, size: 100 }, { price: 0.5, size: 10 }],
  bids: [{ price: 0.49, size: 100 }], sourceAt: 9500, receivedAt: 9700, source: "ws" };

test("charges the documented fee, walks depth, caps debit and preserves partial liquidity", () => {
  assert.ok(Math.abs(takerFee(100, 0.95, { rate: 0.07, exponent: 1 }) - 0.3325) < 1e-10);
  const limited = marketBuy(book, 20, 0.5, 200, { rate: 0.07, exponent: 1 });
  assert.equal(limited?.shares, 10);
  assert.equal(limited?.partial, true);
  const full = marketBuy(book, 20, 0.5, 500, { rate: 0.07, exponent: 1 });
  assert.ok(full && full.price > 0.5 && full.price < 0.52 && full.cost <= 20 && full.fee > 0 && !full.partial);
  assert.equal(marketBuy(book, 20, 0.5, 200, { rate: 0, exponent: 1 }, 11), null);
});
test("rejects future and stale data and chooses only an eligible favorite", () => {
  assert.equal(freshBook(book, 9600, 4000), false);
  assert.equal(freshBook(book, 14000, 4000), false);
  const up = { ...book, asks: [{ price: 0.92, size: 20 }], bids: [{ price: 0.9, size: 20 }] };
  const down = { ...book, asset: "2", asks: [{ price: 0.10, size: 30 }], bids: [{ price: 0.08, size: 30 }] };
  assert.equal(favorite([down, up], 10000, 0.90)?.book.asset, "1");
  assert.equal(favorite([up, down], 10000, 0.93), null);
  assert.equal(favorite([up, down], 9600, 0.90), null);
  assert.deepEqual(btcRule(5, 60_000), { strategy: "btc5", target: 30_000, threshold: 0.5 });
  assert.deepEqual(btcRule(15, 90_000), { strategy: "btc15", target: 30_000, threshold: 0.9 });
});
test("maker requires a strict trade-through in the correct direction after placement", () => {
  assert.equal(makerProgress([
    { side: "SELL", price: 0.41, size: 9, receivedAt: 7 },
    { side: "SELL", price: 0.42, size: 5, receivedAt: 8 },
    { side: "BUY", price: 0.4, size: 4, receivedAt: 9 },
    { side: "SELL", price: 0.4, size: 3, receivedAt: 9 },
    { side: "SELL", price: 0.4, size: 2, receivedAt: 11 },
  ], "BUY", 0.42, 7, 10), 3);
});
test("metrics handle an empty sample and ordered drawdown", () => {
  assert.equal(wilson(0, 0), null);
  assert.ok(wilson(10, 10)![0] < 0.8);
  assert.ok(Math.abs(maximumDrawdown([100, 120, 90, 130, 110]) - 0.25) < 1e-10);
});
