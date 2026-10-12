"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const follower = require("../walletCopy");

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
