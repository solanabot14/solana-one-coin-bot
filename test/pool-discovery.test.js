const test = require("node:test");
const assert = require("node:assert/strict");
const { mapLaunchPair, qualifiesLaunchCandidate, qualifiesPoolObservation, selectTrackedPools,
  selectTrackedPoolsAcrossAgeWindow, thresholds } = require("../poolDiscovery");

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

test("maps duplicate tickers only to their exact Solana mint and pool", () => {
  const descriptorA = { tokenAddress: "mint-A", poolAddress: "pool-A", createdAt: now - 1000 };
  const descriptorB = { tokenAddress: "mint-B", poolAddress: "pool-B", createdAt: now - 1000 };
  const pairA = { chainId: "solana", pairAddress: "pool-A",
    baseToken: { address: "mint-A", symbol: "SAME", name: "Same" },
    priceUsd: "1", liquidity: { usd: 20000 }, volume: { m5: 2000, h24: 0 },
    priceChange: { m5: 1 }, txns: { m5: { buys: 8, sells: 4 } } };
  assert.equal(mapLaunchPair(pairA, descriptorA).tokenAddress, "mint-A");
  assert.equal(mapLaunchPair(pairA, descriptorA).pairAddress, "pool-A");
  assert.equal(mapLaunchPair(pairA, descriptorB), null);
  assert.equal(mapLaunchPair({ ...pairA, baseToken: { ...pairA.baseToken, address: "mint-B" } }, descriptorA), null);
});

test("accepts a fresh, liquid pair with active buy flow", () => {
  assert.equal(qualifiesLaunchCandidate(candidate(), now), true);
  assert.equal(qualifiesLaunchCandidate(candidate({ liquidityUsd: 15000 }), now, 15000), true);
  assert.equal(qualifiesLaunchCandidate(candidate({ volume24h: 10000 }), now, 15000, 10000), true);
  assert.equal(qualifiesLaunchCandidate(candidate({ volume24h: 10000 }), now, 15000), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ liquidityUsd: 15000 }), now), false);
});

test("a young or inactive exact pool can be observed before it qualifies for entry", () => {
  const young = { ...candidate({ pairCreatedAt: now - 30_000, volume5m: 0, liquidityUsd: 15_000 }),
    chainId: "solana", tokenAddress: "mint-A", pairAddress: "pool-A", priceUsd: 1 };
  assert.equal(qualifiesPoolObservation(young, now), true);
  assert.equal(qualifiesLaunchCandidate(young, now, 15_000, 5_000), false);
  assert.equal(qualifiesPoolObservation({ ...young, liquidityUsd: 0.50 }, now), true);
  assert.equal(qualifiesPoolObservation({ ...young, pairAddress: null }, now), false);
});

test("the default launch lane stays at 30 minutes and mature discovery accepts pools through 72 hours", () => {
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: now - 31 * 60 * 1000 }), now), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: now - 71 * 60 * 60 * 1000 }), now,
    thresholds.minimumLiquidityUsd, thresholds.minimumVolume24hUsd, 72 * 60 * 60 * 1000), true);
  assert.equal(qualifiesPoolObservation(candidate({ chainId: "solana", tokenAddress: "mint-A", pairAddress: "pool-A",
    pairCreatedAt: now - 71 * 60 * 60 * 1000 }), now, 72 * 60 * 60 * 1000), true);
  assert.equal(qualifiesPoolObservation(candidate({ pairCreatedAt: now - 73 * 60 * 60 * 1000 }), now,
    72 * 60 * 60 * 1000), false);
  assert.equal(qualifiesLaunchCandidate(candidate({ pairCreatedAt: undefined }), now), false);
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

test("reserves discovery capacity for pools mature enough to enter", () => {
  const young = Array.from({ length: 100 }, (_, index) => ({
    poolAddress: `young-${index}`, createdAt: now - index * 1000
  }));
  const mature = Array.from({ length: 5 }, (_, index) => ({
    poolAddress: `mature-${index}`, createdAt: now - (20 + index) * 60 * 1000
  }));
  const selected = selectTrackedPools([...young, ...mature], now, 10, 10 * 60 * 1000, 3);
  assert.equal(selected.length, 10);
  assert.equal(selected.filter(item => item.poolAddress.startsWith("mature-")).length, 3);
  assert.equal(selected.filter(item => item.poolAddress.startsWith("young-")).length, 7);
});

test("reserves discovery capacity across the full five-minute to six-hour window", () => {
  const agesMinutes = [2, 10, 40, 120, 240];
  const pools = agesMinutes.flatMap((age, bucket) => Array.from({ length: 30 }, (_, index) => ({
    poolAddress: `bucket-${bucket}-${index}`,
    createdAt: now - (age * 60_000 + index)
  })));
  const selected = selectTrackedPoolsAcrossAgeWindow(pools, now, 50);
  assert.equal(selected.length, 50);
  for (let bucket = 0; bucket < agesMinutes.length; bucket++) {
    assert.equal(selected.filter(item => item.poolAddress.startsWith(`bucket-${bucket}-`)).length, 10);
  }
});


