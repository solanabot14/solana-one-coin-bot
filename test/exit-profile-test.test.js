const { test } = require("node:test");
const assert = require("node:assert/strict");
const { exitTestConfig: config, evaluateExit } = require("../buyPriorityExitTest");

test("New Claude Exit Test keeps matched entries and position sizing", () => {
  assert.equal(config.capital.startingUsd, 100);
  assert.equal(config.capital.maxOpenPositions, 4);
  assert.equal(config.capital.tradeFraction, 0.10);
  assert.deepEqual(config.entry, {
    minimumAgeMinutes: 10,
    maximumAgeHours: 24,
    minimumLiquidityUsd: 15000,
    minimumVolume1hUsd: 5000,
    maximumRise15mPercent: 100,
    momentumLookbackMinutes: 5,
    momentumObservationRetentionMinutes: 10,
    maximumTop10HolderPercent: 30
  });
  assert.equal(config.exit.firstTargetOriginalPositionPercent, 20);
  assert.equal(config.exit.secondTargetOriginalPositionPercent, 20);
  assert.equal(config.exit.trailingStopPercent, 12);
});

test("exit test sells 20% at +25%, 20% of original at +60%, then trails the 60% runner at 12%", () => {
  const position = {
    entryPrice: 1, highestPrice: 1, entryTime: new Date(0).toISOString(),
    firstTakeProfitDone: false, secondTakeProfitDone: false
  };
  const now = 60_000;
  assert.deepEqual(evaluateExit({ position, currentPrice: 1.25, now }), {
    reason: "TAKE PROFIT +25% SELL 20%", percent: 20, takeProfit: "firstTakeProfitDone"
  });
  position.firstTakeProfitDone = true;
  position.highestPrice = 1.6;
  assert.deepEqual(evaluateExit({ position, currentPrice: 1.6, now }), {
    reason: "TAKE PROFIT +60% SELL 20%", percent: 25, takeProfit: "secondTakeProfitDone"
  });
  position.secondTakeProfitDone = true;
  assert.deepEqual(evaluateExit({ position, currentPrice: 1.408, now }), {
    reason: "TRAILING STOP 12%", percent: 100
  });
});
