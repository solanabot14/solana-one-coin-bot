const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNext25Review } = require("../profitSniperAnalytics");

const VERSION = "SNIPER-TEST";

test("next-25 review groups partial sales, excludes open and old-version trades, and audits stop fills", () => {
  const history = [];
  for (let i = 0; i < 26; i++) {
    const positionId = `closed-${i}`;
    const entryTime = new Date(1_800_000_000_000 + i * 10_000).toISOString();
    const exitTime = new Date(1_800_000_001_000 + i * 10_000).toISOString();
    const pnl = i % 2 ? -1 : 2;
    history.push({ type: "BUY", positionId, strategyVersion: VERSION, entryTime });
    if (i === 0) history.push({ type: "SELL", positionId, strategyVersion: VERSION,
      exitTime, reason: "TAKE PROFIT 1", pnl: 1 });
    history.push({ type: "SELL", positionId, strategyVersion: VERSION,
      exitTime: new Date(Date.parse(exitTime) + (i === 0 ? 1_000 : 0)).toISOString(),
      reason: i % 2 ? "HARD STOP -8%" : "TRAILING STOP -12%",
      pnl: i === 0 ? 1 : pnl, fillVsTriggerPercent: i % 2 ? -7 : null });
  }
  history.push({ type: "BUY", positionId: "open-1", strategyVersion: VERSION,
    entryTime: new Date().toISOString() });
  history.push({ type: "SELL", positionId: "old-version", strategyVersion: "OLD",
    exitTime: new Date().toISOString(), pnl: -500, reason: "HARD STOP -8%" });

  const review = buildNext25Review({ history, positions: [{ id: "open-1" }] }, VERSION);
  assert.equal(review.closedTrades, 25);
  assert.equal(review.remainingTrades, 0);
  assert.equal(review.complete, true);
  assert.equal(review.netPnlUsd, 14);
  assert.equal(review.wins, 13);
  assert.equal(review.losses, 12);
  assert.equal(review.hardStopFillAudit.exits, 12);
  assert.equal(review.hardStopFillAudit.exitsWithTriggerAndFill, 12);
  assert.equal(review.hardStopFillAudit.averageFillVsTriggerPercent, -7);
});

test("review remains incomplete until a position is fully closed", () => {
  const review = buildNext25Review({ history: [
    { type: "BUY", positionId: "p1", strategyVersion: VERSION, entryTime: "2026-10-18T00:00:00Z" },
    { type: "SELL", positionId: "p1", strategyVersion: VERSION, pnl: 1, exitTime: "2026-10-18T00:01:00Z" }
  ], positions: [{ id: "p1" }] }, VERSION);
  assert.equal(review.closedTrades, 0);
  assert.equal(review.remainingTrades, 25);
  assert.equal(review.complete, false);
});
