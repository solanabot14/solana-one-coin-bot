const test = require("node:test");
const assert = require("node:assert/strict");
const { createPubxMomentumStrategy, evaluateCandidate } = require("../pubxMomentumStrategy");
const { createPubxExitPolicy } = require("../pubxExitPolicy");

function candidate(overrides = {}) {
  return {
    tokenAddress: "token-a", pairAddress: "pool-a", symbol: "FAST",
    priceUsd: 0.0002, liquidityUsd: 100000, volume5m: 9000,
    priceChange5m: 4.5, buys5m: 42, sells5m: 18,
    score: 2, signal: "WAIT", reasons: [], ...overrides
  };
}

test("qualifies active high-volume buy pressure even when baseline strategy says WAIT", () => {
  const result = evaluateCandidate(candidate());
  assert.equal(result.eligible, true);
  const [entry] = createPubxMomentumStrategy().observe([candidate()], Date.now());
  assert.equal(entry.signal, "STRONG BUY");
  assert.equal(entry.experimentEntry.model, "PUBX_FAST_MOMENTUM_V1");
  assert.equal(entry.experimentEntry.buyRatio, 0.7);
  assert.match(entry.reasons.join(" "), /unique buyer wallets are not available/);
});

test("ranks candidates by live turnover and rejects weak or fading setups", () => {
  const now = Date.now();
  const strategy = createPubxMomentumStrategy();
  strategy.observe([candidate({ tokenAddress: "growing", volume5m: 3000 })], now - 20000);
  const entries = strategy.observe([
    candidate({ tokenAddress: "low-volume", volume5m: 3000 }),
    candidate({ tokenAddress: "sell-pressure", buys5m: 20, sells5m: 25 }),
    candidate({ tokenAddress: "too-late", priceChange5m: 25 }),
    candidate({ tokenAddress: "growing", volume5m: 12000 }),
    candidate({ tokenAddress: "stronger", volume5m: 22000, buys5m: 55, sells5m: 15 })
  ], now);
  assert.deepEqual(entries.map(entry => entry.tokenAddress), ["stronger", "growing"]);
  assert.equal(entries[1].experimentEntry.volumeGrowingSinceLastScan, true);
});

test("requires at least $30k liquidity, meaningful 5m turnover, and 20 transactions", () => {
  for (const coin of [
    candidate({ liquidityUsd: 20000 }),
    candidate({ volume5m: 3999 }),
    candidate({ buys5m: 10, sells5m: 9 }),
    candidate({ priceChange5m: 0.2 })
  ]) assert.equal(evaluateCandidate(coin).eligible, false);
});

test("PubX takes half at 10%, cuts losses, and exits a stale position", () => {
  const exit = createPubxExitPolicy();
  const position = { entryTime: new Date(0).toISOString(), firstTakeProfitDone: false,
    experimentEntry: { volume5mUsd: 10000 } };
  assert.deepEqual(exit({ position, currentPrice: 1.1, profitPercent: 10,
    dropFromHigh: 0, highestProfitPercent: 10, freshData: {}, now: 1000 }),
  { percent: 50, reason: "PUBX TAKE PROFIT 1", takeProfit: "firstTakeProfitDone" });
  assert.equal(exit({ position, profitPercent: -8.1, dropFromHigh: 8,
    highestProfitPercent: 0, freshData: {}, now: 1000 }).reason, "PUBX HARD STOP");
  assert.equal(exit({ position: { ...position, entryTime: new Date(0).toISOString() },
    profitPercent: 0, dropFromHigh: 0, highestProfitPercent: 1, freshData: {}, now: 9 * 60 * 1000 }).reason,
  "PUBX TIME EXIT");
});

test("runner exits on a 5% retracement after reaching a 10% peak", () => {
  const exit = createPubxExitPolicy();
  const result = exit({ position: { firstTakeProfitDone: true, entryTime: new Date(0).toISOString() },
    profitPercent: 8, dropFromHigh: 5.1, highestProfitPercent: 13,
    freshData: {}, now: 1000 });
  assert.deepEqual(result, { percent: 100, reason: "PUBX RUNNER TRAIL EXIT" });
});
