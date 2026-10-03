const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy } = require("../pullbackStrategy");
const { createFastMomentumExitPolicy } = require("../pubxTestExitPolicy");

function coin(overrides = {}) {
  return { tokenAddress:"mint-a", pairAddress:"pair-a", symbol:"TEST", priceUsd:0.001,
    liquidityUsd:25000, volume5m:2000, buys5m:8, sells5m:4,
    priceChange5m:5, priceChange1h:30, ...overrides };
}

test("loss-control entry limits accept moderate momentum and reject extended pumps", () => {
  const strategy = createPullbackStrategy();
  assert.equal(strategy.observe([coin({priceChange5m:12,priceChange1h:75})]).length, 1);
  assert.equal(strategy.observe([coin({tokenAddress:"late-5m",priceChange5m:12.01})]).length, 0);
  assert.equal(strategy.getStatus().rejectedByFilter.FIVE_MINUTE_MOMENTUM_OUT_OF_RANGE, 1);
  assert.equal(strategy.observe([coin({tokenAddress:"late-1h",priceChange1h:75.01})]).length, 0);
  assert.equal(strategy.getStatus().rejectedByFilter.ONE_HOUR_MOMENTUM_OUT_OF_RANGE, 1);
});

test("test-only stop exits at -6% while preserving take-profit and runner rules", () => {
  const exit = createFastMomentumExitPolicy();
  const position = {entryTime:new Date(0).toISOString(),firstTakeProfitDone:false};
  assert.equal(exit({position,profitPercent:-6,dropFromHigh:6,highestProfitPercent:0,freshData:{},now:1000}).reason,
    "FAST MOMENTUM HARD STOP (-6% target)");
  assert.equal(exit({position,profitPercent:-5.9,dropFromHigh:5.9,highestProfitPercent:0,freshData:{},now:1000}), null);
  assert.equal(exit({position,profitPercent:12,dropFromHigh:0,highestProfitPercent:12,freshData:{},now:1000}).percent, 50);
  assert.equal(exit({position:{...position,firstTakeProfitDone:true},profitPercent:4,dropFromHigh:7,
    highestProfitPercent:13,freshData:{},now:1000}).reason, "FAST MOMENTUM RUNNER TRAIL");
});
