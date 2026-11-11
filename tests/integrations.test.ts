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
