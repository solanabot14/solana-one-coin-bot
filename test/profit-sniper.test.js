const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = require("../profitSniperStrategy");

function candidate(overrides = {}) {
  return {
    tokenAddress: "Token111",
    pairAddress: "Pool111",
    chainId: "solana",
    pairCreatedAt: Date.now() - 5 * 60 * 1000,
    liquidityUsd: 25000,
    volume24h: 30000,
    volume5m: 2000,
    buys5m: 8,
    sells5m: 4,
    priceChange5m: 2,
    signal: "BUY",
    ...overrides
  };
}

test("fresh, active, upward momentum candidates pass; stale, weak, or overheated candidates fail", () => {
  assert.equal(qualifiesMomentumCandidate(candidate()), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 0.1 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: -0.01 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 0 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 4000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 250000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 60 * 1000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 31 * 60 * 1000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: -1 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 21 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 5, sells5m: 7 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ signal: "AVOID" })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ signal: "WAIT" })), true);
});

test("same ticker is distinguished by mint and duplicate pools collapse to the best exact mint", () => {
  const { selectUniqueMintCandidates } = require("../profitSniperStrategy");
  const sameTicker = [
    candidate({ symbol: "MOON", tokenAddress: "mint-A", pairAddress: "pool-A", score: 2 }),
    candidate({ symbol: "MOON", tokenAddress: "mint-B", pairAddress: "pool-B", score: 3 }),
    candidate({ symbol: "MOON", tokenAddress: "mint-A", pairAddress: "pool-A2", score: 4 })
  ];
  const selected = selectUniqueMintCandidates(sameTicker);
  assert.equal(selected.length, 2);
  assert.equal(selected.find(x => x.tokenAddress === "mint-A").pairAddress, "pool-A2");
  assert.equal(selected.find(x => x.tokenAddress === "mint-B").pairAddress, "pool-B");
});

test("trade sizing stays fixed at $10 regardless of equity or past entries", () => {
  for (const cashBalance of [10, 100, 200, 6000]) {
    for (const entries of [0, 1, 2, 3, 20]) {
      assert.deepEqual(getBuySizing({ cashBalance, positions: [], history: Array.from({length: entries}, () => ({type: "BUY"})) }), { amountInvested: 10 });
    }
  }
});

test("low liquidity forces a full paper exit while unavailable liquidity data is ignored", () => {
  const position = { entryPrice: 100 };
  assert.deepEqual(chooseExit({ position, currentPrice: 1, freshData: { liquidityUsd: 1 } }), { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" });
  assert.deepEqual(chooseExit({ position, currentPrice: 100, freshData: { liquidityUsd: 1000 } }), { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" });
  assert.equal(chooseExit({ position, currentPrice: 100, freshData: {} }), null);
});

test("a pool losing a quarter of its entry liquidity triggers an early exit", () => {
  assert.deepEqual(chooseExit({ position: { entryPrice: 100, entryLiquidityUsd: 20000 },
    currentPrice: 105, freshData: { liquidityUsd: 14999 } }),
    { percent: 100, reason: "EMERGENCY EXIT: POOL LIQUIDITY DOWN 25%" });
});

test("original exits sell half at +10%, exit the remainder at +20%, protect at +2%, and stop at -8%", () => {
  const position = { entryPrice: 100, firstTakeProfitDone: false };
  assert.deepEqual(chooseExit({ position, currentPrice: 92 }), { percent: 100, reason: "HARD STOP -8%" });
  assert.equal(chooseExit({ position, currentPrice: 109 }), null);
  assert.deepEqual(chooseExit({ position, currentPrice: 110 }), {
    percent: 50,
    reason: "TAKE PROFIT 1 - SELL 50% OF ORIGINAL POSITION",
    takeProfit: "firstTakeProfitDone"
  });

  const afterFirstSale = { ...position, firstTakeProfitDone: true };
  assert.deepEqual(chooseExit({ position: afterFirstSale, currentPrice: 102 }), {
    percent: 100, reason: "PROFIT FLOOR AFTER TP1 +2%"
  });
  assert.deepEqual(chooseExit({ position: afterFirstSale, currentPrice: 50 }), {
    percent: 100, reason: "HARD STOP AFTER TP1 -8% (PRICE GAP)"
  });
  assert.equal(chooseExit({ position: afterFirstSale, currentPrice: 119 }), null);
  assert.deepEqual(chooseExit({ position: afterFirstSale, currentPrice: 120 }), {
    percent: 100, reason: "TAKE PROFIT 2 - EXIT REMAINDER AT +20%"
  });

  const legacyRunner = { ...afterFirstSale, secondTakeProfitDone: true, highestPrice: 150 };
  assert.deepEqual(chooseExit({ position: legacyRunner, currentPrice: 110 }), {
    percent: 100, reason: "ORIGINAL TAKE PROFIT 2 - EXIT REMAINDER"
  });
});
test("momentum diagnostics name the failed Sniper gate", () => {
  assert.deepEqual(getMomentumFailureReasons(candidate({ priceChange5m: 0 })), ["momentum5m"]);
  assert.deepEqual(getMomentumFailureReasons(candidate({ tokenAddress: "EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J" })), ["blockedTokenAddress"]);
  assert.ok(getMomentumFailureReasons(candidate({ liquidityUsd: 22620.82, volume24h: 355693.51 })).includes("volumeToLiquidity"));
  assert.ok(getMomentumFailureReasons(candidate({ liquidityUsd: 17378.89, volume24h: 1603 })).includes("volume24h"));
  assert.ok(getMomentumFailureReasons(candidate({ priceChange1h: 902 })).includes("momentum1h"));
});

test("an inflated quote cannot credit more than the pool could support", () => {
  assert.deepEqual(chooseExit({ position: { entryPrice: 1, quantity: 100 }, currentPrice: 100,
    freshData: { liquidityUsd: 15000 } }),
    { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" });
});

