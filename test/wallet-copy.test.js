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
