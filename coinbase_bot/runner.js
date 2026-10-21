"use strict";

const http = require("node:http");
const { createOutcomeBot } = require("./outcomeBot");

const bot = createOutcomeBot();
const seen = new Set();

function enrichDashboardData() {
  const data = bot.getDashboardData();
  const history = Array.isArray(data.history) ? data.history : [];
  const buys = new Map(history.filter(row => row && row.type === "BUY" && row.positionId).map(row => [row.positionId, row]));
  data.completedTrades = (data.completedTrades || []).map(trade => {
    const buy = buys.get(trade.positionId) || {};
    const entryReason = trade.entryReason || trade.entrySignal || buy.entryReason || buy.entrySignal ||
      (Array.isArray(buy.entryReasons) ? buy.entryReasons.join(", ") : null) ||
      (buy.entryMetrics?.entrySetup ? `${buy.entryMetrics.entrySetup} momentum entry` : null) ||
      "Legacy Coinbase momentum entry";
    return {
      ...trade,
      entryReason,
      entrySignal: trade.entrySignal || buy.entrySignal || buy.entryMetrics?.entrySetup || null,
      entryReasons: trade.entryReasons || buy.entryReasons || [entryReason],
      entryScore: trade.entryScore ?? buy.entryScore ?? buy.entryMetrics?.score ?? null,
      strategyVersion: trade.strategyVersion || buy.strategyVersion || data.strategyVersion || "COINBASE_SELECTIVE_MOMENTUM_V6"
    };
  });
  return data;
}

function logNewTrades(history, strategyVersion) {
  for (const row of history.slice().reverse()) {
    const key = [row.type, row.positionId, row.time || row.entryTime || row.exitTime].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    console.log("COINBASE_PAPER_TRADE", JSON.stringify({
      type: row.type, symbol: row.symbol, time: row.time || row.entryTime || row.exitTime,
      entryPrice: row.entryPrice, exitPrice: row.exitPrice, quantity: row.quantity,
      feeUsd: row.feeUsd || row.estimatedFeesUsd, pnlUsd: row.pnlUsd,
      reason: row.reason || row.entryReason,
      strategyVersion: row.strategyVersion || strategyVersion || "COINBASE_SELECTIVE_MOMENTUM_V6"
    }));
  }
}

function report() {
  try {
    const data = enrichDashboardData();
    logNewTrades(data.history || [], data.strategyVersion);
    const completed = data.completedTrades || [];
    const wins = completed.filter(trade => Number(trade.pnlUsd) > 0).length;
    console.log("COINBASE_PAPER_HEARTBEAT", JSON.stringify({
      at: new Date().toISOString(), strategyVersion: data.strategyVersion, running: data.running,
      openPositions: data.livePositions?.length || 0, completedTrades: completed.length, wins,
      winRatePercent: completed.length ? wins / completed.length * 100 : 0,
      netPnlUsd: completed.reduce((sum, trade) => sum + (Number(trade.pnlUsd) || 0), 0),
      equityUsd: data.equity, cashUsd: data.cashBalance, dailyPnlUsd: data.dailyPnlUsd,
      pausedForDailyLoss: data.pausedForDailyLoss, lastError: data.lastError
    }));
  } catch (error) {
    console.error("COINBASE_PAPER_REPORT_ERROR", error.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "GET only" }));
    return;
  }
  if (req.url === "/health") {
    const status = bot.getStatus();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "PAPER", strategyVersion: status.strategyVersion }));
    return;
  }
  let data;
  if (req.url === "/api/outcome/data") data = enrichDashboardData();
  else if (req.url === "/api/outcome/status") data = bot.getStatus();
  else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
});

server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log("COINBASE_PAPER_API_READY", JSON.stringify({ port: Number(process.env.PORT || 3000) }));
});

bot.start();
report();
const reportTimer = setInterval(report, 60_000);

function shutdown() {
  clearInterval(reportTimer);
  bot.stop();
  server.close();
  console.log("COINBASE_PAPER_STOPPED", new Date().toISOString());
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
