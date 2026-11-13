import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { telegramIdentity } from "../server/auth.ts";
import { parseBook, parseMarket, request, UpstreamError } from "../server/polymarket.ts";

test("verifies Telegram initData signature and age", () => {
  const token = "test-token";
  const now = 1_795_000_000_000;
  const params = new URLSearchParams({ auth_date: String(now / 1000), user: JSON.stringify({ id: 1, first_name: "Test" }) });
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", key).update([...params].map(([k,v]) => k + "=" + v).join("\n")).digest("hex"));
  assert.deepEqual(telegramIdentity(params.toString(), token, now), { id: "1", name: "Test" });
  assert.equal(telegramIdentity(params.toString(), token, now + 901_000), null);
  assert.equal(telegramIdentity(params.toString() + "&auth_date=1", token, now), null);
  params.set("user", '{"id":2,"first_name":"Test"}');
  assert.equal(telegramIdentity(params.toString(), token, now), null);
});
test("uses official Gamma field names and only settles an explicitly resolved outcome", () => {
  const raw = { conditionId: "0x" + "a".repeat(64), slug: "btc-updown-15m-1793620500", endDate: "2026-11-05",
    question: "BTC", clobTokenIds: '["1","2"]', outcomes: '["Up","Down"]', outcomePrices: '["1","0"]',
    closed: true, acceptingOrders: false, feeSchedule: { rate: 0.07, exponent: 1 } };
  const parsed = parseMarket(raw, 1_795_000_000_000);
  assert.equal(parsed?.endsAt, 1_793_621_400_000);
  assert.equal(parsed?.payout, null);
  assert.deepEqual(parsed?.fee, { rate: 0.07, exponent: 1 });
  assert.deepEqual(parseMarket({ ...raw, umaResolutionStatus: "resolved" }, Date.now())?.payout, [1, 0]);
  assert.equal(parseMarket({ ...raw, clobTokenIds: '["1","1"]' }, Date.now()), null);
});
test("normalizes only the matching CLOB asset and sorts real levels", () => {
  const raw = { asset_id: "1", timestamp: "1793620500000", bids: [], asks: [{ price: "0.7", size: "8" }, { price: "0.6", size: "9" }] };
  assert.deepEqual(parseBook(raw, "1", 1793620501000, "rest")?.asks.map(x => x.price), [0.6, 0.7]);
  assert.equal(parseBook(raw, "2", 1793620501000, "rest"), null);
});
test("retries transient rate limiting and does not retry validation errors", async () => {
  let attempts = 0;
  assert.deepEqual(await request("https://example.com/endpoint", async () => {
    attempts++;
    return attempts === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : Response.json({ ok: true });
  }), { ok: true });
  assert.equal(attempts, 2);
  await assert.rejects(request("https://example.com/endpoint", async () => new Response(null, { status: 400 })), UpstreamError);
});

test("market scope excludes BTC and ETH outcomes and keeps unrelated markets", async () => {
  const { hiddenMarket } = await import("../lib/market-scope.ts");
  for (const title of ["BTC Up or Down", "Bitcoin above 110k?", "Ethereum vs. Solana", "Цена эфира", "Цена биткоина"]) {
    assert.equal(hiddenMarket(title), true, title);
  }
  assert.equal(hiddenMarket("Up or Down", "eth-updown-5m-1700000000"), true);
  for (const title of ["Weather in London", "Netherlands vs. France", "Beth wins", "Etheridge wins"]) {
    assert.equal(hiddenMarket(title), false, title);
  }
});

test("combo accounting separates paid redemptions, open positions and settled losses", async () => {
  const { comboMoney } = await import("../lib/combos.ts");
  const entry = 8438.39271;
  const gross = 8599.999994;
  const fee = 161.59802;
  const payout = 13715.098601;
  assert.deepEqual(comboMoney(entry, gross, fee, "OPEN", 0, null, false),
    { cost: gross, received: null, proceeds: null, profit: null });
  assert.deepEqual(comboMoney(entry, gross, fee, "RESOLVED_WIN", 0, null, true),
    { cost: gross, received: null, proceeds: null, profit: null });
  assert.deepEqual(comboMoney(entry, gross, fee, "RESOLVED_WIN", payout, null, false),
    { cost: gross, received: null, proceeds: payout, profit: 5115.10 });
  assert.deepEqual(comboMoney(entry, gross, fee, "RESOLVED_WIN", payout, payout, false),
    { cost: gross, received: payout, proceeds: payout, profit: 5115.10 });
  assert.deepEqual(comboMoney(2000, null, 20, "RESOLVED_LOSS", 0, null, false),
    { cost: 2020, received: 0, proceeds: 0, profit: -2020 });
  assert.equal(comboMoney(entry, null, null, "RESOLVED_WIN", payout, payout, false).profit, null);
});
