require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const bot = require("./bot");
const { getPortfolio } = require("./paperTrader");
const { getTokenData } = require("./dexscreener");
const { buildDashboardData } = require("./dashboardData");
const janSlotEngine = require("./janSlotEngine");

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
      Strategy V3.4 • Profit Lock + Runner • Paper Trading
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
  <button class="tab-button" id="slotTab" type="button">Slot Compounding Lab</button>
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
  <th>Score</th>
  <th>Entry 5m</th>
  <th>Entry 1h</th>
  <th>Entry Buy Ratio</th>
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
  <h2>Slot Compounding Lab</h2>
  <p class="muted">
    Automatic shadow paper system. Completed trades from the original bot are assigned to independent
    slots and compounded separately. Slot state is stored separately and never changes the original bot.
  </p>

  <div class="grid">
    <div class="metric">
      <div class="metric-label">Lab Starting Capital</div>
      <div class="metric-value" id="slotStarting">$10.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Simulated Slot Capital</div>
      <div class="metric-value" id="slotTotal">$10.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Simulated P/L</div>
      <div class="metric-value" id="slotPnl">$0.00</div>
    </div>
    <div class="metric">
      <div class="metric-label">Milestones</div>
      <div class="metric-value" id="slotTarget">$10 → $50 → $100 → $150</div>
    </div>
    <div class="metric">
      <div class="metric-label">Trades Replayed</div>
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
          <th>Balance</th>
          <th>Target</th>
          <th>Progress</th>
          <th>Trades</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>Last Coin</th>
          <th>Last Return</th>
        </tr>
      </thead>
      <tbody id="slotRows">
        <tr><td colspan="9">Waiting for completed trades...</td></tr>
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
          <th>Slot</th>
          <th>Coin</th>
          <th>Return</th>
          <th>Before</th>
          <th>After</th>
          <th>Milestone</th>
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
  portfolio = getPortfolio, marketData = getTokenData, slotEngine = null } = {}) {
  const client = fs.readFileSync(path.join(__dirname, "dashboard-client.js"));
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const route = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && route === "/healthz") return json(res, { ok: true });
      if (config.localOnly) {
        const hostname = new URL("http://" + req.headers.host).hostname;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return json(res, { error: "Invalid host" }, 403);
      }
      if (route === "/api/start" || route === "/api/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/start") controls.startBot(); else controls.stopBot();
        return json(res, { running: controls.getBotStatus() });
      }
      if (req.method !== "GET") return json(res, { error: "Method not allowed" }, 405);
      if (route === "/api/status") return json(res, { running: controls.getBotStatus(), error: controls.getLastError() });
      if (route === "/api/data") {
        const data = await buildDashboardData(portfolio(), marketData);
        if (slotEngine?.getDashboardState) data.slotSimulation = slotEngine.getDashboardState();
        return json(res, data);
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
  const portfolio = getPortfolio();
  janSlotEngine.initializeFromPortfolio(portfolio).catch(error =>
    console.error("Jan slot initialization failed:", error.message)
  );
  const slotSyncInterval = setInterval(() => {
    janSlotEngine.syncFromPortfolio(getPortfolio()).catch(error =>
      console.error("Jan slot sync failed:", error.message)
    );
  }, 5000);
  const server = createDashboardServer({ config, slotEngine: janSlotEngine });
  server.listen(config.port, config.host, () => console.log("Dashboard listening on " + config.host + ":" + config.port));
  const shutdown = () => {
    clearInterval(slotSyncInterval);
    bot.stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 12000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createDashboardServer, getConfig };
