const test = require("node:test");
const assert = require("node:assert/strict");
const { createLpLockChecker, MIN_LOCKED_PERCENT } = require("../lpLockChecker85");

test("85% threshold accepts a confirmed lock at 85%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 85 } }) });
  assert.equal(MIN_LOCKED_PERCENT, 85);
  assert.deepEqual(await checker.getLockStatus("at-85"), { allowed: true, lockedPercent: 85, reason: "LOCKED_LIQUIDITY_CONFIRMED" });
});

test("85% threshold rejects a confirmed lock below 85%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 84.99 } }) });
  assert.deepEqual(await checker.getLockStatus("below-85"), { allowed: false, lockedPercent: 84.99, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" });
});

test("unverified lock data is still rejected", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: {} }) });
  assert.deepEqual(await checker.getLockStatus("unknown"), { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" });
});
