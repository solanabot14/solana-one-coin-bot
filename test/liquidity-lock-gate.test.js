const test = require("node:test");
const assert = require("node:assert/strict");
const { liquidityLockAllowsEntry } = require("../liquidityLockGate");

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
