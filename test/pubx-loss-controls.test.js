const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy } = require("../pullbackStrategy");

function coin(overrides = {}) {
  return { tokenAddress:"mint-a", pairAddress:"pair-a", symbol:"TEST", priceUsd:0.001,
    liquidityUsd:60000, volume24h:80000, volume5m:6000, buys5m:14, sells5m:8,
    priceChange5m:45, priceChange1h:90, ...overrides };
}

test("requires a spike, pullback, reclaim, renewed flow, and two reclaim checks", () => {
  const strategy = createPullbackStrategy();
  assert.equal(strategy.observe([coin()], 1000).length, 0);
  assert.equal(strategy.observe([coin({priceUsd:0.00105})], 31000).length, 0);
  assert.equal(strategy.getStatus().rejectedByFilter.WAITING_FOR_3_TO_12_PERCENT_PULLBACK, 1);
  assert.equal(strategy.observe([coin({priceUsd:0.00096,volume5m:5500})], 61000).length, 0);
  const first = strategy.observe([coin({priceUsd:0.00105,volume5m:8000})], 91000);
  assert.equal(first.length, 0);
  const entry = strategy.observe([coin({priceUsd:0.00106,volume5m:8500})], 121000);
  assert.equal(entry.length, 1);
  assert.equal(entry[0].signal, "STRONG BUY");
  assert.equal(entry[0].experimentEntry.model, "PUBX_MOMENTUM_CONTINUATION_PULLBACK_RECLAIM_V1");
  assert.ok(entry[0].experimentEntry.pullbackPercent >= 8 && entry[0].experimentEntry.pullbackPercent <= 9);
});

test("rejects weak liquidity, volume, reclaim extension, and excessive pullback", () => {
  const lowLiquidity = createPullbackStrategy();
  lowLiquidity.observe([coin({liquidityUsd:39999})], 1000);
  assert.equal(lowLiquidity.getStatus().rejectedByFilter.LIQUIDITY_BELOW_40000, 1);
  const lowVolume = createPullbackStrategy();
  lowVolume.observe([coin({volume24h:49999})], 1000);
  assert.equal(lowVolume.getStatus().rejectedByFilter.VOLUME_24H_BELOW_50000, 1);

  const extended = createPullbackStrategy();
  extended.observe([coin()], 1000);
  extended.observe([coin({priceUsd:0.00096})], 31000);
  assert.equal(extended.observe([coin({priceUsd:0.00104,volume5m:9000})], 61000).length, 0);
  assert.equal(extended.getStatus().rejectedByFilter.RECLAIM_TOO_EXTENDED, 1);

  const deep = createPullbackStrategy();
  deep.observe([coin()], 1000);
  deep.observe([coin({priceUsd:0.00087})], 31000);
  assert.equal(deep.getStatus().rejectedByFilter.PULLBACK_EXCEEDED_12_PERCENT, 1);
});

test("requires 20 transactions, a 55% to 80% buy ratio, and renewed volume", () => {
  const strategy = createPullbackStrategy();
  strategy.observe([coin()], 1000);
  strategy.observe([coin({priceUsd:0.00096,volume5m:5500})], 31000);
  strategy.observe([coin({priceUsd:0.001,volume5m:8000,buys5m:10,sells5m:9})], 61000);
  assert.equal(strategy.getStatus().rejectedByFilter.FEWER_THAN_20_TRANSACTIONS, 1);
});
