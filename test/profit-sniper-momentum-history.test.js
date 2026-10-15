const test = require("node:test");
const assert = require("node:assert/strict");
const { createMomentumTracker } = require("../profitSniperMomentum");

test("historical pump telemetry does not change the live activity entry route", () => {
  const tracker = createMomentumTracker();
  const start = 1_800_000_000_000;
  const coin = { tokenAddress: "mint-A", pairAddress: "pool-A", priceUsd: 1.20,
    priceChange5m: 3, buys5m: 100, sells5m: 50, volume5m: 10_000, liquidityUsd: 20_000 };
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
  const second = tracker.observe({ ...coin, priceUsd: 1.21, buys5m: 112, sells5m: 53,
    volume5m: 11_000 }, start + 30_000);
  assert.equal(second.ready, false);
  const third = tracker.observe({ ...coin, priceUsd: 1.22, buys5m: 126, sells5m: 55,
    volume5m: 12_000 }, start + 60_000);
  assert.equal(third.ready, true);
  assert.equal(third.entryRoute, "activity_continuation");
});

test("a pool first seen before minimum age can hydrate once it becomes eligible", () => {
  const tracker = createMomentumTracker();
  const start = 1_800_000_000_000;
  const coin = { tokenAddress: "mint-B", pairAddress: "pool-B", priceUsd: 1.15,
    priceChange5m: 2, buys5m: 50, sells5m: 20 };
  tracker.observe(coin, start);
  assert.equal(tracker.hasHistorical(coin), false);
  const candles = [
    { timestamp: start / 1000 - 180, open: 1, high: 1.05, low: 0.99, close: 1.04 },
    { timestamp: start / 1000 - 120, open: 1.04, high: 1.40, low: 1.03, close: 1.35 },
    { timestamp: start / 1000 - 60, open: 1.35, high: 1.36, low: 1.08, close: 1.14 }
  ];
  assert.equal(tracker.hydrate(coin, candles, start + 60_000), true);
  assert.equal(tracker.hasHistorical(coin), true);
});

