const test = require("node:test");
const assert = require("node:assert/strict");
const { constants, qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = require("../profitSniperStrategy");
function candidate(overrides = {}) {
  return { tokenAddress: "Token111", pairAddress: "Pool111", chainId: "solana",
    pairCreatedAt: Date.now() - 15 * 60 * 1000, liquidityUsd: 25000, volume24h: 0,
    volume5m: 2000, buys5m: 20, sells5m: 10, priceChange5m: 2,
    momentumPattern: { ready: true }, signal: "AVOID", ...overrides };
}
test("Sniper uses 5m-6h age, activity, liquidity and rebound gates", () => {
  assert.equal(qualifiesMomentumCandidate(candidate()), true);
  const now = Date.now();
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 4 * 60 * 1000 }), now), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 5 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 29 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 5 * 60 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 6 * 60 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 6 * 60 * 60 * 1000 - 1 }), now), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 0 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: undefined })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume5m: 1499 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume5m: 1500 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ liquidityUsd: 7999 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ liquidityUsd: 8000 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 16, sells5m: 13 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 17, sells5m: 13 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 29, sells5m: 0 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 30, sells5m: 0 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 36 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ momentumPattern: { ready: false } })), false);
  assert.equal(constants.MIN_LIQUIDITY_USD, 8000);
  assert.equal(constants.MIN_VOLUME_5M_USD, 1500);
  assert.equal(constants.MIN_TRANSACTIONS_5M, 30);
});
test("same ticker is distinguished by mint and duplicate pools collapse to the best exact mint", () => {
  const { selectUniqueMintCandidates } = require("../profitSniperStrategy");
  const selected = selectUniqueMintCandidates([
    candidate({ symbol: "MOON", tokenAddress: "mint-A", pairAddress: "pool-A", score: 2 }),
    candidate({ symbol: "MOON", tokenAddress: "mint-B", pairAddress: "pool-B", score: 3 }),
    candidate({ symbol: "MOON", tokenAddress: "mint-A", pairAddress: "pool-A2", score: 4 })
  ]);
  assert.equal(selected.length, 2);
  assert.equal(selected.find(x => x.tokenAddress === "mint-A").pairAddress, "pool-A2");
  assert.equal(selected.find(x => x.tokenAddress === "mint-B").pairAddress, "pool-B");
});
test("trade sizing compounds 10%, 12.5%, then 15%, repeating with a $10 minimum", () => {
  const expectedRates = [0.10, 0.125, 0.15, 0.10, 0.125];
  for (const [entries, expectedRate] of expectedRates.entries()) {
    const result = getBuySizing({ cashBalance: 200, positions: [],
      history: Array.from({length: entries}, () => ({type: "BUY"})) });
    assert.equal(result.compoundRate, expectedRate);
    assert.equal(result.amountInvested, Math.max(10, 200 * expectedRate));
  }
  assert.deepEqual(getBuySizing({ cashBalance: 50, positions: [], history: [] }), { amountInvested: 10, compoundRate: 0.10 });
});
test("exit rules remain unchanged", () => {
  const position = { entryPrice: 100, highestPrice: 100 };
  assert.deepEqual(chooseExit({ position: { entryPrice: 100, entryLiquidityUsd: 20000 },
    currentPrice: 105, freshData: { liquidityUsd: 14999 } }), { percent: 100, reason: "EMERGENCY EXIT: POOL LIQUIDITY DOWN 25%" });
  assert.deepEqual(chooseExit({ position: { entryPrice: 1, quantity: 100 }, currentPrice: 100,
    freshData: { liquidityUsd: 15000 } }), { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" });
  assert.equal(chooseExit({ position: { ...position, highestPrice: 160 }, currentPrice: 141, exitProgress: { soldPercent: 80 } }), null);
  assert.deepEqual(chooseExit({ position: { entryPrice: 100 }, currentPrice: 1, freshData: { liquidityUsd: 1 } }),
    { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" });
  assert.deepEqual(chooseExit({ position, currentPrice: 92, exitProgress: { soldPercent: 0 } }), { percent: 100, reason: "HARD STOP -8%" });
  assert.equal(chooseExit({ position, currentPrice: 114, exitProgress: { soldPercent: 0 } }), null);
  assert.deepEqual(chooseExit({ position, currentPrice: 115, exitProgress: { soldPercent: 0 } }),
    { targetOriginalPositionPercent: 40, reason: "TAKE PROFIT 1 - SELL 40% OF ORIGINAL POSITION AT +15%", takeProfit: "firstTakeProfitDone" });
  assert.deepEqual(chooseExit({ position, currentPrice: 125, exitProgress: { soldPercent: 40 } }),
    { targetOriginalPositionPercent: 80, reason: "TAKE PROFIT 2 - SELL ANOTHER 40% OF ORIGINAL POSITION AT +25%", takeProfit: "secondTakeProfitDone" });
  assert.deepEqual(chooseExit({ position: { ...position, highestPrice: 160 }, currentPrice: 140.7, exitProgress: { soldPercent: 80 } }),
    { percent: 100, reason: "TRAILING STOP -12% FROM HIGH" });
});
test("age rejection is distinguishable for watchlist tracking", () => {
  assert.ok(getMomentumFailureReasons(candidate({ tokenAddress: "EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J" })).includes("blockedTokenAddress"));
  const tooYoung = getMomentumFailureReasons(candidate({ pairCreatedAt: Date.now() - 4 * 60 * 1000 }));
  assert.deepEqual(tooYoung, ["age"]);
  assert.ok(getMomentumFailureReasons(candidate({ priceChange5m: 36 })).includes("momentum5m"));
});

test("cached scans require a 30% pump, 15-30% retrace and 5% rebound with buy flow", () => {
  const { createMomentumTracker } = require("../profitSniperMomentum");
  const tracker = createMomentumTracker();
  const base = { tokenAddress: "mint-rebound", pairAddress: "pool-rebound" };
  const sample = (at, price, buys5m, sells5m, priceChange5m = 5) =>
    tracker.observe({ ...base, priceUsd: price, buys5m, sells5m, priceChange5m }, at);
  assert.equal(sample(0, 1, 100, 100, 0).ready, false);
  assert.equal(sample(30_000, 1.31, 110, 100, 31).pumpSeen, true);
  sample(60_000, 1.50, 120, 100, 20);
  assert.equal(sample(90_000, 1.20, 125, 100, 2).ready, false);
  assert.equal(sample(105_000, 1.24, 130, 101, 3).ready, false);
  const rebound = sample(120_000, 1.26, 140, 101, 4);
  assert.equal(rebound.ready, true);
  assert.equal(rebound.flowIsApproximation, true);
  const exhausted = sample(150_000, 0.95, 136, 102, -5);
  assert.equal(exhausted.reason, "retrace_over_35_percent");
});


