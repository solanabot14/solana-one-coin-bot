const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeEarlyRunner } = require("./strategyR3");

function obs(liquidityUsd, volume24h, volume5m, priceChange5m, priceChange1h, buys5m, sells5m, volume1h = 0) {
  return { liquidityUsd, volume24h, volume5m, volume1h, priceChange5m, priceChange1h, buys5m, sells5m };
}

test("ARTHUR-like short-term acceleration qualifies even without large 24h volume growth", () => {
  const history = [
    obs(42000, 150000, 4200, 0.5, 4, 20, 12, 30000),
    obs(47000, 151000, 6500, 0.8, 6, 28, 15, 32500),
    obs(52000, 152000, 9000, 1.2, 8, 35, 18, 35000),
    obs(62000, 153000, 14000, 2.0, 12, 44, 23, 39000)
  ];
  const current = history.at(-1);
  const result = analyzeEarlyRunner(history, current);
  assert.equal(result.signal, "EARLY RUNNER");
  assert.ok(result.metrics.liquidityGrowthPct >= 5);
  assert.ok(result.metrics.volume5mGrowthPct >= 25);
  assert.ok(result.metrics.volume24hGrowthPct < 8);
});

test("STOCK-like high 24h volume without live 5m acceleration stays WATCH", () => {
  const history = [
    obs(59000, 1430000, 3200, 1.1, 8, 25, 18, 45000),
    obs(59200, 1432000, 3000, 1.0, 8, 24, 19, 45200),
    obs(59100, 1434000, 2900, 0.9, 8, 23, 20, 45100),
    obs(59200, 1437000, 3000, 1.0, 8, 24, 20, 45300)
  ];
  const result = analyzeEarlyRunner(history, history.at(-1));
  assert.equal(result.signal, "WATCH");
});

test("hot NUTFLEX-like expansion becomes EXTENDED-WATCH instead of being discarded", () => {
  const history = [
    obs(44000, 500000, 18000, 2.0, 20, 38, 22, 100000),
    obs(48000, 502000, 26000, 3.0, 25, 48, 25, 108000),
    obs(55000, 504000, 40000, 4.8, 30, 62, 32, 116000),
    obs(66000, 506000, 62000, 6.0, 35, 80, 40, 125000)
  ];
  const result = analyzeEarlyRunner(history, history.at(-1));
  assert.equal(result.signal, "EXTENDED-WATCH");
});

test("liquidity drain vetoes an apparent runner", () => {
  const history = [
    obs(70000, 200000, 8000, 1.0, 10, 35, 20, 50000),
    obs(76000, 201000, 11000, 1.5, 12, 40, 22, 54000),
    obs(80000, 202000, 15000, 2.0, 14, 42, 24, 58000),
    obs(65000, 203000, 18000, 2.0, 14, 42, 24, 62000)
  ];
  const result = analyzeEarlyRunner(history, history.at(-1));
  assert.equal(result.signal, "AVOID");
});
