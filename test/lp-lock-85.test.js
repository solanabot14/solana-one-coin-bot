const test = require("node:test");
const assert = require("node:assert/strict");
const { createLpLockChecker, MIN_LOCKED_PERCENT } = require("../lpLockChecker85");

test("70% threshold accepts a confirmed lock at 70%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 80 } }) });
  assert.equal(MIN_LOCKED_PERCENT, 70);
  assert.deepEqual(await checker.getLockStatus("at-70"), { allowed: true, lockedPercent: 70, reason: "LOCKED_LIQUIDITY_CONFIRMED" });
});

test("70% threshold rejects a confirmed lock below 70%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 79.99 } }) });
  assert.deepEqual(await checker.getLockStatus("below-70"), { allowed: false, lockedPercent: 69.99, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" });
});

test("unverified lock data is still rejected", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: {} }) });
  assert.deepEqual(await checker.getLockStatus("unknown"), { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" });
});
