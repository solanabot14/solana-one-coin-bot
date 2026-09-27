const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildTokenDiversityView } = require("../dashboardData");

const NOW = Date.parse("2026-09-27T00:00:00Z");

function trade(overrides = {}) {
  return {
    tokenAddress:"token",
    symbol:"TOKEN",
    entryTime:"2026-09-26T20:00:00Z",
    exitTime:"2026-09-26T21:00:00Z",
    pnl:1,
    maxGainPercent:15,
    ...overrides
  };
}

test("dashboard marks a normal recent winner as resting", () => {
  const view = buildTokenDiversityView([trade()], null, NOW);
  assert.equal(view.rows[0].status, "RESTING 24H");
  assert.equal(view.rows[0].wins24h, 1);
  assert.equal(view.rows[0].entries24h, 1);
  assert.equal(view.rows[0].availableAt, Date.parse("2026-09-27T21:00:00Z"));
});

test("dashboard marks loss as second chance and two entries as limited", () => {
  const one = buildTokenDiversityView([
    trade({ pnl:-1, maxGainPercent:5 })
  ], null, NOW);
  assert.equal(one.rows[0].status, "SECOND CHANCE");

  const two = buildTokenDiversityView([
    trade({ pnl:-1, maxGainPercent:5 }),
    trade({
      entryTime:"2026-09-26T22:00:00Z",
      exitTime:"2026-09-26T23:00:00Z",
      pnl:-0.5,
      maxGainPercent:3
    })
  ], null, NOW);
  assert.equal(two.rows[0].entries24h, 2);
  assert.equal(two.rows[0].status, "REENTRY LIMIT");
});

test("dashboard marks 30 percent max-gain token as runner watch", () => {
  const view = buildTokenDiversityView([
    trade({ pnl:2, maxGainPercent:45 })
  ], null, NOW);
  assert.equal(view.rows[0].status, "RUNNER WATCH");
});

test("open OG position is shown as open now and counted", () => {
  const open = {
    tokenAddress:"open-token",
    symbol:"OPEN",
    entryTime:"2026-09-26T23:30:00Z"
  };
  const view = buildTokenDiversityView([], open, NOW);
  assert.equal(view.rows[0].status, "OPEN NOW");
  assert.equal(view.rows[0].entries24h, 1);
});
