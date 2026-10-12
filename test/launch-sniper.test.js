const test = require("node:test");
const assert = require("node:assert/strict");
const { qualifiesLaunchCandidate, thresholds } = require("../launchSniper");

const now = 1_800_000_000_000;
function candidate(overrides = {}) {
  return {
    pairCreatedAt: now - 5 * 60 * 1000,
    liquidityUsd: 25000,
    volume24h: 30000,
    volume5m: 2000,
    buys5m: 8,
    sells5m: 4,
    ...overrides
  };
}

test("accepts a fresh, liquid pair with active buy flow", () => {
  assert.equal(qualifiesLaunchCandidate(candidate(), now), true);
  assert.equal(qualifiesLaunchCandidate(candidate({ liquidityUsd: 15000 }), now, 15000), true);
  assert.equal(qualifiesLaunchCandidate(candidate({ liquidityUsd: 15000 }), now), false);
});

test("rejects missing or stale pair age", () => {
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: undefined }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: now - 31 * 60 * 1000 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: now + 1000 }), now), false);
});

test("rejects weak liquidity, volume, activity, or buy ratio", () => {
  assert.equal(qualifiesLaunchCandidate(candidate({ liquidityUsd: thresholds.minimumLiquidityUsd - 1 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ volume24h: thresholds.minimumVolume24hUsd - 1 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ volume5m: thresholds.minimumVolume5mUsd - 1 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ buys5m: 5, sells5m: 7 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ buys5m: 5, sells5m: 7, volume5m: 5000 }), now), false);
});

test("does not qualify a pair without recent transaction data", () => {
  assert.equal(qualifiesLaunchCandidate(candidate({ buys5m: 0, sells5m: 0 }), now), false);
});

test("launch watcher is capped at three separate paper positions", () => {
  assert.equal(thresholds.maximumOpenPositions, 3);
  assert.equal(thresholds.paperEntryUsd, 10);
});
