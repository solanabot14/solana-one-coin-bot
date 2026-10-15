const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  getOriginalPositionExitProgress,
  percentOfRemainingToReachOriginalTarget
} = require("../bot");

test("V3.1 target sale catches a position up to 40% of original after an earlier partial", () => {
  const position = { id: "position-1", quantity: 0.75 };
  const history = [
    { type: "BUY", positionId: "position-1", quantity: 1 },
    { type: "SELL", positionId: "position-1", quantitySold: 0.25 }
  ];

  const progress = getOriginalPositionExitProgress(position, history);
  assert.equal(progress.soldPercent, 25);
  assert.ok(Math.abs(percentOfRemainingToReachOriginalTarget(position, history, 40) - 20) < 1e-12);
  assert.ok(Math.abs(percentOfRemainingToReachOriginalTarget(position, history, 80) - 73.33333333333333) < 1e-12);
});

test("V3.1 second target sells two thirds of the remaining quantity and leaves 20% of original", () => {
  const position = { id: "position-2", quantity: 0.6 };
  const history = [
    { type: "BUY", positionId: "position-2", quantity: 1 },
    { type: "SELL", positionId: "position-2", quantitySold: 0.4 }
  ];

  const secondSalePercent = percentOfRemainingToReachOriginalTarget(position, history, 80);
  assert.equal(secondSalePercent, 66.66666666666667);
  assert.ok(Math.abs(position.quantity * (1 - secondSalePercent / 100) - 0.2) < 1e-12);
});

test("V3.1 does not resell a cumulative target already reached", () => {
  const position = { id: "position-3", quantity: 0.6 };
  const history = [
    { type: "BUY", positionId: "position-3", quantity: 1 },
    { type: "SELL", positionId: "position-3", quantitySold: 0.4 }
  ];

  assert.equal(percentOfRemainingToReachOriginalTarget(position, history, 40), 0);
});

