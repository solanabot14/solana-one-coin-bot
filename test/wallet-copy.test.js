"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-copy-test-"));
process.env.WALLET_COPY_DATA_DIR = stateDir;
const follower = require("../walletCopy");
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test("Decu follower is configured as a paper account with fixed $5 entries", () => {
  const account = follower.getPortfolio();
  assert.equal(account.startingBalance, 200);
  assert.equal(follower.TRADE_SIZE, 5);
  assert.equal(follower.MAX_POSITIONS, 40);
});

test("swap parser identifies token legs belonging to the followed wallet", () => {
  const mint = "TokenMint111111111111111111111111111111111";
  const events = follower.swapDeltas({
    type: "SWAP",
    tokenTransfers: [
      { mint, tokenAmount: 12.5, fromUserAccount: "Pool111", toUserAccount: follower.WALLET },
      { mint, tokenAmount: 3, fromUserAccount: follower.WALLET, toUserAccount: "Pool111" }
    ]
  });
  assert.deepEqual(events, [{ mint, delta: 9.5 }]);
});

test("each buy adds $5 and observed partial sells reduce the paper lot proportionally", async () => {
  const mint = "TokenMint222222222222222222222222222222222";
  follower.setMarketData(async () => ({
    priceUsd: "0.01", liquidityUsd: 100000, symbol: "TEST", name: "Test token",
    pairAddress: "Pair11111111111111111111111111111111111"
  }));
  const buy = (signature, amount) => follower.processTransaction({
    type: "SWAP", signature, timestamp: 1791820800,
    tokenTransfers: [{ mint, tokenAmount: amount, fromUserAccount: "Pool111", toUserAccount: follower.WALLET }]
  });
  await buy("buy-1", 100);
  await buy("buy-2", 50);
  let account = follower.getPortfolio();
  assert.equal(account.cashBalance, 190);
  assert.equal(account.positions.length, 1);
  assert.equal(account.positions[0].amountInvested, 10);
  assert.equal(account.history.filter(row => row.type === "BUY").length, 2);
  const beforeSell = account.positions[0].quantity;

  await follower.processTransaction({
    type: "SWAP", signature: "sell-1", timestamp: 1791820802,
    tokenTransfers: [{ mint, tokenAmount: 25, fromUserAccount: follower.WALLET, toUserAccount: "Pool111" }]
  });
  account = follower.getPortfolio();
  assert.equal(account.positions.length, 1);
  assert.ok(account.positions[0].quantity < beforeSell);
  assert.ok(account.cashBalance > 190);
  assert.equal(account.history.filter(row => row.type === "SELL").length, 1);
});

test("swap parser ignores unrelated wallets and stablecoin legs", () => {
  const mint = "TokenMint111111111111111111111111111111111";
  assert.deepEqual(follower.swapDeltas({
    type: "SWAP",
    tokenTransfers: [
      { mint, tokenAmount: 2, fromUserAccount: "Other", toUserAccount: "Pool" },
      { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 5, fromUserAccount: follower.WALLET, toUserAccount: "Pool" }
    ]
  }), []);
});

test("403 webhook registration falls back to a working cursor feed without duplicate buys", async () => {
  const originalFetch = global.fetch;
  process.env.HELIUS_API_KEY = "test-key";
  const mint = "PollingToken111111111111111111111111111111";
  const timestamp = Math.floor(Date.now() / 1000);
  const tx = { type: "SWAP", signature: "poll-buy-1", timestamp,
    tokenTransfers: [{ mint, tokenAmount: 100, fromUserAccount: "Pool", toUserAccount: follower.WALLET }] };
  let historyCalls = 0;
  const urls = [];
  global.fetch = async (url, options = {}) => {
    urls.push(String(url));
    if (String(url).includes("/webhooks")) {
      if (options.method === "POST") return { ok: false, status: 403, text: async () => "forbidden" };
      return { ok: true, json: async () => [] };
    }
    historyCalls++;
    if (historyCalls === 3) return { ok: false, status: 429 };
    return { ok: true, json: async () => [tx] };
  };
  try {
    const before = follower.getStatus().copiedBuys;
    await follower.startBot();
    assert.equal(follower.getStatus().feedMode, "polling");
    assert.equal(follower.getStatus().feedConnected, true);
    assert.equal(follower.getStatus().error, null);
    assert.match(follower.getStatus().webhookWarning, /403/);
    assert.equal(follower.getStatus().copiedBuys, before + 1);
    await follower.pollOnce();
    assert.equal(follower.getStatus().copiedBuys, before + 1);
    assert.ok(urls.some(url => url.includes("after-signature=poll-buy-1")));
    await follower.pollOnce();
    assert.equal(follower.getStatus().feedConnected, false);
    assert.match(follower.getStatus().error, /429/);
    await follower.pollOnce();
    assert.equal(follower.getStatus().feedConnected, true);
    follower.stopBot();
    assert.equal(follower.getStatus().feedMode, "stopped");
  } finally { follower.stopBot(); global.fetch = originalFetch; delete process.env.HELIUS_API_KEY; }
});

test("skipped signals explain sells with no observed source buy and missing quotes", async () => {
  await follower.processTransaction({ type: "SWAP", signature: "unknown-sale", timestamp: 1791820800,
    tokenTransfers: [{ mint: "Unknown111", tokenAmount: 1, fromUserAccount: follower.WALLET, toUserAccount: "Pool" }] });
  assert.ok(follower.getStatus().skipReasons.sell_before_observed_buy > 0);
  follower.setMarketData(async () => null);
  await follower.processTransaction({ type: "SWAP", signature: "no-quote", timestamp: 1791820800,
    tokenTransfers: [{ mint: "NoQuote111", tokenAmount: 1, fromUserAccount: "Pool", toUserAccount: follower.WALLET }] });
  assert.ok(follower.getStatus().skipReasons.missing_price_or_liquidity > 0);
});
