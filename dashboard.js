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
  return { host, port, localOnly, dashboardUser, dashboardPassword,
    readOnly: !dashboardUser && !dashboardPassword };
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
<title>B3.1 Profitability Lab — Paper Only</title>

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

.overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.overview-card{min-width:0;display:flex;flex-direction:column;gap:8px;padding:13px;border-radius:10px;border:1px solid #283141;background:#0b1018;color:#fff;text-decoration:none}
.overview-card:focus-visible{outline:2px solid #8fa7ff;outline-offset:2px}
.overview-card:hover{border-color:#8fa7ff}
.overview-title{font-size:13px;font-weight:bold;line-height:1.25}
.overview-state{font-size:10px;text-transform:uppercase;color:#b7c0d0}
.overview-state.online{color:#4cff9a}
.overview-value{font-size:20px;font-weight:bold;line-height:1.15;overflow-wrap:anywhere}
.overview-meta{font-size:11px;color:#8792a5;line-height:1.4}

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

@media(max-width:700px){
  body{padding:12px}
  .value{font-size:21px}
  .overview-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .overview-card{padding:10px;gap:6px}
  .overview-value{font-size:18px}
}
</style>
</head>

<body>

<div class="container">

<div class="header">
  <div>
    <h1>B3.1 Profitability Lab — Paper Only</h1>
    <div class="subtitle">
      Fast momentum lab • two paper slots • estimated execution costs included
    </div>
  </div>

  <div id="status" class="status">
    BOT OFFLINE
  </div>
</div>

<div class="controls">
  <a class="panel-link" href="#v31Panel">PROFITABILITY LAB</a>
  <a class="panel-link" href="#candleBreakoutPanel">CANDLE BREAKOUT V1.1</a>
  <a class="panel-link swarm" href="#swarmPanel">SWARM</a>
</div>

<p id="notice" role="status">
  V3.1 and Swarm run on this service. The Candle Breakout V1.1 Expanded Entry panel below mirrors the separate paper test.
</p>

<div class="card section" id="overview">
  <h2>All Paper Tests</h2>
  <div class="overview-grid">
    <a class="overview-card" href="https://solana-one-coin-bot-production.up.railway.app/" target="_blank" rel="noopener noreferrer">
      <span class="overview-title">Original V3.1</span>
      <span class="overview-state" id="overviewOriginalStatus">CHECKING</span>
      <span class="overview-value" id="overviewOriginalValue">Open dashboard</span>
      <span class="overview-meta">Original strategy · separate dashboard</span>
    </a>
    <a class="overview-card" href="#candleBreakoutPanel">
      <span class="overview-title">PubX Fast Momentum</span>
      <span class="overview-state" id="overviewPubxStatus">CONNECTING</span>
      <span class="overview-value" id="overviewPubxPnl">—</span>
      <span class="overview-meta"><span id="overviewPubxOpen">— open</span> · <span id="overviewPubxTrades">— closed</span></span>
    </a>
    <a class="overview-card" href="#v31Panel">
      <span class="overview-title">New Profitability Lab</span>
      <span class="overview-state" id="overviewLabStatus">CONNECTING</span>
      <span class="overview-value" id="overviewLabPnl">—</span>
      <span class="overview-meta"><span id="overviewLabOpen">— open</span> · <span id="overviewLabTrades">— closed</span></span>
    </a>
    <a class="overview-card" href="#swarmPanel">
      <span class="overview-title">Swarm</span>
      <span class="overview-state" id="overviewSwarmStatus">CONNECTING</span>
      <span class="overview-value" id="overviewSwarmPnl">—</span>
      <span class="overview-meta"><span id="overviewSwarmOpen">— open</span> · <span id="overviewSwarmTrades">— closed</span></span>
    </a>
  </div>
</div>

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

<div class="card section"><h2>Open Slots</h2><div class="value" id="slots">0 / 2</div></div>\n\n<div class="card section">\n\n  <h2>Live Trade</h2>

  <div id="live" class="empty">
    Waiting for a trade...
  </div>

</div>

<div class="card section" id="candleBreakoutPanel">
<h2>1m Candle Breakout V1.1 — Expanded Entry Live Paper Test</h2>
<p class="muted">This panel mirrors the separate Candle Breakout V1.1 Expanded Entry paper account. It enters when a closed 1-minute candle closes above the previous 3-candle high, with at least average candle volume and a close in the upper 55% of its range. It keeps the $20k liquidity floor, 8+ transactions and 52% buys, $1.5k or 1.5% liquidity in five-minute volume, and a 2.5% maximum chase. It requires RugCheck-confirmed LP lock of at least 90% and checks up to 8 pools every 60 seconds.</p>
<p class="muted">Exit plan: 9% hard stop, sell half at +12%, then trail the runner by 7% with a +3% protection floor; also exits on flow fade or after 12 minutes without enough progress. Paper trading only.</p>
<p><a class="small-link" href="https://pubx-fast-momentum-production.up.railway.app/" target="_blank" rel="noopener noreferrer">Open the standalone Candle Breakout V1.1 dashboard</a></p>
<div class="grid">
  <div class="metric"><div class="metric-label">Test Status</div><div class="metric-value" id="candleStatus">Connecting…</div></div>
  <div class="metric"><div class="metric-label">Starting Balance</div><div class="metric-value" id="candleStarting">$100.00</div></div>
  <div class="metric"><div class="metric-label">Cash</div><div class="metric-value" id="candleCash">—</div></div>
  <div class="metric"><div class="metric-label">Equity</div><div class="metric-value" id="candleEquity">—</div></div>
  <div class="metric"><div class="metric-label">Total P/L</div><div class="metric-value" id="candlePnl">—</div></div>
  <div class="metric"><div class="metric-label">Total Return</div><div class="metric-value" id="candleReturn">—</div></div>
  <div class="metric"><div class="metric-label">Completed Positions</div><div class="metric-value" id="candleCount">—</div></div>
  <div class="metric"><div class="metric-label">Win Rate</div><div class="metric-value" id="candleWinRate">—</div></div>
  <div class="metric"><div class="metric-label">Open Slots</div><div class="metric-value" id="candleSlots">—</div></div>
  <div class="metric"><div class="metric-label">LP-Approved / Candle-Scanned</div><div class="metric-value" id="candleScanned">—</div></div>
  <div class="metric"><div class="metric-label">LP Lock Rejections</div><div class="metric-value" id="candleRejected">—</div></div>
  <div class="metric"><div class="metric-label">Candle Feed</div><div class="metric-value" id="candleFeed">Connecting…</div></div>
</div>
<div class="section"><h3>Live Test Positions</h3><div id="candleOpen" class="empty">Waiting for a candle breakout…</div></div>
<div class="section"><h3>Completed Test Transactions</h3><div style="overflow-x:auto"><table>
<thead><tr><th>Coin</th><th>Invested</th><th>Sold</th><th>Realized P/L</th><th>Return</th><th>Entry Price</th><th>Exit Price</th><th>Exit Reason</th><th>Chart</th></tr></thead>
<tbody id="candleHistory"><tr><td colspan="9">Waiting for live test data…</td></tr></tbody>
</table></div></div>
</div>

<div class="card section">

<h2>Profitability Lab Performance</h2>

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
  No lab trades yet.
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

const CANDLE_BREAKOUT_DASHBOARD_API = "https://pubx-fast-momentum-production.up.railway.app/api/data";
const ORIGINAL_V31_HEALTH_API = "https://solana-one-coin-bot-production.up.railway.app/healthz";

async function fetchCandleBreakoutDashboard() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(CANDLE_BREAKOUT_DASHBOARD_API, {
      signal: controller.signal
    });
    if (!response.ok) return { data: null, status: null, error: "Candle Breakout feed unavailable (" + response.status + ")." };
    const body = await response.json();
    if (!body || !body.pullback) return { data: null, status: null, error: "Candle Breakout account data was not returned." };
    return { data: body.pullback, status: body.pullbackStatus || null, error: null };
  } catch (error) {
    console.error("Candle Breakout dashboard feed unavailable:", error.message);
    return { data: null, status: null, error: "Candle Breakout data is temporarily unavailable." };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOriginalV31Status() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(ORIGINAL_V31_HEALTH_API, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    console.error("Original V3.1 health check unavailable:", error.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function createDashboardServer({ config = getConfig(), controls = bot,
  portfolio = getPortfolio, marketData = getTokenData,
  batchMarketData = marketData === getTokenData ? getTokensData : null } = {}) {
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
      if (req.method === "GET" && route === "/api/lab-summary") {
        const account = portfolio();
        const dashboard = await buildDashboardData(account, marketData);
        const stats = dashboard.stats || {};
        const recentTrades = (dashboard.completedTrades || []).slice(0, 15).map(trade => ({
          symbol: trade.symbol || "-",
          amountInvested: trade.amountInvested,
          saleValue: trade.saleValue,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          exitReasons: trade.exitReasons || [],
          exitTime: trade.exitTime || null
        }));
        return json(res, {
          name: "B3.1 Profitability Lab",
          paperOnly: true,
          running: controls.getBotStatus(),
          startingBalance: dashboard.startingBalance,
          cashBalance: dashboard.cashBalance,
          equity: dashboard.equity,
          totalPnl: dashboard.totalPnl,
          totalPnlPercent: dashboard.totalPnlPercent,
          openSlots: dashboard.openSlots,
          maxSlots: dashboard.maxSlots,
          completedTrades: stats.completedTrades || 0,
          winners: stats.winners || 0,
          losers: stats.losers || 0,
          winRate: stats.winRate || 0,
          profitFactor: stats.profitFactorLabel || "—",
          recentTrades,
          openPositions: (dashboard.livePositions || []).map(({ position, live }) => ({
            symbol: position?.symbol || "-",
            name: position?.name || "-",
            tokenAddress: position?.tokenAddress || "",
            pairAddress: position?.pairAddress || live?.pairAddress || null,
            amountInvested: position?.amountInvested ?? null,
            entryPrice: position?.entryPrice ?? null,
            currentPrice: live?.currentPrice ?? null,
            pnl: live?.pnl ?? null,
            pnlPercent: live?.pnlPercent ?? null,
            maxGainPercent: live?.maxGainPercent ?? null,
            holdTimeMs: live?.holdTimeMs ?? null
          }))
        });
      }
      if (req.method === "GET" && route === "/api/original-v31-status") {
        return json(res, { online: await fetchOriginalV31Status() });
      }
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
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/start") controls.startBot(); else controls.stopBot();
        return json(res, { running: controls.getBotStatus() });
      }
      if (req.method !== "GET") return json(res, { error: "Method not allowed" }, 405);
      if (route === "/api/status") return json(res, { running: controls.getBotStatus(), error: controls.getLastError() });
      if (route === "/api/swarm") return json(res, { running: swarm.getStatus(), error: swarm.getLastError(), ...swarm.getDashboardState() });
      if (route === "/api/data") {
        const baseAccount = portfolio();
        const addresses = [...new Set([
          ...(baseAccount.positions || (baseAccount.position ? [baseAccount.position] : [])).map(p => p.tokenAddress)
        ].filter(Boolean))];
        const sharedQuotes = batchMarketData && addresses.length
          ? await batchMarketData(addresses)
          : null;
        const sharedMarketData = sharedQuotes
          ? async address => sharedQuotes.get(address) || null
          : marketData;
        const [v31, candleBreakout] = await Promise.all([
          buildDashboardData(baseAccount, sharedMarketData),
          fetchCandleBreakoutDashboard()
        ]);
        return json(res, {
          v31,
          candleBreakout: candleBreakout.data,
          candleBreakoutStatus: candleBreakout.status,
          candleBreakoutError: candleBreakout.error
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
  bot.startBot();
  swarm.start();
  server.listen(config.port, config.host, () => console.log("Dashboard listening on " + config.host + ":" + config.port));
  const shutdown = () => {
    swarm.stop();
    bot.stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 12000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createDashboardServer, getConfig, fetchCandleBreakoutDashboard };
