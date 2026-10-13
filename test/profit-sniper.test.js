const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = require("../profitSniperStrategy");

function candidate(overrides = {}) {
  return {
    tokenAddress: "Token111",
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
  assert.equal(qualifiesMomentumCandidate(candidate({ volume24h: 0 })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 31 * 60 * 1000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: -1 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 21 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 5, sells5m: 7 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ signal: "AVOID" })), true);
  assert.equal(qualifiesMomentumCandidate(candidate({ signal: "WAIT" })), true);
});

test("trade sizing follows the 10%, 12.5%, 15% cycle and resets after the third entry", () => {
  const makeState = entries => ({ cashBalance: 100, positions: [], history: Array.from({ length: entries }, () => ({ type: "BUY" })) });
  assert.deepEqual(getBuySizing(makeState(0)), { amountInvested: 10, compoundRate: 0.1 });
  assert.deepEqual(getBuySizing(makeState(1)), { amountInvested: 12.5, compoundRate: 0.125 });
  assert.deepEqual(getBuySizing(makeState(2)), { amountInvested: 15, compoundRate: 0.15 });
  assert.deepEqual(getBuySizing(makeState(3)), { amountInvested: 10, compoundRate: 0.1 });
});

test("low liquidity forces a full paper exit while unavailable liquidity data is ignored", () => {
  const position = { entryPrice: 100 };
  assert.deepEqual(chooseExit({ position, currentPrice: 1, freshData: { liquidityUsd: 1 } }), { percent: 100, reason: "EMERGENCY EXIT: LIQUIDITY COLLAPSE" });
  assert.deepEqual(chooseExit({ position, currentPrice: 100, freshData: { liquidityUsd: 1000 } }), { percent: 100, reason: "EMERGENCY EXIT: LIQUIDITY COLLAPSE" });
  assert.equal(chooseExit({ position, currentPrice: 100, freshData: {} }), null);
});

test("exit ladder sells 45% at +10%, 45% of original at +20%, then trails the final 10% by 10%", () => {
  const position = { entryPrice: 100, firstTakeProfitDone: false };
  assert.deepEqual(chooseExit({ position, currentPrice: 92 }), { percent: 100, reason: "HARD STOP -8%" });
  assert.equal(chooseExit({ position, currentPrice: 109 }), null);
  assert.deepEqual(chooseExit({ position, currentPrice: 110 }), {
    percent: 45,
    reason: "TAKE PROFIT 1 - SELL 45% OF ORIGINAL POSITION",
    takeProfit: "firstTakeProfitDone"
  });

  const afterFirstSale = { ...position, firstTakeProfitDone: true };
  assert.deepEqual(chooseExit({ position: afterFirstSale, currentPrice: 100 }), {
    percent: 100, reason: "BREAKEVEN STOP AFTER TP1"
  });
  assert.equal(chooseExit({ position: afterFirstSale, currentPrice: 119 }), null);
  assert.deepEqual(chooseExit({ position: afterFirstSale, currentPrice: 120 }), {
    percent: 45 / 55 * 100,
    reason: "TAKE PROFIT 2 - SELL 45% OF ORIGINAL POSITION",
    takeProfit: "secondTakeProfitDone"
  });

  const runner = { ...afterFirstSale, secondTakeProfitDone: true, highestPrice: 150 };
  assert.equal(chooseExit({ position: runner, currentPrice: 136.5 }), null);
  assert.deepEqual(chooseExit({ position: runner, currentPrice: 135 }), {
    percent: 100, reason: "TRAILING STOP -10% FROM HIGH"
  });
});

test("momentum diagnostics name the failed Sniper gate", () => {
  assert.deepEqual(getMomentumFailureReasons(candidate({ priceChange5m: 0 })), ["momentum5m"]);
});
