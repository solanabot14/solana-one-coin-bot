const test = require("node:test");
const assert = require("node:assert/strict");
const { constants, qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = require("../profitSniperStrategy");
function candidate(overrides = {}) {
  return { tokenAddress: "Token111", pairAddress: "Pool111", chainId: "solana",
    pairCreatedAt: Date.now() - 15 * 60 * 1000, liquidityUsd: 25000, volume24h: 0,
    volume5m: 2000, buys5m: 20, sells5m: 10, priceChange5m: 2,
    momentumPattern: { ready: true }, signal: "AVOID", ...overrides };
}
test("Sniper uses 5m-24h age, activity, liquidity and rebound gates", () => {
  assert.equal(qualifiesMomentumCandidate(candidate()), true);
  const now = Date.now();
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 4 * 60 * 1000 }), now), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 5 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 29 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 5 * 60 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 24 * 60 * 60 * 1000 }), now), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: now - 24 * 60 * 60 * 1000 - 1 }), now), false);
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
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 36 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 80,
    momentumPattern: { ready: true, pullbackObserved: true,
      entryRoute: "confirmed_pullback_recovery" } })), true);
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
test("trade sizing alternates 10% and 12.5% of equity with a $20 minimum", () => {
  const expectedRates = [0.10, 0.125, 0.10, 0.125, 0.10, 0.125];
  for (const [entries, expectedRate] of expectedRates.entries()) {
    const result = getBuySizing({ cashBalance: 200, positions: [],
      history: Array.from({length: entries}, () => ({type: "BUY"})) });
    assert.equal(result.compoundRate, expectedRate);
    assert.equal(result.compoundStep, entries % 2);
    assert.equal(result.amountInvested, Math.max(20, 200 * expectedRate));
  }
  assert.deepEqual(getBuySizing({ cashBalance: 50, positions: [], history: [] }),
    { amountInvested: 20, compoundRate: 0.10, compoundStep: 0 });
  assert.equal(getBuySizing({ cashBalance: 150, positions: [{ amountInvested: 50 }],
    history: [{type: "BUY"}] }).amountInvested, 25);
  assert.equal(getBuySizing({ cashBalance: 400, positions: [], history: [] }).amountInvested, 40);
});
test("Sniper locks earlier gains with 8%/15% targets and a protected runner", () => {
  const position = { entryPrice: 100, highestPrice: 100 };
  assert.equal(constants.TAKE_PROFIT_1_PERCENT, 8);
  assert.equal(constants.TAKE_PROFIT_1_SELL_PERCENT, 50);
  assert.equal(constants.TAKE_PROFIT_2_PERCENT, 15);
  assert.equal(constants.TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT, 80);
  assert.equal(constants.TRAILING_STOP_PERCENT, 8);
  assert.equal(constants.PROFIT_FLOOR_AFTER_TP1_PERCENT, 4);
  assert.deepEqual(chooseExit({ position: { entryPrice: 100, entryLiquidityUsd: 20000 },
    currentPrice: 105, freshData: { liquidityUsd: 14999 } }), { percent: 100, reason: "EMERGENCY EXIT: POOL LIQUIDITY DOWN 25%" });
  assert.deepEqual(chooseExit({ position: { entryPrice: 1, quantity: 100 }, currentPrice: 100,
    freshData: { liquidityUsd: 15000 } }), { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" });
  assert.deepEqual(chooseExit({ position: { entryPrice: 100 }, currentPrice: 1, freshData: { liquidityUsd: 1 } }),
    { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" });
  assert.deepEqual(chooseExit({ position, currentPrice: 92, exitProgress: { soldPercent: 0 } }),
    { percent: 100, reason: "HARD STOP -8%" });
  assert.deepEqual(chooseExit({ position, currentPrice: 108, exitProgress: { soldPercent: 0 } }),
    { targetOriginalPositionPercent: 50, reason: "TAKE PROFIT 1 - SELL 50% OF ORIGINAL POSITION AT +8%", takeProfit: "firstTakeProfitDone" });
  assert.deepEqual(chooseExit({ position, currentPrice: 115, exitProgress: { soldPercent: 50 } }),
    { targetOriginalPositionPercent: 80, reason: "TAKE PROFIT 2 - SELL ANOTHER 30% OF ORIGINAL POSITION AT +15%", takeProfit: "secondTakeProfitDone" });
  assert.deepEqual(chooseExit({ position: { ...position, highestPrice: 160 }, currentPrice: 147.2, exitProgress: { soldPercent: 80 } }),
    { percent: 100, reason: "TRAILING STOP -8% FROM HIGH" });
});
test("post-TP1 floor protects a +4% whole-trade net result before the hard stop", () => {
  const position = { id: "p1", entryPrice: 100, quantity: 0.5, amountInvested: 50,
    entryLiquidityUsd: 20_000, remainingEntryCosts: { feesUsd: 0, slippageUsd: 0 }, highestPrice: 115 };
  const history = [
    { type: "BUY", positionId: "p1", amountInvested: 100, quantity: 1,
      entryExecutionCosts: { feesUsd: 0, slippageUsd: 0 } },
    { type: "SELL", positionId: "p1", amountInvested: 50, netPnl: 4, percentSold: 50 }
  ];
  const noCosts = () => ({ feesUsd: 0, slippageUsd: 0 });
  assert.equal(chooseExit({ position, currentPrice: 104, history, exitProgress: { soldPercent: 50 },
    estimateExecutionCosts: noCosts }), null);
  assert.equal(chooseExit({ position, currentPrice: 100, history, exitProgress: { soldPercent: 50 },
    estimateExecutionCosts: noCosts }).reason, "PROFIT FLOOR +4% WHOLE-TRADE NET AFTER TP1");
  const belowHardStop = chooseExit({ position, currentPrice: 92, history,
    exitProgress: { soldPercent: 50 }, estimateExecutionCosts: noCosts });
  assert.equal(belowHardStop.reason, "PROFIT FLOOR +4% WHOLE-TRADE NET AFTER TP1");
  assert.equal(belowHardStop.projectedNetPnlUsd, 0);
  const estimatedCosts = () => ({ feesUsd: 0.5, slippageUsd: 0.5 });
  assert.equal(chooseExit({ position, currentPrice: 102, history, exitProgress: { soldPercent: 50 },
    estimateExecutionCosts: estimatedCosts }).reason, "PROFIT FLOOR +4% WHOLE-TRADE NET AFTER TP1");
});
test("post-TP1 floor falls back to the +4% entry-price threshold when ledger data is incomplete", () => {
  const result = chooseExit({ position: { entryPrice: 100 }, currentPrice: 104,
    exitProgress: { soldPercent: 50 } });
  assert.equal(result.reason, "PROFIT FLOOR +4% PRICE FALLBACK AFTER TP1");
});
test("age rejection is distinguishable for watchlist tracking", () => {
  assert.ok(getMomentumFailureReasons(candidate({ tokenAddress: "EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J" })).includes("blockedTokenAddress"));
  const tooYoung = getMomentumFailureReasons(candidate({ pairCreatedAt: Date.now() - 4 * 60 * 1000 }));
  assert.deepEqual(tooYoung, ["age"]);
  assert.ok(!getMomentumFailureReasons(candidate({ priceChange5m: 36 })).includes("momentum5m"));
  assert.ok(!getMomentumFailureReasons(candidate({ priceChange5m: 80,
    momentumPattern: { ready: true, pullbackObserved: true,
      entryRoute: "confirmed_pullback_recovery" } })).includes("momentum5m"));
});

test("local recovery requires sustained rising observations and rejects continued selling", () => {
  const { createMomentumTracker } = require("../profitSniperMomentum");
  const tracker = createMomentumTracker();
  const base = { tokenAddress: "mint-rebound", pairAddress: "pool-rebound", liquidityUsd: 20_000 };
  const sample = (at, price, buys5m, sells5m, volume5m, priceChange5m = 5) =>
    tracker.observe({ ...base, priceUsd: price, buys5m, sells5m, volume5m, priceChange5m }, at);
  assert.equal(sample(0, 1, 100, 100, 10_000, 0).ready, false);
  assert.equal(sample(30_000, 1.31, 110, 100, 11_000, 31).pumpSeen, true);
  sample(60_000, 1.50, 120, 100, 12_000, 20);
  assert.equal(sample(90_000, 1.20, 125, 100, 13_000, 2).ready, false);
  // One small bounce inside a declining window is not yet confirmed recovery.
  assert.equal(sample(105_000, 1.24, 130, 101, 14_000, 3).ready, false);
  const rebound = sample(150_000, 1.26, 140, 101, 15_000, 4);
  assert.equal(rebound.ready, true);
  assert.equal(rebound.flowIsApproximation, true);
  const exhausted = sample(180_000, 0.75, 146, 102, 16_000, -5);
  assert.equal(exhausted.ready, false);
  assert.equal(exhausted.reason, "recent_price_not_confirmed_upward");
});

test("a deep old pullback can qualify after a fresh local recovery", () => {
  const { createMomentumTracker } = require("../profitSniperMomentum");
  const tracker = createMomentumTracker();
  const base = { tokenAddress: "mint-deep", pairAddress: "pool-deep", liquidityUsd: 20_000 };
  const sample = (at, price, buys5m, sells5m, volume5m) =>
    tracker.observe({ ...base, priceUsd: price, buys5m, sells5m, volume5m, priceChange5m: 5 }, at);
  sample(0, 1, 100, 60, 10_000);
  sample(30_000, 1.60, 115, 65, 11_000);
  sample(60_000, 0.85, 125, 70, 12_000);
  sample(90_000, 0.92, 140, 75, 13_000);
  const recovered = sample(120_000, 1.00, 160, 80, 15_000);
  assert.equal(recovered.ready, true);
  assert.ok(["activity_continuation","local_recovery"].includes(recovered.entryRoute));
  assert.equal(recovered.liquidityRetained, true);
  assert.equal(recovered.volumeIncreasing, true);
});

test("a small pullback needs two rising observations before the separate stability guard", () => {
  const { createMomentumTracker } = require("../profitSniperMomentum");
  const build = suffix => {
    const tracker = createMomentumTracker();
    const base = { tokenAddress: `mint-${suffix}`, pairAddress: `pool-${suffix}`, liquidityUsd: 20_000 };
    const observe = (at, price, buys5m, sells5m, volume5m, priceChange5m = 5) =>
      tracker.observe({ ...base, priceUsd: price, buys5m, sells5m, volume5m, priceChange5m }, at);
    observe(0, 1, 100, 80, 10_000, 0);
    observe(30_000, 1.50, 110, 82, 11_000, 31);
    observe(60_000, 1.47, 120, 84, 12_000, -2);
    return observe;
  };
  const observe = build("small");
  assert.equal(observe(90_000, 1.48, 135, 86, 13_000, 1).ready, false);
  const recovered = observe(120_000, 1.49, 145, 88, 14_000, 1);
  assert.equal(recovered.ready, true);
  assert.ok(["activity_continuation","local_recovery"].includes(recovered.entryRoute));
});

test("promising pools stay tracked when the rotating discovery feed drops them", () => {
  const { createRecoveryWatchlist } = require("../profitSniperRecoveryWatchlist");
  const watchlist = createRecoveryWatchlist({ maxAgeMs: 600_000, maxSize: 20,
    minimumLiquidityUsd: 8_000, minimumVolume5mUsd: 1_500, maximumRetracePercent: 45 });
  const coin = { tokenAddress: "mint-track", pairAddress: "pool-track", liquidityUsd: 20_000,
    volume5m: 75_000, momentumPattern: { pumpSeen: true, pullbackObserved: true, retracePercent: 5 } };
  assert.equal(watchlist.remember(coin, 1_000), true);
  const missing = watchlist.missing(new Set(), 31_000);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].pairAddress, "pool-track");
  watchlist.recordDirectRecheck(missing[0].key, coin, 31_000);
  assert.equal(watchlist.values()[0].directRechecks, 1);
  assert.equal(watchlist.missing(new Set(), 601_001).length, 0);
});



