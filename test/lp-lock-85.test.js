const test = require("node:test");
const assert = require("node:assert/strict");
const { createLpLockChecker, MIN_LOCKED_PERCENT } = require("../lpLockChecker85");

test("60% threshold accepts a confirmed lock at 60%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 60 } }) });
  assert.equal(MIN_LOCKED_PERCENT, 60);
  assert.deepEqual(await checker.getLockStatus("at-60"), { allowed: true, lockedPercent: 60, reason: "LOCKED_LIQUIDITY_CONFIRMED" });
});

test("60% threshold rejects a confirmed lock below 70%", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: { lpLockedPct: 59.99 } }) });
  assert.deepEqual(await checker.getLockStatus("below-60"), { allowed: false, lockedPercent: 59.99, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" });
});

test("unverified lock data is still rejected", async () => {
  const checker = createLpLockChecker({ httpGet: async () => ({ data: {} }) });
  assert.deepEqual(await checker.getLockStatus("unknown"), { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" });
});
