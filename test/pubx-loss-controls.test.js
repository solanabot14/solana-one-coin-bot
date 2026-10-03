const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy } = require("../pullbackStrategy");
const { createFastMomentumExitPolicy } = require("../pubxTestExitPolicy");

function coin(overrides = {}) {
  return { tokenAddress:"mint-a", pairAddress:"pair-a", symbol:"TEST", priceUsd:0.001,
    liquidityUsd:25000, volume5m:2000, buys5m:8, sells5m:4,
    priceChange5m:5, priceChange1h:30, ...overrides };
}

function confirm(strategy, candidate, t=Date.now()) {
  strategy.observe([candidate], t);
  strategy.observe([{...candidate, priceUsd:Number(candidate.priceUsd)*1.01}], t+30000);
  return strategy.observe([{...candidate, priceUsd:Number(candidate.priceUsd)*1.02}], t+60000);
}

test("step-3 admits soft pumps while rejecting a sharp single-scan chase", () => {
  const strategy = createPullbackStrategy();
  assert.equal(confirm(strategy, coin({priceChange5m:18,priceChange1h:75})).length, 1);
  const sharp = createPullbackStrategy();
  const candidate = coin({tokenAddress:"late-5m",priceChange5m:18.01});
  assert.equal(confirm(sharp, candidate).length, 0);
  assert.equal(sharp.getStatus().rejectedByFilter.FIVE_MINUTE_MOMENTUM_OUT_OF_RANGE, 1);
  const spike = createPullbackStrategy();
  spike.observe([coin({tokenAddress:"single-spike",priceUsd:0.001})], 1000);
  assert.equal(spike.observe([coin({tokenAddress:"single-spike",priceUsd:0.00108})], 31000).length, 0);
  assert.equal(spike.getStatus().rejectedByFilter.SINGLE_STEP_MOVE_TOO_SHARP, 1);
});

test("test-only exits take early profit, cut fast, and force position rotation", () => {
  const exit = createFastMomentumExitPolicy();
  const base = {entryTime:new Date(0).toISOString(),firstTakeProfitDone:false};
  assert.equal(exit({position:base,profitPercent:-6,dropFromHigh:6,highestProfitPercent:0,freshData:{},now:1000}).reason,
    "FAST MOMENTUM HARD STOP (-6% target)");
  assert.equal(exit({position:base,profitPercent:-5.9,dropFromHigh:5.9,highestProfitPercent:0,freshData:{},now:1000}), null);
  assert.equal(exit({position:base,profitPercent:8,dropFromHigh:0,highestProfitPercent:8,freshData:{},now:1000}).percent, 50);
  assert.equal(exit({position:{...base,firstTakeProfitDone:true},profitPercent:4,dropFromHigh:5,
    highestProfitPercent:12,freshData:{},now:1000}).reason, "FAST MOMENTUM RUNNER TRAIL");
  assert.equal(exit({position:base,profitPercent:1,dropFromHigh:0,highestProfitPercent:1,
    freshData:{},now:15*60*1000}).reason, "FAST MOMENTUM MAX HOLD (15 MINUTES)");
  assert.equal(exit({position:base,profitPercent:1,dropFromHigh:0,highestProfitPercent:4,
    freshData:{},now:8*60*1000}).reason, "FAST MOMENTUM STALE EXIT (8 MINUTES)");
});
