const test = require("node:test");
const assert = require("node:assert/strict");
const { constants, qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = require("../profitSniperStrategy");
function candidate(overrides = {}) {
  return { tokenAddress: "Token111", pairAddress: "Pool111", chainId: "solana",
    pairCreatedAt: Date.now() - 5 * 60 * 1000, liquidityUsd: 4500, volume24h: 600,
    volume5m: 700, buys5m: 5, sells5m: 3, priceChange5m: 2, signal: "AVOID", ...overrides };
}
test("0-6h trending pools use current activity and rebound momentum gates, not the shared signal label", () => {
  assert.equal(qualifiesMomentumCandidate(candidate()), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 29 * 60 * 1000 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 5 * 60 * 60 * 1000 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 7 * 60 * 60 * 1000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 0.05 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 0.04 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: -0.01 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 0 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 400 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 250000 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 13 })), true);\n  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 36 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 4, sells5m: 4 })), true);
  assert.equal(constants.MIN_LIQUIDITY_USD, 3000);
  assert.equal(qualifiesMomentumCandidate(candidate({ liquidityUsd: 3000 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ liquidityUsd: 2999 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ volume5m: 299 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 1, sells5m: 6 })), false);
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
test("emergency liquidity checks remain active", () => {
  assert.deepEqual(chooseExit({ position: { entryPrice: 100 }, currentPrice: 1, freshData: { liquidityUsd: 1 } }),
    { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" });
  assert.deepEqual(chooseExit({ position: { entryPrice: 100, entryLiquidityUsd: 20000 },
    currentPrice: 105, freshData: { liquidityUsd: 14999 } }), { percent: 100, reason: "EMERGENCY EXIT: POOL LIQUIDITY DOWN 25%" });
  assert.deepEqual(chooseExit({ position: { entryPrice: 1, quantity: 100 }, currentPrice: 100,
    freshData: { liquidityUsd: 15000 } }), { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" });
});
test("exits 40% at +15%, another 40% at +25%, then trails final 20% by 12%", () => {
  const position = { entryPrice: 100, highestPrice: 100 };
  assert.deepEqual(chooseExit({ position, currentPrice: 92, exitProgress: { soldPercent: 0 } }), { percent: 100, reason: "HARD STOP -8%" });
  assert.equal(chooseExit({ position, currentPrice: 114, exitProgress: { soldPercent: 0 } }), null);
  assert.deepEqual(chooseExit({ position, currentPrice: 115, exitProgress: { soldPercent: 0 } }),
    { targetOriginalPositionPercent: 40, reason: "TAKE PROFIT 1 - SELL 40% OF ORIGINAL POSITION AT +15%", takeProfit: "firstTakeProfitDone" });
  assert.deepEqual(chooseExit({ position, currentPrice: 125, exitProgress: { soldPercent: 40 } }),
    { targetOriginalPositionPercent: 80, reason: "TAKE PROFIT 2 - SELL ANOTHER 40% OF ORIGINAL POSITION AT +25%", takeProfit: "secondTakeProfitDone" });
  assert.equal(chooseExit({ position: { ...position, highestPrice: 160 }, currentPrice: 141, exitProgress: { soldPercent: 80 } }), null);
  assert.deepEqual(chooseExit({ position: { ...position, highestPrice: 160 }, currentPrice: 140.7, exitProgress: { soldPercent: 80 } }),
    { percent: 100, reason: "TRAILING STOP -12% FROM HIGH" });
});
test("momentum diagnostics identify hard entry gates", () => {
  assert.deepEqual(getMomentumFailureReasons(candidate({ priceChange5m: 0 })), ["momentum5m"]);
  assert.ok(getMomentumFailureReasons(candidate({ tokenAddress: "EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J" })).includes("blockedTokenAddress"));
  assert.ok(getMomentumFailureReasons(candidate({ liquidityUsd: 3000, volume24h: 400000 })).includes("volumeToLiquidity"));
  assert.ok(getMomentumFailureReasons(candidate({ liquidityUsd: 17378.89, volume24h: 1603 })).includes("volume24h"));
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange1h: 902, priceChange24h: 900 })), true);\n  assert.ok(getMomentumFailureReasons(candidate({ priceChange1h: 1001 })).includes("momentum1h"));
});
