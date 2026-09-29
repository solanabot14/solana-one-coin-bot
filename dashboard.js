require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const bot = require("./bot");
const { getPortfolio, sell, positionKey } = require("./paperTrader");
const { getTokenData } = require("./dexscreener");
const { buildDashboardData } = require("./dashboardData");
const scanner = require("./scanner");
const janSlotEngine = require("./janSlotEngine");
const janMvpBot = require("./janMvpBot");
const { createRuntimeState } = require("./runtimeState");

function getConfig(env = process.env) {
  const railway = !!env.RAILWAY_ENVIRONMENT_ID;
  const host = env.HOST || (railway ? "0.0.0.0" : "127.0.0.1");
  const port = Number(env.PORT || 3000);
  const localOnly = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  return { host, port, localOnly };
}

const page = `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solana One Coin Bot</title>

<style>
*{box-sizing:border-box}

body{
  margin:0;
  padding:22px;
  background:#080b12;
  color:#fff;
  font:14px Arial
}

.container{
  max-width:1400px;
  margin:auto
}

.header,.controls{
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap
}

.tabs{
  display:flex;
  gap:8px;
  margin:18px 0;
  flex-wrap:wrap
}

.tab-button{
  background:#111722;
  color:#8792a5;
  border:1px solid #222b3a;
}

.tab-button.active{
  background:#172033;
  color:#fff;
  border-color:#3a4964
}

.tab-panel{display:none}
.tab-panel.active{display:block}

.progress{
  height:9px;
  background:#0b1018;
  border-radius:8px;
  overflow:hidden;
  margin-top:8px
}

.progress-fill{
  height:100%;
  background:#4cff9a
}

.header{
  justify-content:space-between;
  margin-bottom:20px
}

h1{margin:0 0 5px}
h2{margin-top:0}

.subtitle,.label,th,.empty,.muted{
  color:#8792a5
}

.status{
  padding:9px 15px;
  border-radius:20px;
  background:#29151b;
  color:#ff5c72;
  font-weight:bold
}

.online{
  background:#123d2b;
  color:#4cff9a
}

button{
  border:0;
  border-radius:8px;
  padding:11px 18px;
  font-weight:bold;
  cursor:pointer
}

.start{background:#4cff9a}

.stop{
  background:#ff5c72;
  color:#fff
}

.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:12px
}

.card{
  background:#111722;
  border:1px solid #222b3a;
  border-radius:12px;
  padding:18px
}

.section{margin-top:18px}

.label{
  text-transform:uppercase;
  font-size:12px;
  margin-bottom:7px
}

.value{
  font-size:25px;
  font-weight:bold
}

.green{color:#4cff9a}
.red{color:#ff5c72}

.metric{
  background:#0b1018;
  border-radius:9px;
  padding:13px
}

.metric-label{
  color:#8792a5;
  font-size:11px;
  text-transform:uppercase;
  margin-bottom:6px
}

.metric-value{
  font-size:18px;
  font-weight:bold
}

.live-title{
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap:wrap;
  margin-bottom:15px
}

.coin-name{
  font-size:22px;
  font-weight:bold
}

.badge{
  display:inline-block;
  padding:5px 9px;
  border-radius:15px;
  background:#172033;
  color:#a9baff;
  font-size:12px;
  font-weight:bold
}

.small-link{
  color:#8fa7ff;
  text-decoration:none
}

.small-link:hover{
  text-decoration:underline
}

.reasons{
  margin-top:14px;
  padding:13px;
  background:#0b1018;
  border-radius:9px;
  line-height:1.6
}

table{
  width:100%;
  border-collapse:collapse
}

th,td{
  text-align:left;
  padding:11px;
  border-bottom:1px solid #283141;
  white-space:nowrap
}

.analytics-table th,
.analytics-table td{
  text-align:center
}

.analytics-table th:first-child,
.analytics-table td:first-child{
  text-align:left
}

@media(max-width:600px){
  body{padding:14px}
  .value{font-size:21px}
}
</style>
</head>

<body>

<div class="container">

<div class="header">
  <div>
    <h1>Solana One Coin Bot</h1>
    <div class="subtitle">
      Entry V5.9 • Risk V3.4 • Profit Lock + Runner • Paper Trading
    </div>
  </div>

  <div id="status" class="status">
    BOT OFFLINE
  </div>
</div>

<div class="controls">
  <button class="start" id="startButton">
    START BOT
  </button>

  <button class="stop" id="stopButton">
    STOP BOT
  </button>
</div>

<p id="notice" role="status">
  Stopping pauses automatic exits and keeps your open position.
</p>

<div class="tabs" role="tablist" aria-label="Dashboard views">
  <button class="tab-button active" id="botTab" type="button">Current Bot</button>
  <button class="tab-button" id="slotTab" type="button">Swarm</button>
</div>

<div id="botPanel" class="tab-panel active">

<div class="grid">

  <div class="card">
    <div class="label">Starting Balance</div>
    <div class="value" id="starting">$0.00</div>
  </div>

  <div class="card">
    <div class="label">Cash</div>
    <div class="value" id="cash">$0.00</div>
  </div>

  <div class="card">
    <div class="label">Equity</div>
    <div class="value" id="equity">$0.00</div>
  </div>

  <div class="card">
    <div class="label">Total P/L</div>
    <div class="value" id="pnl">$0.00</div>
  </div>

  <div class="card">
    <div class="label">Completed Positions</div>
    <div class="value" id="count">0</div>
  </div>

  <div class="card">
    <div class="label">Win Rate</div>
    <div class="value" id="winrate">0%</div>
  </div>

</div>

<div class="card section">

  <h2>Live Trade</h2>

  <div id="live" class="empty">
    Waiting for a trade...
  </div>

</div>

<div class="card section">

<h2>Overall Performance</h2>

<div class="grid">

  <div class="metric">
    <div class="metric-label">Winners</div>
    <div class="metric-value green" id="winners">0</div>
  </div>

  <div class="metric">
    <div class="metric-label">Losers</div>
    <div class="metric-value red" id="losers">0</div>
  </div>

  <div class="metric">
    <div class="metric-label">Gross Profit</div>
    <div class="metric-value green" id="profit">$0.00</div>
  </div>

  <div class="metric">
    <div class="metric-label">Gross Loss</div>
    <div class="metric-value red" id="loss">$0.00</div>
  </div>

  <div class="metric">
    <div class="metric-label">Net P/L</div>
    <div class="metric-value" id="net">$0.00</div>
  </div>

  <div class="metric">
    <div class="metric-label">Profit Factor</div>
    <div class="metric-value" id="factor">—</div>
  </div>

  <div class="metric">
    <div class="metric-label">Avg Winner</div>
    <div class="metric-value green" id="avgWinner">—</div>
  </div>

  <div class="metric">
    <div class="metric-label">Avg Loser</div>
    <div class="metric-value red" id="avgLoser">—</div>
  </div>

  <div class="metric">
    <div class="metric-label">Avg Hold Time</div>
    <div class="metric-value" id="avgHold">—</div>
  </div>

  <div class="metric">
    <div class="metric-label">Avg Max Gain</div>
    <div class="metric-value" id="avgMaxGain">—</div>
  </div>

</div>
</div>

<div class="card section">

<h2>V3.6 Pump Structure Protection</h2>

<p class="muted">
  New OG entries are tagged V3.6. This section tracks the current entry strategy separately so V3.5 remains frozen as historical research.
</p>

<div class="grid">
  <div class="metric"><div class="metric-label">V3.6 Completed</div><div class="metric-value" id="v36Trades">0</div></div>
  <div class="metric"><div class="metric-label">V3.6 Win Rate</div><div class="metric-value" id="v36WinRate">0%</div></div>
  <div class="metric"><div class="metric-label">V3.6 Net P/L</div><div class="metric-value" id="v36Net">$0.00</div></div>
  <div class="metric"><div class="metric-label">V3.6 Profit Factor</div><div class="metric-value" id="v36Factor">—</div></div>
  <div class="metric"><div class="metric-label">Expectancy / Trade</div><div class="metric-value" id="v36Expectancy">—</div></div>
  <div class="metric"><div class="metric-label">Payoff Ratio</div><div class="metric-value" id="v36Payoff">—</div></div>
  <div class="metric"><div class="metric-label">Realized Max Drawdown</div><div class="metric-value" id="v36Drawdown">—</div></div>
  <div class="metric"><div class="metric-label">Max Loss Streak</div><div class="metric-value" id="v36LossStreak">0</div></div>
  <div class="metric"><div class="metric-label">Dataset Started</div><div class="metric-value" id="v36Started">Waiting for first V3.6 trade</div></div>
  <div class="metric"><div class="metric-label">Dataset Start Balance</div><div class="metric-value" id="v36StartBalance">—</div></div>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead><tr><th>Strategy Version</th><th>Trades</th><th>Win Rate</th><th>Expectancy</th><th>Profit Factor</th><th>Net P/L</th></tr></thead>
<tbody id="strategyVersionStats"><tr><td colspan="6">No completed strategy data yet.</td></tr></tbody>
</table>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead><tr><th>V3.6 Discovery Source</th><th>Trades</th><th>Win Rate</th><th>Expectancy</th><th>Profit Factor</th><th>Net P/L</th></tr></thead>
<tbody id="v36SourceStats"><tr><td colspan="6">Waiting for V3.6 trades.</td></tr></tbody>
</table>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead><tr><th>V3.6 Birdeye Rank</th><th>Trades</th><th>Win Rate</th><th>Expectancy</th><th>Profit Factor</th><th>Net P/L</th></tr></thead>
<tbody id="v36RankStats"><tr><td colspan="6">Waiting for Birdeye-ranked V3.6 trades.</td></tr></tbody>
</table>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead><tr><th>Frozen Baseline</th><th>Trades</th><th>Win Rate</th><th>Expectancy</th><th>Profit Factor</th><th>Net P/L</th></tr></thead>
<tbody id="v35ArchiveStats"><tr><td colspan="6">Waiting for archived V3.5 data.</td></tr></tbody>
</table>
</div>

</div>

<div class="card section">

<h2>Discovery Mix</h2>

<p class="muted">
  Latest discovery scan across DexScreener and Birdeye sources. All tokens are deduplicated before validation.
</p>

<div class="grid">
  <div class="metric">
    <div class="metric-label">Unique Solana Tokens</div>
    <div class="metric-value" id="discoveryUnique">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Passed Safety Filters</div>
    <div class="metric-value" id="discoveryPassed">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Strong Buys</div>
    <div class="metric-value" id="discoveryStrong">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Last Scan</div>
    <div class="metric-value" id="discoveryUpdated">—</div>
  </div>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead>
<tr>
  <th>Source</th>
  <th>Type</th>
  <th>Tokens Received</th>
</tr>
</thead>
<tbody id="discoverySources">
<tr><td colspan="3">Waiting for scan data...</td></tr>
</tbody>
</table>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead>
<tr>
  <th>Top Candidate</th>
  <th>Score</th>
  <th>Signal</th>
  <th>Discovery Source</th>
</tr>
</thead>
<tbody id="discoveryCandidates">
<tr><td colspan="4">Waiting for scan data...</td></tr>
</tbody>
</table>
</div>

</div>

<div class="card section">

<h2>Rejection Telemetry</h2>

<p class="muted">
  Latest OG scan only. Counts can overlap because one token may fail more than one STRONG BUY confirmation.
  Volume and Smart Money fields are shown for context. Post-Pump, Current Activity, Late Momentum, Market Data Integrity and Birdeye Pre-Discovery Pump are active entry protections.
</p>

<div class="grid">
  <div class="metric">
    <div class="metric-label">Not Strong Buy</div>
    <div class="metric-value" id="rejectNotStrong">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Score Below 8</div>
    <div class="metric-value" id="rejectScore">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">5m Confirmation</div>
    <div class="metric-value" id="reject5m">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">1h Confirmation</div>
    <div class="metric-value" id="reject1h">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Buy Ratio &lt; 55%</div>
    <div class="metric-value" id="rejectRatio">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Transactions &lt; 20</div>
    <div class="metric-value" id="rejectTx">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Anti-Chase 5m</div>
    <div class="metric-value" id="rejectAnti5m">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Anti-Chase 1h</div>
    <div class="metric-value" id="rejectAnti1h">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Anti-Chase 24h</div>
    <div class="metric-value" id="rejectAnti24h">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Post-Pump Guard</div>
    <div class="metric-value" id="rejectPostPump">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Current Activity Gate</div>
    <div class="metric-value" id="rejectCurrentActivity">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Late Momentum Guard</div>
    <div class="metric-value" id="rejectLateMomentum">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Market Data Integrity</div>
    <div class="metric-value" id="rejectMarketIntegrity">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Pre-Discovery Pump</div>
    <div class="metric-value" id="rejectPreDiscoveryPump">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Post-Pump Rebound</div>
    <div class="metric-value" id="rejectPostPumpRebound">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Birdeye OHLCV Status</div>
    <div class="metric-value" id="birdeyeOhlcvStatus">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Birdeye OHLCV Requests</div>
    <div class="metric-value" id="birdeyeOhlcvRequests">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">OHLCV Cache Hits</div>
    <div class="metric-value" id="birdeyeOhlcvCacheHits">0</div>
  </div>
  <div class="metric">
    <div class="metric-label">Dex Discovery Health</div>
    <div class="metric-value" id="dexDiscoveryHealth">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Smart Money Status</div>
    <div class="metric-value" id="smartMoneyStatus">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Smart Money Matches</div>
    <div class="metric-value" id="smartMoneyMatches">0</div>
  </div>
</div>

<div style="overflow-x:auto; margin-top:16px">
<table>
<thead>
<tr>
  <th>Near Entry</th>
  <th>Score</th>
  <th>Signal</th>
  <th>5m</th>
  <th>1h</th>
  <th>Buy Ratio</th>
  <th>5m Tx</th>
  <th>5m Volume</th>
  <th>5m Vol/Liq</th>
  <th>15m Extension</th>
  <th>Historical 15m</th>
  <th>Historical 30m</th>
  <th>Smart Money</th>
  <th>Blocked By</th>
  <th>Source</th>
</tr>
</thead>
<tbody id="rejectionNearEntries">
<tr><td colspan="15">Waiting for scan data...</td></tr>
</tbody>
</table>
</div>

</div>

<div class="card section">

<h2>Token Diversity</h2>

<p class="muted">
  Read-only view of the OG token reentry rules. This section does not change trading behavior.
</p>

<div style="overflow-x:auto">

<table>
<thead>
<tr>
  <th>Coin</th>
  <th>Status</th>
  <th>Entries 24h</th>
  <th>Wins</th>
  <th>Losses</th>
  <th>Max Gain</th>
  <th>Available Again</th>
  <th>Reason</th>
</tr>
</thead>

<tbody id="diversityRows">
<tr><td colspan="8">No recent token activity.</td></tr>
</tbody>
</table>

</div>
</div>

<div class="card section">

<h2>Performance by Entry Score</h2>

<div style="overflow-x:auto">

<table class="analytics-table">

<thead>
<tr>
  <th>Score</th>
  <th>Trades</th>
  <th>Wins</th>
  <th>Losses</th>
  <th>Win Rate</th>
  <th>Avg Return</th>
  <th>Avg Max Gain</th>
  <th>Net P/L</th>
</tr>
</thead>

<tbody id="scoreStats">
<tr>
<td colspan="8">
  No completed trades yet.
</td>
</tr>
</tbody>

</table>

</div>
</div>

<div class="card section">

<h2>Exit Reasons</h2>

<div id="exitReasons" class="grid">
  <div class="metric">
    No completed positions yet.
  </div>
</div>

</div>

<div class="card section">

<h2>Completed Positions</h2>

<div style="overflow-x:auto">

<table>

<thead>
<tr>
  <th>Coin</th>
  <th>Version</th>
  <th>Birdeye Rank</th>
  <th>Score</th>
  <th>Entry 5m</th>
  <th>Entry 1h</th>
  <th>Entry Buy Ratio</th>
  <th>Entry 5m Vol</th>
  <th>15m Extension</th>
  <th>Smart Money</th>
  <th>Source</th>
  <th>Entry</th>
  <th>Average Exit</th>
  <th>Invested</th>
  <th>TP1 $</th>
  <th>TP2 $</th>
  <th>Trailing $</th>
  <th>Other Exit $</th>
  <th>Total Sold $</th>
  <th>P/L</th>
  <th>Return</th>
  <th>Max Gain</th>
  <th>Hold Time</th>
  <th>Exit Reason</th>
  <th>Chart</th>
</tr>
</thead>

<tbody id="history"></tbody>

</table>

</div>
</div>

</div>

<div id="slotPanel" class="tab-panel">

<div class="card section">
  <h2>Swarm</h2>
  <p class="muted">
    Independent concurrent paper simulation. Swarm uses the OG scanner candidate cache only for new entries,
    refills free slots immediately, and can mirror the OG opportunity while other slots trade different qualifying coins.
  </p>

  <div class="controls" style="margin-bottom:16px">
    <div id="janStatus" class="status">SWARM OFFLINE</div>
  </div>
  <p id="janNotice" class="muted">Swarm follows the main bot automatically. START BOT starts both; STOP BOT pauses both.</p>

  <div class="grid">
    <div class="metric">
      <div class="metric-label">Swarm Starting Capital</div>
      <div class="metric-value" id="slotStarting">$10.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Swarm Capital</div>
      <div class="metric-value" id="slotTotal">$10.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Simulated P/L</div>
      <div class="metric-value" id="slotPnl">$0.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Milestones</div>
      <div class="metric-value" id="slotTarget">$10 SPLIT → $100</div>
    </div>
    <div class="metric">
      <div class="metric-label">Completed Swarm Trades</div>
      <div class="metric-value" id="slotTrades">0</div>
    </div>
  </div>
</div>

<div class="card section">
  <h2>Independent Slots</h2>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Slot</th>
          <th>Cash</th>
          <th>Open Position</th>
          <th>Invested</th>
          <th>Next Target</th>
          <th>Progress</th>
          <th>Completed</th>
          <th>Wins</th>
          <th>Losses</th>
        </tr>
      </thead>
      <tbody id="slotRows">
        <tr><td colspan="9">Waiting for Swarm activity...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="card section">
  <h2>Target Ladder</h2>
  <div id="slotTargets" class="grid"></div>
</div>

<div class="card section">
  <h2>Slot Executions</h2>
  <div style="overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Slot</th>
          <th>Coin</th>
          <th>Price</th>
          <th>Amount</th>
          <th>Reason / P&L</th>
        </tr>
      </thead>
      <tbody id="slotExecutions">
        <tr><td colspan="7">Waiting for slot executions...</td></tr>
      </tbody>
    </table>
  </div>
</div>

</div>

</div>

<script src="/dashboard-client.js" defer></script>

</body>
</html>`;

function createDashboardServer({ config = getConfig(), controls = bot,
  portfolio = getPortfolio, marketData = getTokenData, slotEngine = null,
  janControls = janMvpBot, runtimeState = createRuntimeState() } = {}) {
  const client = fs.readFileSync(path.join(__dirname, "dashboard-client.js"));
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const requestUrl = new URL(req.url, "http://localhost");
      const route = requestUrl.pathname;
      if (req.method === "GET" && route === "/healthz") return json(res, { ok: true });
      if (config.localOnly) {
        const hostname = new URL("http://" + req.headers.host).hostname;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return json(res, { error: "Invalid host" }, 403);
      }
      if (route === "/api/start" || route === "/api/stop" || route === "/api/manual-exit") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);

        if (route === "/api/manual-exit") {
          const currentPortfolio = portfolio();
          const position = currentPortfolio.position;
          if (!position) return json(res, { success: false, error: "No OG position is open." }, 409);

          const expectedPosition = positionKey(position);
          const freshData = await marketData(position.tokenAddress, {
            pairAddress: position.pairAddress || undefined
          });
          const currentPrice = Number(freshData?.priceUsd);
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            return json(res, { success: false, error: "Fresh exit price unavailable." }, 503);
          }

          const result = sell(currentPrice, 100, {
            expectedPosition,
            reason: "MANUAL EXIT"
          });
          if (!result.success) return json(res, result, 409);

          console.log(
            "MANUAL EXIT | " + position.symbol +
            " | Price: " + currentPrice +
            " | Position: " + expectedPosition
          );

          return json(res, {
            success: true,
            symbol: position.symbol,
            exitPrice: currentPrice,
            reason: "MANUAL EXIT",
            trade: result.trade
          });
        }

        if (route === "/api/start") {
          controls.startBot();
          janControls.start();
          runtimeState.setRunning();
        } else {
          runtimeState.setStopped();
          janControls.stop();
          controls.stopBot();
        }
        return json(res, {
          running: controls.getBotStatus(),
          swarmRunning: janControls.getStatus()
        });
      }
      if (req.method !== "GET") return json(res, { error: "Method not allowed" }, 405);
      if (route === "/api/status") return json(res, { running: controls.getBotStatus(), error: controls.getLastError() });
      if (route === "/api/jan/status") return json(res, { running: janControls.getStatus(), error: janControls.getLastError() });
      if (route === "/api/data") {
        const data = await buildDashboardData(portfolio(), marketData);
        if (janControls?.getDashboardState) data.slotSimulation = janControls.getDashboardState();
        else if (slotEngine?.getDashboardState) data.slotSimulation = slotEngine.getDashboardState();
        data.discoveryTelemetry = scanner.getDiscoveryTelemetry();
        return json(res, data);
      }
      if (route === "/api/audit/recent") {
        const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") || "25", 10);
        const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 25));
        const data = await buildDashboardData(portfolio(), marketData);
        const completedTrades = Array.isArray(data.completedTrades) ? data.completedTrades.slice(0, limit) : [];
        const swarmState = janControls?.getDashboardState ? janControls.getDashboardState() : null;
        const swarmExecutions = Array.isArray(swarmState?.executions)
          ? swarmState.executions.filter(item => item?.closedTrade).slice(0, limit)
          : [];
        return json(res, {
          generatedAt: new Date().toISOString(),
          currentStrategy: "V5.9 Paper-Testing + 1h Activity Gate + Helius Optional + Pre-Helius 52 + Age-Aware Momentum + 90% LP Lock + 90m Stagnation Exit",
          riskEngine: "V3.4 Profit Lock + Runner",
          livePosition: data.live || null,
          completedTrades,
          swarmClosedTrades: swarmExecutions,
          discoveryTelemetry: scanner.getDiscoveryTelemetry()
        });
      }
      if (route === "/dashboard-client.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(client); }
      if (route !== "/") return json(res, { error: "Not found" }, 404);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page);
    } catch (error) {
      console.error("Dashboard request failed:", error.message);
      json(res, { error: "Request failed. Check server logs." }, 500);
    }
  });
}
function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
}
if (require.main === module) {
  const config = getConfig();
  const runtimeState = createRuntimeState();
  getPortfolio();

  const desired = runtimeState.read();
  if (desired.desiredRunning) {
    console.log("RUNTIME RESTORE | Previous state was RUNNING | Restoring OG + Swarm");
    bot.startBot();
    janMvpBot.start();
  } else {
    console.log("RUNTIME RESTORE | Previous state was STOPPED");
  }

  const server = createDashboardServer({
    config,
    janControls: janMvpBot,
    runtimeState
  });

  server.listen(config.port, config.host, () => console.log("Dashboard listening on " + config.host + ":" + config.port));

  // Keep Swarm coupled to OG in the server process, independent of whether a browser is open.
  const couplingInterval = setInterval(() => {
    if (!bot.getBotStatus() && janMvpBot.getStatus()) {
      console.log("SWARM COUPLING | OG offline, pausing Swarm");
      janMvpBot.stop();
    } else if (bot.getBotStatus() && !janMvpBot.getStatus() && runtimeState.read().desiredRunning) {
      console.log("SWARM COUPLING | OG online, restoring Swarm");
      janMvpBot.start();
    }
  }, 2000);

  const shutdown = () => {
    clearInterval(couplingInterval);
    // Do not overwrite desiredRunning here. Railway/process restarts must restore the prior user choice.
    janMvpBot.stop();
    bot.stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 12000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createDashboardServer, getConfig };
