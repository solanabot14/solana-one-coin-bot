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

const page = fs.readFileSync(path.join(__dirname, "terminal.html"), "utf8");

const CANDLE_BREAKOUT_DASHBOARD_API = "https://pubx-fast-momentum-production.up.railway.app/api/data";
const PROFITABILITY_LAB_API = "https://b31-profitability-lab-production.up.railway.app/api/lab-summary";

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

async function fetchProfitabilityLabDashboard() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(PROFITABILITY_LAB_API, { signal: controller.signal });
    if (!response.ok) return { data: null, error: "Profitability Lab feed unavailable (" + response.status + ")." };
    const body = await response.json();
    if (!body || body.paperOnly !== true) return { data: null, error: "Profitability Lab did not return paper account data." };
    return { data: body, error: null };
  } catch (error) {
    console.error("Profitability Lab dashboard feed unavailable:", error.message);
    return { data: null, error: "Profitability Lab data is temporarily unavailable." };
  } finally {
    clearTimeout(timeout);
  }
}

function createDashboardServer({ config = getConfig(), controls = bot,
  portfolio = getPortfolio, marketData = getTokenData,
  batchMarketData = marketData === getTokenData ? getTokensData : null } = {}) {
  const client = fs.readFileSync(path.join(__dirname, "dashboard-client.js"));
  const terminalCss = fs.readFileSync(path.join(__dirname, "terminal.css"));
  const analyticsCore = fs.readFileSync(path.join(__dirname, "analytics-core.js"));
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
        const [v31, candleBreakout, profitabilityLab] = await Promise.all([
          buildDashboardData(baseAccount, sharedMarketData),
          fetchCandleBreakoutDashboard(),
          fetchProfitabilityLabDashboard()
        ]);
        return json(res, {
          v31,
          candleBreakout: candleBreakout.data,
          candleBreakoutStatus: candleBreakout.status,
          candleBreakoutError: candleBreakout.error,
          profitabilityLab: profitabilityLab.data,
          profitabilityLabError: profitabilityLab.error
        });
      }
      if (route === "/dashboard-client.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(client); }
      if (route === "/analytics-core.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(analyticsCore); }
      if (route === "/terminal.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); return res.end(terminalCss); }
      if (route.startsWith("/api/")) return json(res, { error: "Not found" }, 404);
      if (path.extname(route)) return json(res, { error: "Not found" }, 404);
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
