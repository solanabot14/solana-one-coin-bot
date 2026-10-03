require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bot = require("./bot");
const { getPortfolio } = require("./paperTrader");
const { getTokenData, getTokensData } = require("./dexscreener");
const { buildDashboardData } = require("./dashboardData");
const swarm = require("./janMvpBot");
const pullbackBot = require("./pullbackBot");

function getConfig(env = process.env) {
  const railway = !!env.RAILWAY_ENVIRONMENT_ID;
  const host = env.HOST || (railway ? "0.0.0.0" : "127.0.0.1");
  const port = Number(env.PORT || 3000);
  const localOnly = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const dashboardUser = env.DASHBOARD_USER || "";
  const dashboardPassword = env.DASHBOARD_PASSWORD || "";
  if ((dashboardUser && !dashboardPassword) || (!dashboardUser && dashboardPassword)) {
    throw new Error("Set both DASHBOARD_USER and DASHBOARD_PASSWORD.");
  }
  if (!localOnly && (!dashboardUser || !dashboardPassword)) {
    throw new Error("Public dashboard access requires DASHBOARD_USER and DASHBOARD_PASSWORD.");
  }
  return { host, port, localOnly, dashboardUser, dashboardPassword };
}

function authorized(req, config) {
  if (!config.dashboardUser && !config.dashboardPassword) return true;
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization || "");
  if (!match) return false;
  let supplied;
  try { supplied = Buffer.from(match[1], "base64").toString("utf8"); } catch (_) { return false; }
  const expected = config.dashboardUser + ":" + config.dashboardPassword;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

const page = `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>1m Candle Breakout V1 Paper Test</title>

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

.panel-link{
  display:inline-block;
  border-radius:8px;
  padding:11px 18px;
  font-weight:bold;
  text-decoration:none;
  background:#172033;
  color:#fff;
}

.panel-link.swarm{
  background:#8fa7ff;
  color:#080b12;
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
    <h1>1m Candle Breakout V1</h1>
    <div class="subtitle">
      Closed candle breakout • Locked liquidity • Paper Trading
    </div>
  </div>

  <div id="status" class="status">
    BOT OFFLINE
  </div>
</div>

<div class="controls">
  <a class="panel-link" href="#v31Panel">V3.1 RECORDS</a>
  <a class="panel-link" href="#pullbackPanel">CANDLE BREAKOUT V1</a>
  <a class="panel-link swarm" href="#swarmPanel">SWARM</a>
</div>

<p id="notice" role="status">
  The isolated candle breakout paper test starts automatically. V3.1 records and strategy remain untouched.
</p>

<div id="v31Panel"></div>

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
    <div class="label">Total Return</div>
    <div class="value" id="pnlPct">0.00%</div>
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

<div class="card section"><h2>Open Slots</h2><div class="value" id="slots">0 / 3</div></div>\n\n<div class="card section">\n\n  <h2>Live Trade</h2>

  <div id="live" class="empty">
    Waiting for a trade...
  </div>

</div>

<div class="card section" id="pullbackPanel">
<h2>1m Candle Breakout V1 — Paper Test</h2>
<p class="muted">Separate $100 paper account with 3 slots. The test rotates through DexScreener and fresh Solana pools, then checks closed GeckoTerminal 1-minute candles. An entry needs a close at least 0.1% above the previous 3-candle high, at least 1.1× recent candle volume, and a close in the top 45% of the candle range. It uses a $20k liquidity floor, 8+ five-minute transactions, 52%+ buys, and $1.5k or 1.5% of liquidity in five-minute volume. Price must be within 2.5% of the breakout close. LP lock must be confirmed at 90% or more by RugCheck; unavailable lock data blocks the paper entry. Candle checks rotate 2 pools per 45-second scan.</p>
<p class="muted">Exits: 9% hard stop, sell half at +12%, trail the runner by 7% after it reaches +12%, with a +3% protection floor and a 12-minute stale-trade exit. Open positions are checked every 2 seconds. This is a paper experiment; it does not establish that the setup is profitable.</p>
<div class="grid">
  <div class="metric"><div class="metric-label">Status</div><div class="metric-value" id="pullbackStatus">—</div></div>
  <div class="metric"><div class="metric-label">Starting Balance</div><div class="metric-value" id="pullbackStarting">$100.00</div></div>
  <div class="metric"><div class="metric-label">Cash</div><div class="metric-value" id="pullbackCash">$100.00</div></div>
  <div class="metric"><div class="metric-label">Equity</div><div class="metric-value" id="pullbackEquity">$100.00</div></div>
  <div class="metric"><div class="metric-label">Total P/L ($)</div><div class="metric-value" id="pullbackPnl">$0.00</div></div>
  <div class="metric"><div class="metric-label">Total Return (%)</div><div class="metric-value" id="pullbackPnlPct">0.00%</div></div>
  <div class="metric"><div class="metric-label">Completed Positions</div><div class="metric-value" id="pullbackCount">0</div></div>
  <div class="metric"><div class="metric-label">Win Rate</div><div class="metric-value" id="pullbackWinRate">0.00%</div></div>
  <div class="metric"><div class="metric-label">Open Slots</div><div class="metric-value" id="pullbackSlots">0 / 3</div></div>
  <div class="metric"><div class="metric-label">LP-Approved / Candle-Scanned</div><div class="metric-value" id="pullbackWatching">0 / 0</div></div>
  <div class="metric"><div class="metric-label">LP Lock Rejections</div><div class="metric-value" id="pullbackLockRejected">0</div></div>
  <div class="metric"><div class="metric-label">Entry Feed</div><div class="metric-value" id="pullbackCandleFeed">Waiting for candle data</div></div>
</div>
<div class="section"><h3>Open Candle Breakout Positions</h3><div id="pullbackLive" class="empty">Waiting for a closed 1m breakout and LP-lock confirmation...</div></div>
<div class="section"><h3>Candle Breakout Completed Transactions</h3><p class="muted">Each trade shows dollars invested, dollars sold, realized P/L in dollars, and return percentage.</p><div style="overflow-x:auto"><table>
<thead><tr><th>Coin</th><th>Invested ($)</th><th>Total Sold ($)</th><th>Profit / Loss ($)</th><th>Return (%)</th><th>Entry Price</th><th>Average Exit Price</th><th>Entry Evidence</th><th>Exit Reason</th><th>Chart</th></tr></thead>
<tbody id="pullbackHistory"><tr><td colspan="10">No experimental trades yet.</td></tr></tbody>
</table></div></div>
</div>

<div class="card section">

<h2>V3.1 Performance</h2>

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
  No V3.1 trades yet.
</td>
</tr>
</tbody>

</table>

</div>
</div>

<div class="card section" id="swarmPanel">\n<h2>Swarm — $10 / 5 Concurrent Slots</h2>\n<p class="muted">Independent paper experiment: five $2 slots can be occupied simultaneously.</p>\n<div class="grid"><div class="metric"><div class="metric-label">Status</div><div class="metric-value" id="swarmStatus">—</div></div><div class="metric"><div class="metric-label">Starting Balance</div><div class="metric-value">$10.00</div></div><div class="metric"><div class="metric-label">Equity</div><div class="metric-value" id="swarmEquity">—</div></div><div class="metric"><div class="metric-label">P/L</div><div class="metric-value" id="swarmPnl">—</div></div><div class="metric"><div class="metric-label">Open Slots</div><div class="metric-value" id="swarmOpen">0 / 5</div></div></div>\n<div style="overflow-x:auto;margin-top:16px"><table><thead><tr><th>Slot</th><th>Cash</th><th>Position</th><th>Invested</th><th>Trades</th><th>W</th><th>L</th></tr></thead><tbody id="swarmSlots"><tr><td colspan="7">Waiting...</td></tr></tbody></table></div>\n</div>\n\n<div class="card section">
<h2>Entry Analytics</h2>
<p class="muted">Read-only analysis of completed V3.1 trades. This section does not affect trading.</p>
<div class="grid">
  <div class="metric"><div class="metric-label">Avg Entry Score</div><div class="metric-value" id="avgEntryScore">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry 5m</div><div class="metric-value" id="avgEntry5m">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry 1h</div><div class="metric-value" id="avgEntry1h">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry Buy Ratio</div><div class="metric-value" id="avgEntryRatio">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry Transactions</div><div class="metric-value" id="avgEntryTx">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry Liquidity</div><div class="metric-value" id="avgEntryLiquidity">—</div></div>
  <div class="metric"><div class="metric-label">Avg Entry 24h Volume</div><div class="metric-value" id="avgEntryVolume">—</div></div>
  <div class="metric"><div class="metric-label">Best Trade Return</div><div class="metric-value" id="bestReturn">—</div></div>
  <div class="metric"><div class="metric-label">Worst Trade Return</div><div class="metric-value" id="worstReturn">—</div></div>
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

<h2>Completed Transactions</h2>
<p class="muted">Dollar amounts: invested, total sold, and realized profit or loss. Swipe horizontally for the remaining trade details.</p>

<div style="overflow-x:auto">

<table>

<thead>
<tr>
  <th>Coin</th>
  <th>Invested ($)</th>
  <th>Total Sold ($)</th>
  <th>Profit / Loss ($)</th>
  <th>Return (%)</th>
  <th>Score</th>
  <th>Entry 5m</th>
  <th>Entry 1h</th>
  <th>Entry Buy Ratio</th>
  <th>Entry Tx</th>
  <th>Entry Liquidity ($)</th>
  <th>Entry 24h Volume ($)</th>
  <th>Entry 24h</th>
  <th>Entry Signal</th>
  <th>Entry Reasons</th>
  <th>Entry Price</th>
  <th>Average Exit Price</th>
  <th>TP1 Sold ($)</th>
  <th>TP2 Sold ($)</th>
  <th>Trailing Sold ($)</th>
  <th>Other Exit ($)</th>
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

<script src="/dashboard-client.js" defer></script>

</body>
</html>`;

const pubxControls = { startBot: pullbackBot.start, stopBot: pullbackBot.stop,
  getBotStatus: pullbackBot.getStatus, getLastError: pullbackBot.getLastError };

function createDashboardServer({ config = getConfig(), controls = pubxControls,
  portfolio = getPortfolio, marketData = getTokenData,
  batchMarketData = marketData === getTokenData ? getTokensData : null,
  experiment = pullbackBot, experimentPortfolio = pullbackBot.getPortfolio } = {}) {
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
      if (!authorized(req, config)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Trading dashboard", charset="UTF-8"');
        return json(res, { error: "Authentication required" }, 401);
      }
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
      if (route === "/api/swarm") return json(res, { running: swarm.getStatus(), error: swarm.getLastError(), ...swarm.getDashboardState() });
      if (route === "/api/data") {
        const baseAccount = portfolio();
        const experimentAccount = experimentPortfolio();
        const addresses = [...new Set([
          ...(baseAccount.positions || (baseAccount.position ? [baseAccount.position] : [])).map(p => p.tokenAddress),
          ...(experimentAccount.positions || (experimentAccount.position ? [experimentAccount.position] : [])).map(p => p.tokenAddress)
        ].filter(Boolean))];
        const sharedQuotes = batchMarketData && addresses.length
          ? await batchMarketData(addresses)
          : null;
        const sharedMarketData = sharedQuotes
          ? async address => sharedQuotes.get(address) || null
          : marketData;
        const [v31, pullback] = await Promise.all([
          buildDashboardData(baseAccount, sharedMarketData),
          buildDashboardData(experimentAccount, sharedMarketData)
        ]);
        return json(res, {
          v31,
          pullback,
          pullbackStatus: {
            running: experiment.getStatus(),
            error: experiment.getLastError(),
            ...experiment.getStrategyStatus()
          }
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
  getPortfolio();
  const server = createDashboardServer({ config });
  pullbackBot.start();
  server.listen(config.port, config.host, () => console.log("Dashboard listening on " + config.host + ":" + config.port));
  const shutdown = () => {
    pullbackBot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 12000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createDashboardServer, getConfig };
