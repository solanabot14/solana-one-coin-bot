"use strict";

const { createOutcomeBot } = require("../outcomeBot");

const bot = createOutcomeBot();
const seen = new Set();

function logNewTrades(history) {
  for (const row of history.slice().reverse()) {
    const key = [row.type, row.positionId, row.time || row.entryTime || row.exitTime].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    console.log("COINBASE_PAPER_TRADE", JSON.stringify({
      type: row.type, symbol: row.symbol, time: row.time || row.entryTime || row.exitTime,
      entryPrice: row.entryPrice, exitPrice: row.exitPrice, quantity: row.quantity,
      feeUsd: row.feeUsd || row.estimatedFeesUsd, pnlUsd: row.pnlUsd,
      reason: row.reason || row.entryReason, strategyVersion: row.strategyVersion || "COINBASE_INTRADAY_MOMENTUM_V4"
    }));
  }
}

function report() {
  try {
    const data = bot.getDashboardData();
    logNewTrades(data.history || []);
    const completed = data.completedTrades || [];
    const wins = completed.filter(trade => Number(trade.pnlUsd) > 0).length;
    console.log("COINBASE_PAPER_HEARTBEAT", JSON.stringify({
      at: new Date().toISOString(), running: data.running, openPositions: data.livePositions?.length || 0,
      completedTrades: completed.length, wins, winRatePercent: completed.length ? wins / completed.length * 100 : 0,
      netPnlUsd: completed.reduce((sum, trade) => sum + (Number(trade.pnlUsd) || 0), 0),
      equityUsd: data.equity, cashUsd: data.cashBalance, dailyPnlUsd: data.dailyPnlUsd,
      pausedForDailyLoss: data.pausedForDailyLoss, lastError: data.lastError
    }));
  } catch (error) {
    console.error("COINBASE_PAPER_REPORT_ERROR", error.message);
  }
}

bot.start();
report();
const reportTimer = setInterval(report, 60_000);

function shutdown() {
  clearInterval(reportTimer);
  bot.stop();
  console.log("COINBASE_PAPER_STOPPED", new Date().toISOString());
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
