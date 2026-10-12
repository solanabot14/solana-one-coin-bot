const test = require("node:test");
const assert = require("node:assert/strict");
const { liquidityLockAllowsEntry } = require("../liquidityLockGate");
const { createLpLockChecker, MIN_LOCKED_PERCENT } = require("../lpLockChecker");

test("unknown RugCheck status is allowed only when explicitly enabled", () => {
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" }, 70), false);
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" }, 70, true), true);
});

test("confirmed liquidity below the threshold is always rejected", () => {
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: 69.9, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" }, 70, true), false);
});

test("confirmed liquidity at or above the threshold is accepted", () => {
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: "70", reason: "LOCKED_LIQUIDITY_CONFIRMED" }, 70), true);
});

test("other missing lock results are not treated as unavailable", () => {
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: null, reason: "MISSING_TOKEN_ADDRESS" }, 70, true), false);
});

test("malformed lock percentages are rejected even when RugCheck is unavailable", () => {
  assert.equal(liquidityLockAllowsEntry({ lockedPercent: "unknown", reason: "LOCK_STATUS_UNAVAILABLE" }, 70, true), false);
});


test("Profit Sniper threshold accepts confirmed 50% lock and fails closed when lock data is unavailable", async () => {
  assert.equal(MIN_LOCKED_PERCENT, 85, "shared bots keep their existing default");
  const atThreshold = createLpLockChecker({
    minimumLockedPercent: 50,
    httpGet: async () => ({ data: { lpLockedPct: 50 } })
  });
  const belowThreshold = createLpLockChecker({
    minimumLockedPercent: 50,
    httpGet: async () => ({ data: { lpLockedPct: 49.99 } })
  });
  const unavailable = createLpLockChecker({
    minimumLockedPercent: 50,
    httpGet: async () => ({ data: {} })
  });
  assert.equal((await atThreshold.getLockStatus("threshold-50")).allowed, true);
  assert.equal((await belowThreshold.getLockStatus("below-50")).allowed, false);
  assert.equal((await unavailable.getLockStatus("unavailable")).allowed, false);
  assert.equal(liquidityLockAllowsEntry(await unavailable.getLockStatus("unavailable"), 50, false), false);
});
