const test = require("node:test");
const assert = require("node:assert/strict");
const { createMomentumTracker } = require("../profitSniperMomentum");

test("historical candles supply the earlier pump while live scans confirm rebound and buy flow", () => {
  const tracker = createMomentumTracker();
  const start = 1_800_000_000_000;
  const coin = { tokenAddress: "mint-A", pairAddress: "pool-A", priceUsd: 1.20,
    priceChange5m: 3, buys5m: 100, sells5m: 50 };
  const candles = [
    { timestamp: start / 1000 - 240, open: 1, high: 1.05, low: 0.98, close: 1.04 },
    { timestamp: start / 1000 - 180, open: 1.04, high: 1.50, low: 1.03, close: 1.45 },
    { timestamp: start / 1000 - 120, open: 1.45, high: 1.46, low: 1.10, close: 1.15 }
  ];
  assert.equal(tracker.hydrate(coin, candles, start), true);
  const first = tracker.observe(coin, start);
  assert.equal(first.pumpSeen, true);
  assert.equal(first.historicalHydrated, true);
  assert.equal(first.ready, false);
  const second = tracker.observe({ ...coin, priceUsd: 1.21, buys5m: 112, sells5m: 53 }, start + 30_000);
  assert.equal(second.ready, true);
  assert.ok(second.retracePercent >= 15 && second.retracePercent <= 30);
  assert.ok(second.reboundFromLowPercent >= 5);
});
