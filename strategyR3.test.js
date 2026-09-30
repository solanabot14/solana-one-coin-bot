const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeEarlyRunner } = require("./strategyR3");

function obs(liquidityUsd, volume24h, volume5m, priceChange5m, priceChange1h, buys5m, sells5m) {
  return { liquidityUsd, volume24h, volume5m, priceChange5m, priceChange1h, buys5m, sells5m };
}

test("ARTHUR-like accelerating structure qualifies as EARLY RUNNER", () => {
  const history = [
    obs(37000, 110000, 6000, 0.5, 4, 20, 12),
    obs(43000, 160000, 8000, 0.8, 6, 28, 15),
    obs(49500, 220000, 10000, 1.2, 8, 35, 18),
    obs(65000, 303000, 14000, 2.0, 12, 44, 23)
  ];
  const current = obs(65000, 303000, 14000, 2.0, 12, 44, 23);
  const result = analyzeEarlyRunner(history, current);
  assert.equal(result.signal, "EARLY RUNNER");
  assert.ok(result.metrics.liquidityGrowthPct >= 5);
  assert.ok(result.metrics.volume24hGrowthPct >= 8);
});

test("STOCK-like high absolute volume without acceleration stays WATCH", () => {
  const history = [
    obs(59000, 1430000, 3200, 1.1, 8, 25, 18),
    obs(59200, 1432000, 3000, 1.0, 8, 24, 19),
    obs(59100, 1434000, 2900, 0.9, 8, 23, 20),
    obs(59200, 1437000, 3000, 1.0, 8, 24, 20)
  ];
  const current = obs(59200, 1437000, 3000, 1.0, 8, 24, 20);
  const result = analyzeEarlyRunner(history, current);
  assert.equal(result.signal, "WATCH");
});

test("liquidity drain vetoes an apparent runner", () => {
  const history = [
    obs(70000, 200000, 8000, 1.0, 10, 35, 20),
    obs(76000, 230000, 9000, 1.5, 12, 40, 22),
    obs(80000, 260000, 10000, 2.0, 14, 42, 24),
    obs(65000, 300000, 12000, 2.0, 14, 42, 24)
  ];
  const current = obs(65000, 300000, 12000, 2.0, 14, 42, 24);
  const result = analyzeEarlyRunner(history, current);
  assert.equal(result.signal, "AVOID");
});
