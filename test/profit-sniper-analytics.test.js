const test = require("node:test");
const assert = require("node:assert/strict");
const { buildProfitSniper48h } = require("../profitSniperAnalytics");

test("builds a cost-adjusted 48-hour Sniper summary by Puerto Rico day and watchlist source", () => {
  const now = Date.parse("2026-10-15T04:30:00Z");
  const watch = ["AGE WATCHLIST REENTRY"];
  const portfolio = { positions: [], history: [
    { type: "BUY", positionId: "a", entryTime: "2026-10-14T23:30:00Z", entryReasons: watch },
    { type: "SELL", positionId: "a", exitTime: "2026-10-15T00:30:00Z", netPnl: 2, entryReasons: watch },
    { type: "BUY", positionId: "b", entryTime: "2026-10-15T04:10:00Z", entryReasons: [] },
    { type: "SELL", positionId: "b", exitTime: "2026-10-15T04:20:00Z", netPnl: -3,
      reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY", entryReasons: [] },
    { type: "BUY", positionId: "old", entryTime: "2026-10-12T00:00:00Z", entryReasons: [] }
  ] };
  const result = buildProfitSniper48h(portfolio, [
    { at: now - 1000, counts: { age: 3, liquidity: 2 } },
    { at: now - 49 * 60 * 60 * 1000, counts: { age: 99 } }
  ], now);
  assert.deepEqual(result.entries, { total: 2, byDay: { "2026-10-14": 1, "2026-10-15": 1 }, fromWatchlist: 1 });
  assert.deepEqual(result.rejections, { age: 3, liquidity: 2 });
  assert.equal(result.closedTrades.total, 2);
  assert.equal(result.closedTrades.winRatePercent, 50);
  assert.equal(result.pnlAfterCostsUsd, -1);
  assert.deepEqual(result.pnlByEntrySourceUsd, { watchlist: 2, other: -3 });
  assert.deepEqual(result.noLiquidityOrWriteOff, { count: 1, lossUsd: -3 });
});
