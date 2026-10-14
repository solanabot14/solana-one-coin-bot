require("dotenv").config();
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bot = require("./bot");
const { getPortfolio, positionKey } = require("./paperTrader");
const { getTokenData, getTokensData } = require("./dexscreener");
const { buildDashboardData } = require("./dashboardData");
const swarm = require("./janMvpBot");
const buyPriorityLock85 = require("./buyPriorityLock85");
const launchSniper = require("./launchSniper");
const profitSniper = require("./profitSniper");
const walletCopy = require("./walletCopy");
const geminiBot = require("./geminiBot");
const geminiTrader = require("./geminiTrader");
const { buildGeminiAnalytics } = require("./geminiAnalytics");
const outcomeBot = require("./outcomeBot");

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
    if (!response.ok) return { data: null, status: null, error: "Pullback + Reclaim Momentum feed unavailable (" + response.status + ")." };
    const body = await response.json();
    if (!body || !body.pullback) return { data: null, status: null, error: "Pullback + Reclaim Momentum account data was not returned." };
    return { data: body.pullback, status: body.pullbackStatus || null, error: null };
  } catch (error) {
    console.error("Pullback + Reclaim Momentum dashboard feed unavailable:", error.message);
    return { data: null, status: null, error: "Pullback + Reclaim Momentum data is temporarily unavailable." };
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

function applyBuyPriorityCostEstimates(data) {
  if (!data) return data;
  const costsByPosition = new Map();
  for (const row of data.history || []) {
    if (row.type !== "SELL") continue;
    const prior = costsByPosition.get(row.positionId) || {
      estimatedCostUsd: 0, estimatedFeesUsd: 0, estimatedSlippageUsd: 0, grossPnl: 0
    };
    costsByPosition.set(row.positionId, {
      estimatedCostUsd: prior.estimatedCostUsd + Number(row.estimatedCostUsd || 0),
      estimatedFeesUsd: prior.estimatedFeesUsd + Number(row.estimatedFeesUsd || 0),
      estimatedSlippageUsd: prior.estimatedSlippageUsd + Number(row.estimatedSlippageUsd || 0),
      grossPnl: prior.grossPnl + Number(row.grossPnl ?? row.pnl ?? 0)
    });
  }
  data.completedTrades = (data.completedTrades || []).map(trade => {
    const cost = costsByPosition.get(trade.positionId) || {
      estimatedCostUsd: 0, estimatedFeesUsd: 0, estimatedSlippageUsd: 0, grossPnl: trade.pnl
    };
    return {
      ...trade,
      grossPnl: cost.grossPnl,
      netPnl: Number(trade.pnl || 0),
      estimatedCostUsd: cost.estimatedCostUsd,
      estimatedFeesUsd: cost.estimatedFeesUsd,
      estimatedSlippageUsd: cost.estimatedSlippageUsd,
      costEstimateAvailable: true,
      pnlPercent: Number(trade.amountInvested) > 0
        ? Number(trade.pnl || 0) / Number(trade.amountInvested) * 100
        : trade.pnlPercent
    };
  });
  const realizedEstimatedCosts = [...costsByPosition.values()]
    .reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  let openEstimatedCosts = 0;
  let openEstimatedFees = 0;
  for (const item of data.livePositions || []) {
    const position = item.position || {};
    const live = item.live || {};
    const value = Number(live.currentValue) || 0;
    const assumptions = position.experimentEntry?.estimatedCostModel || {};
    const liquidity = Number(live.liquidityUsd || assumptions.entryLiquidityUsd) || 0;
    const impact = value > 0 && liquidity > 0 ? value / (liquidity / 2 + value) * 100 : null;
    const poolFeeRate = Number(assumptions.assumedPoolFeePercentPerSwap || 0) / 100;
    const networkFee = Number(assumptions.estimatedSolanaNetworkFeeUsdPerSwap || 0);
    const priorityFee = Number(assumptions.estimatedPriorityFeeUsdPerSwap || 0);
    const entryCosts = position.remainingEntryCosts || {};
    const remainingEntryCosts = (Number(entryCosts.feesUsd) || 0) + (Number(entryCosts.slippageUsd) || 0);
    const remainingEntryFees = Number(entryCosts.feesUsd) || 0;
    const futureExitFees = value > 0 ? value * poolFeeRate + networkFee + priorityFee : 0;
    const futureExitSlippage = value > 0 && impact !== null ? value * impact / 100 : 0;
    openEstimatedFees += remainingEntryFees + futureExitFees;
    openEstimatedCosts += remainingEntryCosts + futureExitFees + futureExitSlippage;
  }
  const accountEquity = Number(data.equity);
  if (Number.isFinite(accountEquity)) {
    data.grossEquity = accountEquity + realizedEstimatedCosts + openEstimatedCosts;
    data.totalEstimatedCosts = realizedEstimatedCosts + openEstimatedCosts;
    data.totalFeesUsd = [...costsByPosition.values()].reduce((sum, item) => sum + item.estimatedFeesUsd, 0) + openEstimatedFees;
    data.equity = accountEquity - openEstimatedCosts;
    data.totalPnl = data.equity - Number(data.startingBalance || 0);
    data.totalPnlPercent = Number(data.startingBalance) > 0
      ? data.totalPnl / Number(data.startingBalance) * 100
      : null;
  }
  data.costModel = {
    label: "Estimated paper execution costs",
    poolFeePercentPerSwap: 0.30,
    estimatedNetworkFeeUsdPerSwap: 0.01,
    estimatedPriorityFeeUsdPerSwap: 0.01,
    slippageMethod: "Approximate constant-product price impact using DexScreener liquidity",
    warning: "Estimates only; live routes and fills can differ."
  };
  return data;
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
      if (route === "/api/close-all-paper-positions") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        const results = [];
        async function closeAccount(label, account, controller) {
          const positions = account.positions || (account.position ? [account.position] : []);
          for (const position of positions) {
            const key = positionKey(position);
            try {
              let quote = null;
              try { quote = await getTokenData(position.tokenAddress, { pairAddress: position.pairAddress }); } catch (_) {}
              const price = Number(quote && quote.priceUsd) || 0;
              const liquidity = Number(quote && quote.liquidityUsd) || 0;
              const result = price > 0 && liquidity > 0
                ? controller.closePosition(key, price, liquidity, "MANUAL PAPER CLOSE")
                : controller.writeOffPosition(key, "MANUAL PAPER CLOSE · ZERO-RECOVERY WRITE-OFF");
              results.push({ ...result, bot: label, symbol: position.symbol, writeOff: !(price > 0 && liquidity > 0) });
            } catch (error) {
              results.push({ success: false, bot: label, symbol: position.symbol, message: error.message });
            }
          }
        }
        await closeAccount("New V3.1 Version", getPortfolio(), bot);
        await closeAccount("V3.1 BUY Priority Test", buyPriorityLock85.getPortfolio(), buyPriorityLock85);
        await closeAccount("Paper Launch Watcher", launchSniper.getPortfolio(), launchSniper);
        const sniperPositions = profitSniper.getPortfolio().positions || [];
        for (const position of sniperPositions) {
          try {
            const result = await profitSniper.closePosition(position.id);
            results.push({ ...result, bot: "Profit Sniper", symbol: position.symbol });
          } catch (error) {
            results.push({ success: false, bot: "Profit Sniper", symbol: position.symbol, message: error.message });
          }
        }
        const walletResult = await walletCopy.closeAllPositions();
        results.push(...walletResult.results.map(result => ({ ...result, bot: "Decu Wallet Follow" })));
        const outcomeResult = await outcomeBot.closeAll();
        results.push(...outcomeResult.results.map(result => ({ ...result, bot: "Coinbase Bot" })));
        const swarmResult = await swarm.closeAllPositions();
        results.push(...swarmResult.results.map(result => ({ ...result, bot: "Swarm" })));
        try {
          const remoteResponse = await fetch("https://pubx-fast-momentum-production.up.railway.app/api/close-all-paper-positions", {
            method: "POST", headers: { "x-bot-control": "1" }
          });
          const remoteResult = await remoteResponse.json();
          for (const result of remoteResult.results || []) results.push(result);
          if (!remoteResponse.ok && !(remoteResult.results || []).length) {
            results.push({ success: false, bot: "Bit V 3.1 40% TP1", message: remoteResult.error || "Remote paper close failed." });
          }
        } catch (error) {
          results.push({ success: false, bot: "Bit V 3.1 40% TP1", message: error.message });
        }
        const closedCount = results.filter(result => result.success).length;
        return json(res, { success: results.every(result => result.success), closedCount, results });
      }
      if (route === "/api/wallet-copy/webhook") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (!walletCopy.authenticateWebhook(req)) return json(res, { error: "Webhook authentication failed" }, 401);
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1000000) return json(res, { error: "Payload too large" }, 413);
        }
        let payload;
        try { payload = JSON.parse(body); }
        catch (_) { return json(res, { error: "Invalid JSON payload" }, 400); }
        await walletCopy.handleWebhookPayload(payload);
        return json(res, { ok: true });
      }
      if (!authorized(req, config)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Trading dashboard", charset="UTF-8"');
        return json(res, { error: "Authentication required" }, 401);
      }
      if (config.localOnly) {
        const hostname = new URL("http://" + req.headers.host).hostname;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return json(res, { error: "Invalid host" }, 403);
      }
      if (route === "/api/outcome/start" || route === "/api/outcome/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route.endsWith("/start")) outcomeBot.start(); else outcomeBot.stop();
        return json(res, outcomeBot.getStatus());
      }
      if (route === "/api/gemini/start" || route === "/api/gemini/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route.endsWith("/start")) geminiBot.start(); else geminiBot.stop();
        return json(res, { running: geminiBot.getStatus(), error: geminiBot.getLastError() });
      }
      if (route === "/api/start" || route === "/api/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/start") controls.startBot(); else controls.stopBot();
        return json(res, { running: controls.getBotStatus() });
      }
      if (route === "/api/profit-sniper/close-position") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        // This is the sole public control allowed without dashboard credentials:
        // it only closes a paper position. All bot start/stop controls remain read-only.
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        const positionId = new URL(req.url, "http://localhost").searchParams.get("positionId");
        const result = await profitSniper.closePosition(positionId);
        return json(res, result, result.success ? 200 : 409);
      }
      if (route === "/api/profit-sniper/start" || route === "/api/profit-sniper/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/profit-sniper/start") profitSniper.startBot(); else profitSniper.stopBot();
        return json(res, profitSniper.getStatus());
      }
      if (route === "/api/launch-sniper/start" || route === "/api/launch-sniper/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/launch-sniper/start") launchSniper.startBot(); else launchSniper.stopBot();
        return json(res, launchSniper.getStatus());
      }
      if (route === "/api/profit-sniper/status") return json(res, profitSniper.getStatus());
      if (route === "/api/profit-sniper/data") {
        const account = await buildDashboardData(profitSniper.getPortfolio(), marketData, { allowAlternatePairQuote: true });
        return json(res, { label: "Profit Sniper", paperOnly: true, account, status: profitSniper.getStatus(), thresholds: profitSniper.thresholds });
      }
      if (route === "/api/launch-sniper/status") return json(res, launchSniper.getStatus());
      if (route === "/api/launch-sniper/data") {
        const account = await buildDashboardData(launchSniper.getPortfolio(), marketData);
        return json(res, { label: "Paper Launch Watcher", paperOnly: true, account, thresholds: launchSniper.thresholds });
      }
      if (route === "/api/lock85/start" || route === "/api/lock85/stop") {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST" }, 405); }
        if (config.readOnly) return json(res, { error: "Public dashboard is view-only." }, 403);
        if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
        if (route === "/api/lock85/start") buyPriorityLock85.startBot(); else buyPriorityLock85.stopBot();
        return json(res, { running: buyPriorityLock85.getBotStatus() });
      }
      if (req.method !== "GET") return json(res, { error: "Method not allowed" }, 405);
      if (route === "/api/status") return json(res, { running: controls.getBotStatus(), error: controls.getLastError() });
      if (route === "/api/outcome/status") return json(res, outcomeBot.getStatus());
      if (route === "/api/lock85/status") return json(res, { running: buyPriorityLock85.getBotStatus(), error: buyPriorityLock85.getLastError(), mode: "paper", lockThresholdPercent: 60 });
      if (route === "/api/lock85/data") return json(res, { label: "V3.1 BUY Priority Test - 60% LP Lock", mode: "paper", lockThresholdPercent: 60, account: buyPriorityLock85.buildDashboardAccount() });
      if (route === "/api/swarm") return json(res, { running: swarm.getStatus(), error: swarm.getLastError(), ...swarm.getDashboardState() });
      if (route === "/api/data") {
        const baseAccount = portfolio();
        const lock85Account = buyPriorityLock85.buildDashboardAccount();
        const profitSniperAccount = profitSniper.getPortfolio();
        const walletCopyAccount = walletCopy.getPortfolio();
        const geminiState = geminiTrader.getState();
        const addresses = [...new Set([
          ...(baseAccount.positions || (baseAccount.position ? [baseAccount.position] : [])).map(p => p.tokenAddress),
          ...(lock85Account.positions || []).map(p => p.tokenAddress),
          ...(profitSniperAccount.positions || []).map(p => p.tokenAddress),
          ...(walletCopyAccount.positions || []).map(p => p.tokenAddress),
          ...(geminiState.position ? [geminiState.position.tokenAddress] : [])
        ].filter(Boolean))];
        const sharedQuotes = batchMarketData && addresses.length
          ? await batchMarketData(addresses)
          : null;
        const pairQuoteCache = new Map();
        const sharedMarketData = sharedQuotes
          ? async (address, options = {}) => {
              const pairAddress = options.pairAddress;
              if (!pairAddress) return sharedQuotes.get(address) || null;
              const key = address + "|" + pairAddress + "|" + (options.allowAlternatePairQuote ? "alternate" : "exact");
              if (!pairQuoteCache.has(key)) {
                pairQuoteCache.set(key, marketData(address, { pairAddress, allowAlternatePairQuote: options.allowAlternatePairQuote }));
              }
              return pairQuoteCache.get(key);
            }
          : marketData;
        const geminiData = await (async () => {
          let live = null;
          const position = geminiState.position;
          if (position) {
            const quote = await sharedMarketData(position.tokenAddress, { pairAddress: position.pairAddress || undefined });
            const priceUsd = Number(quote?.priceUsd);
            if (priceUsd > 0 && Number.isFinite(priceUsd)) {
              const currentValueUsd = position.quantity * priceUsd;
              live = { priceUsd, currentValueUsd, pnl: currentValueUsd - position.amountInvestedUsd,
                pnlPercent: position.amountInvestedUsd > 0 ? (currentValueUsd - position.amountInvestedUsd) / position.amountInvestedUsd * 100 : 0,
                holdTimeMs: Math.max(0, Date.now() - Date.parse(position.entryTime)), pairAddress: position.pairAddress };
            }
          }
          const geminiAnalytics = buildGeminiAnalytics(geminiState, live);
          const completedTrades = geminiAnalytics.completedTrades.map(t => ({
            ...t, pnl: t.pnlUsd, amountInvested: t.investedUsd, pnlPercent: t.returnPercent,
            exitPrice: t.averageExitPrice, holdTimeMs: t.holdTimeMs,
            exitReason: t.exitReasons.join(", ")
          }));
          const history = geminiState.history.map(row => ({
            ...row, pnl: row.pnlUsd, amountInvested: row.costBasisUsd || row.amountUsd,
            pnlPercent: row.pnlPercent, entryTime: row.entryTime || (row.type === "BUY" ? row.time : null),
            exitTime: row.type === "SELL" ? row.time : null
          }));
          return {
            strategy: "TP +20%: sell 100%; stop -8%; sizing 10% / 12.5% of available cash",
            takeProfitPercent: 20, stopLossPercent: -8, nextSizingPercent: geminiTrader.getSizing().percent,
            nextTradeSizeUsd: geminiTrader.getSizing().amountUsd,
            startingBalance: geminiState.startingBalanceUsd, cashBalance: geminiState.cashUsd,
            equity: geminiAnalytics.equityUsd, totalPnl: geminiAnalytics.totalPnlUsd,
            totalPnlPercent: geminiState.startingBalanceUsd > 0 ? geminiAnalytics.totalPnlUsd / geminiState.startingBalanceUsd * 100 : 0,
            completedTrades, history,
            livePositions: position ? [{ position, live, pnl: live?.pnl ?? null }] : [],
            running: geminiBot.getStatus(), lastScanAt: geminiState.lastScanAt
          };
        })();
        const [v31, candleBreakout, profitabilityLab, lock85, profitSniperData, walletCopyData] = await Promise.all([
          buildDashboardData(baseAccount, sharedMarketData),
          fetchCandleBreakoutDashboard(),
          fetchProfitabilityLabDashboard(),
          buildDashboardData(lock85Account, sharedMarketData),
          buildDashboardData(profitSniperAccount, sharedMarketData, { allowAlternatePairQuote: true }),
          buildDashboardData(walletCopyAccount, sharedMarketData)
        ]);
        return json(res, {
          v31,
          candleBreakout: candleBreakout.data,
          candleBreakoutStatus: candleBreakout.status,
          candleBreakoutError: candleBreakout.error,
          profitabilityLab: profitabilityLab.data,
          profitabilityLabError: profitabilityLab.error,
          buyPriorityLock85: lock85,
          buyPriorityLock85Status: { running: buyPriorityLock85.getBotStatus(), error: buyPriorityLock85.getLastError() },
          profitSniper: profitSniperData,
          profitSniperStatus: profitSniper.getStatus(),
          walletCopy: walletCopyData,
          walletCopyStatus: walletCopy.getStatus(),
          gemini: geminiData,
          geminiStatus: { running: geminiBot.getStatus(), error: geminiBot.getLastError() },
          outcomeBot: outcomeBot.getDashboardData(),
          outcomeBotStatus: outcomeBot.getStatus()
        });
      }
      if (route === "/trading/launch-sniper") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "launchSniperPanel.html"), "utf8")); }
      if (route === "/launchSniperPanel.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "launchSniperPanel.js"), "utf8")); }
      if (route === "/trading/buy-priority-lock85") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "buyPriorityLock85Panel.html"), "utf8")); }
      if (route === "/buyPriorityLock85Panel.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "buyPriorityLock85Panel.js"), "utf8")); }
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
  buyPriorityLock85.startBot();
  launchSniper.startBot();
  if (profitSniper.reconciliationReady) profitSniper.startBot();
  server.listen(config.port, config.host, () => {
    walletCopy.startBot();
    geminiBot.start();
    outcomeBot.start();
    console.log("Dashboard listening on " + config.host + ":" + config.port);
  });
  const shutdown = () => {
    swarm.stop();
    bot.stopBot();
    buyPriorityLock85.stopBot();
    launchSniper.stopBot();
    profitSniper.stopBot();
    walletCopy.stopBot();
    geminiBot.stop();
    outcomeBot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 12000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { createDashboardServer, getConfig, fetchCandleBreakoutDashboard };
