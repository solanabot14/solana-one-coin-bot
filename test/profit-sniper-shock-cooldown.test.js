const test = require("node:test");
const assert = require("node:assert/strict");
const { createShockCooldown } = require("../profitSniperShockCooldown");

const coin = (overrides = {}) => ({
  tokenAddress: "mint-1", pairAddress: "pool-1", priceUsd: 100, liquidityUsd: 25_000, ...overrides
});

test("a sharp price drop blocks the exact pool for five minutes", () => {
  const gate = createShockCooldown();
  const start = 1_800_000_000_000;
  assert.equal(gate.observe(coin(), start).active, false);
  const shock = gate.observe(coin({ priceUsd: 87 }), start + 30_000);
  assert.equal(shock.active, true);
  assert.equal(shock.reason, "rapid_price_drop");
  assert.equal(shock.remainingMs, 300_000);
  assert.equal(gate.observe(coin({ priceUsd: 87 }), start + 4 * 60_000).active, true);
  assert.equal(gate.observe(coin({ priceUsd: 87 }), start + 5 * 60_000 + 30_000).active, false);
});

test("a sharp liquidity drop triggers the same cooldown without changing thresholds", () => {
  const gate = createShockCooldown();
  const start = 1_800_000_000_000;
  gate.observe(coin(), start);
  const shock = gate.observe(coin({ liquidityUsd: 19_000 }), start + 30_000);
  assert.equal(shock.active, true);
  assert.equal(shock.reason, "rapid_liquidity_drop");
  assert.equal(shock.liquidityDropPercent, 24);
});

test("stale observations and a different pool do not inherit a cooldown", () => {
  const gate = createShockCooldown();
  const start = 1_800_000_000_000;
  gate.observe(coin(), start);
  assert.equal(gate.observe(coin({ priceUsd: 80 }), start + 80_000).active, false);
  assert.equal(gate.observe(coin({ pairAddress: "pool-2", priceUsd: 70 }), start + 90_000).active, false);
});
