const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifiesMomentumCandidate, getBuySizing, chooseExit } = require("../profitSniperStrategy");

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
  assert.equal(qualifiesMomentumCandidate(candidate({ pairCreatedAt: Date.now() - 31 * 60 * 1000 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: -1 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ priceChange5m: 21 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ buys5m: 5, sells5m: 7 })), false);
  assert.equal(qualifiesMomentumCandidate(candidate({ signal: "WATCH" })), false);
});

test("trade sizing follows the 10%, 12.5%, 15% cycle and resets after the third entry", () => {
  const makeState = entries => ({ cashBalance: 100, positions: [], history: Array.from({ length: entries }, () => ({ type: "BUY" })) });
  assert.deepEqual(getBuySizing(makeState(0)), { amountInvested: 10, compoundRate: 0.1 });
  assert.deepEqual(getBuySizing(makeState(1)), { amountInvested: 12.5, compoundRate: 0.125 });
  assert.deepEqual(getBuySizing(makeState(2)), { amountInvested: 15, compoundRate: 0.15 });
  assert.deepEqual(getBuySizing(makeState(3)), { amountInvested: 10, compoundRate: 0.1 });
});

test("exit logic sells half at +10%, protects the rest at +2%, exits at +20%, and stops at -8%", () => {
  const position = { entryPrice: 100, firstTakeProfitDone: false };
  assert.deepEqual(chooseExit({ position, currentPrice: 92 }), { percent: 100, reason: "HARD STOP -8%" });
  assert.deepEqual(chooseExit({ position, currentPrice: 110 }), { percent: 50, reason: "TAKE PROFIT 1", takeProfit: "firstTakeProfitDone" });
  assert.deepEqual(chooseExit({ position: { ...position, firstTakeProfitDone: true }, currentPrice: 102 }), { percent: 100, reason: "PROFIT FLOOR AFTER TP1 +2%" });
  assert.deepEqual(chooseExit({ position: { ...position, firstTakeProfitDone: true }, currentPrice: 120 }), { percent: 100, reason: "TAKE PROFIT 2" });
  assert.equal(chooseExit({ position, currentPrice: 105 }), null);
});
