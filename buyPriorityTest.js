const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus, getTokenReport } = require("./lpLockChecker");
const telegram = require("./telegram");

const BOT_LABEL = "V3.1 BUY Priority Test";
const STRATEGY_VERSION = "v3.2-momentum";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const CONFIG = Object.freeze({
  capital: {
    startingUsd: 100,
    maxOpenPositions: 4,
    tradeFraction: 0.10,
    minimumTradeUsd: 10,
    maximumTradeUsd: 10,
    maximumLiquidityFraction: 0.01,
    pauseAtBalanceUsd: 70
  },
  entry: {
    minimumAgeMinutes: 30,
    maximumAgeHours: 24,
    minimumLiquidityUsd: 20000,
    minimumVolume1hUsd: 10000,
    maximumRise15mPercent: 100,
    momentumLookbackMinutes: 15,
    momentumObservationRetentionMinutes: 20,
    maximumTop10HolderPercent: 30,
    minimumSellQuotePercent: 90
  },
  exit: {
    stopLossPercent: 15,
    firstTargetPercent: 15,
    firstTargetOriginalPositionPercent: 30,
    secondTargetPercent: 25,
    secondTargetOriginalPositionPercent: 30,
    thirdTargetPercent: 60,
    thirdTargetOriginalPositionPercent: 20,
    trailingStopPercent: 20,
    profitStopCushionPercent: 3,
    timeStopMinutes: 15,
    minimumGainAtTimeStopPercent: 5,
    maximumHoldMinutes: 60,
    liquidityDropPercent: 30,
    stalePriceDataMs: 30000
  },
  estimatedCosts: {
    poolFeePercentPerSwap: 0.30,
    solanaFeeUsdPerSwap: 0.01,
    priorityFeeUsdPerSwap: 0.01
  }
});

function statePath(fileName) {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the BUY priority paper test.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), fileName);
}

function estimatedImpactPercent(tradeUsd, liquidityUsd) {
  const trade = Number(tradeUsd);
  const liquidity = Number(liquidityUsd);
  if (!(trade > 0) || !(liquidity > 0)) return null;
  const approximateUsdReserve = liquidity / 2;
  return trade / (approximateUsdReserve + trade) * 100;
}

function estimateExecutionCosts({ amountUsd, liquidityUsd, position } = {}) {
  const amount = Number(amountUsd);
  const liquidity = Number(liquidityUsd || position?.entryLiquidityUsd);
  const impactPercent = estimatedImpactPercent(amount, liquidity);
  if (!(amount > 0) || impactPercent === null) return null;
  const poolFeeUsd = amount * CONFIG.estimatedCosts.poolFeePercentPerSwap / 100;
  const solanaFeeUsd = CONFIG.estimatedCosts.solanaFeeUsdPerSwap;
  const priorityFeeUsd = CONFIG.estimatedCosts.priorityFeeUsdPerSwap;
  return {
    feesUsd: poolFeeUsd + solanaFeeUsd + priorityFeeUsd,
    slippageUsd: amount * impactPercent / 100,
    poolFeeUsd,
    solanaFeeUsd,
    priorityFeeUsd
  };
}

function getBuySizing(portfolio, coin = {}) {
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const realizedBalance = Number(portfolio.cashBalance || 0) +
    positions.reduce((sum, position) => sum + (Number(position.amountInvested) || 0), 0);
  const cash = Number(portfolio.cashBalance) || 0;
  const liquidityCap = Number(coin.liquidityUsd) * CONFIG.capital.maximumLiquidityFraction;
  const requested = Math.min(
    CONFIG.capital.maximumTradeUsd,
    Math.max(realizedBalance * CONFIG.capital.tradeFraction, CONFIG.capital.minimumTradeUsd)
  );
  const amountInvested = Math.min(requested, cash, liquidityCap);
  return {
    compoundRate: CONFIG.capital.tradeFraction,
    amountInvested: Number.isFinite(amountInvested) ? amountInvested : 0
  };
}

const trader = createPaperTrader(
  statePath("v31BuyPriorityTestTradingData.json"),
  fs,
  {
    strategyVersion: STRATEGY_VERSION,
    getBuySizing,
    maxOpenPositions: CONFIG.capital.maxOpenPositions,
    startingBalance: CONFIG.capital.startingUsd,
    estimateExecutionCosts
  }
);

const stageFile = statePath("v31BuyPriorityTestProfitStages.json");
const auditFile = statePath("v31BuyPriorityTestExitAudit.jsonl");
function readStages() {
  if (!fs.existsSync(stageFile)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(stageFile, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.stages || typeof parsed.stages !== "object" || Array.isArray(parsed.stages)) {
    throw new Error("Invalid v3.2-momentum profit-stage state; saved state was not reset.");
  }
  return new Map(Object.entries(parsed.stages).map(([id, value]) => [id, Number(value)]));
}
const profitStages = readStages();
function persistStages() {
  fs.mkdirSync(path.dirname(stageFile), { recursive: true });
  const temp = stageFile + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, stages: Object.fromEntries(profitStages) }, null, 2), { flag: "wx", flush: true });
    fs.renameSync(temp, stageFile);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function getPositionStage(position) {
  if (profitStages.has(position.id)) return Number(profitStages.get(position.id)) || 0;
  const rows = (trader.getPortfolio().history || []).filter(row => row.type === "SELL" && row.positionId === position.id);
  const completed = rows.filter(row => String(row.reason || "").startsWith("TAKE PROFIT +")).length;
  if (completed) return Math.min(3, completed);
  if (position.firstTakeProfitDone) return position.secondTakeProfitDone ? 3 : 1;
  return 0;
}

const recentPriceObservations = new Map();
async function checkEntryFilters(data, token) {
  const now = Date.now();
  const pairCreatedAt = Number(data.pairCreatedAt);
  const ageMinutes = Number.isFinite(pairCreatedAt) ? (now - pairCreatedAt) / 60000 : NaN;
  if (!Number.isFinite(ageMinutes) ||
      ageMinutes < CONFIG.entry.minimumAgeMinutes ||
      ageMinutes > CONFIG.entry.maximumAgeHours * 60) return false;

  const liquidity = Number(data.liquidityUsd);
  const volume1h = Number(data.volume1h);
  const buys1h = Number(data.buys1h);
  const sells1h = Number(data.sells1h);
  if (![liquidity, volume1h, buys1h, sells1h].every(Number.isFinite) ||
      liquidity < CONFIG.entry.minimumLiquidityUsd ||
      volume1h < CONFIG.entry.minimumVolume1hUsd ||
      buys1h <= sells1h) return false;

  const price = Number(data.priceUsd);
  const tokenAddress = token?.tokenAddress;
  if (!(price > 0) || !tokenAddress || !data.pairAddress) return false;
  let observations = recentPriceObservations.get(tokenAddress);
  if (!observations || observations.pairAddress !== data.pairAddress) {
    observations = { pairAddress: data.pairAddress, points: [] };
  }
  observations.points = observations.points.filter(point =>
    now - point.at <= CONFIG.entry.momentumObservationRetentionMinutes * 60000
  );
  observations.points.push({ at: now, price });
  const thresholdAt = now - CONFIG.entry.momentumLookbackMinutes * 60000;
  const before = observations.points.filter(point => point.at <= thresholdAt).sort((a, b) => b.at - a.at)[0];
  const after = observations.points.filter(point => point.at >= thresholdAt).sort((a, b) => a.at - b.at)[0];
  recentPriceObservations.set(tokenAddress, observations);
  if (!before || !after || after.at === before.at) return false;
  const baselinePrice = before.price + (after.price - before.price) *
    ((thresholdAt - before.at) / (after.at - before.at));
  const rise15m = (price - baselinePrice) / baselinePrice * 100;
  if (!Number.isFinite(rise15m) || rise15m > CONFIG.entry.maximumRise15mPercent) return false;
  data.priceChange15m = rise15m;

  const report = await getTokenReport(tokenAddress);
  if (!report || report.rugged !== false || !Array.isArray(report.risks) ||
      !report.token || !Array.isArray(report.topHolders)) return false;
  const revoked = value => value === null || value === false || value === "";
  if (!revoked(report.token.mintAuthority) || !revoked(report.token.freezeAuthority)) return false;
  const holders = report.topHolders.slice(0, 10);
  if (!holders.length || holders.some(holder => !Number.isFinite(Number(holder?.pct)))) return false;
  const top10Percent = holders.reduce((sum, holder) => sum + Number(holder.pct), 0);
  if (top10Percent >= CONFIG.entry.maximumTop10HolderPercent) return false;
  const unsafeRisk = report.risks.some(risk => {
    const name = String(risk?.name || "").toLowerCase();
    const level = String(risk?.level || "").toLowerCase();
    return ["danger", "critical"].includes(level) ||
      /honeypot|blacklist|freeze authority|mint authority|transfer fee|high tax/.test(name);
  });
  if (unsafeRisk) return false;
  data.top10HolderPercent = top10Percent;
  data.mintAuthorityRevoked = true;
  data.freezeAuthorityRevoked = true;
  data.rugCheckPassed = true;
  return true;
}

function getRecentStopLossGuards(portfolio, now = Date.now()) {
  const openIds = new Set((portfolio.positions || []).map(position => position.id));
  const entries = new Map();
  const sells = new Map();
  for (const row of Array.isArray(portfolio.history) ? portfolio.history : []) {
    if (!row?.positionId) continue;
    if (row.type === "BUY") entries.set(row.positionId, row);
    if (row.type === "SELL") {
      const rows = sells.get(row.positionId) || [];
      rows.push(row);
      sells.set(row.positionId, rows);
    }
  }
  const guards = new Map();
  for (const [positionId, rows] of sells) {
    if (openIds.has(positionId)) continue;
    const final = [...rows].reverse().find(row => Number(row.percentSold) === 100);
    if (!final || !String(final.reason || "").toUpperCase().includes("STOP LOSS")) continue;
    const closedAt = Date.parse(final.exitTime || final.timestamp || final.createdAt);
    if (!Number.isFinite(closedAt)) continue;
    const entry = entries.get(positionId);
    const initialAmount = Number(entry?.amountInvested) || 0;
    const netPnl = rows.reduce((sum, row) => sum + Number(row.netPnl ?? row.pnl ?? 0), 0);
    const lossPercent = initialAmount > 0 ? netPnl / initialAmount * 100 : 0;
    if (lossPercent < -25 || now - closedAt < 24 * 60 * 60 * 1000) {
      const prior = guards.get(final.tokenAddress);
      guards.set(final.tokenAddress, {
        permanent: lossPercent < -25 || Boolean(prior?.permanent),
        until: Math.max(Number(prior?.until) || 0, closedAt + 24 * 60 * 60 * 1000),
        lossPercent
      });
    }
  }
  return guards;
}

const decimalsCache = new Map();
async function getTokenDecimals(tokenAddress) {
  if (decimalsCache.has(tokenAddress)) return decimalsCache.get(tokenAddress);
  const rpcKey = process.env.HELIUS_API_KEY;
  if (!rpcKey) return null;
  const response = await fetch("https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(rpcKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "v32-momentum-token-decimals",
      method: "getTokenSupply",
      params: [tokenAddress]
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return null;
  const body = await response.json();
  const decimals = Number(body?.result?.value?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  decimalsCache.set(tokenAddress, decimals);
  return decimals;
}

let lastJupiterQuoteAt = 0;
let solUsdCache = { at: 0, price: null };
async function getSolUsdPrice() {
  if (solUsdCache.price > 0 && Date.now() - solUsdCache.at < 30000) return solUsdCache.price;
  const data = await market.getTokenData(SOL_MINT);
  const price = Number(data?.priceUsd);
  if (!(price > 0)) return null;
  solUsdCache = { at: Date.now(), price };
  return price;
}

async function getSellRouteQuote(tokenAddress, amountUsd, tokenPriceUsd) {
  try {
    const decimals = await getTokenDecimals(tokenAddress);
    if (!Number.isInteger(decimals)) return { allowed: false, reason: "TOKEN_DECIMALS_UNAVAILABLE" };
    const tokenQuantity = Number(amountUsd) / Number(tokenPriceUsd);
    const rawAmount = BigInt(Math.floor(tokenQuantity * (10 ** decimals))).toString();
    if (rawAmount === "0") return { allowed: false, reason: "QUOTE_AMOUNT_ROUNDS_TO_ZERO" };
    const waitMs = Math.max(0, 2100 - (Date.now() - lastJupiterQuoteAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastJupiterQuoteAt = Date.now();
    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", tokenAddress);
    url.searchParams.set("outputMint", SOL_MINT);
    url.searchParams.set("amount", rawAmount);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { allowed: false, reason: "JUPITER_HTTP_" + response.status };
    const quote = await response.json();
    const outputAmount = Number(quote?.outAmount);
    if (!(outputAmount > 0)) return { allowed: false, reason: "NO_SELL_ROUTE" };
    const solUsd = await getSolUsdPrice();
    if (!(solUsd > 0)) return { allowed: false, reason: "SOL_USD_PRICE_UNAVAILABLE" };
    const quotedUsd = outputAmount / 1e9 * solUsd;
    const returnPercent = quotedUsd / Number(amountUsd) * 100;
    return {
      allowed: Number.isFinite(returnPercent) && returnPercent >= CONFIG.entry.minimumSellQuotePercent,
      reason: returnPercent >= CONFIG.entry.minimumSellQuotePercent ? "SELL_ROUTE_CONFIRMED" : "SELL_QUOTE_BELOW_90_PERCENT",
      returnPercent,
      quotedUsd,
      router: quote.router || null
    };
  } catch (error) {
    return { allowed: false, reason: "SELL_QUOTE_ERROR: " + error.message };
  }
}

async function discoverBuyPriorityCandidates(options = {}) {
  const candidates = await scanner.discoverCandidates({
    ...options,
    minimumLiquidityUsd: CONFIG.entry.minimumLiquidityUsd,
    minimumVolume24hUsd: 0,
    candidateFilter: checkEntryFilters,
    analyzeCandidate: () => ({ score: 1, signal: "BUY", reasons: [STRATEGY_VERSION + " filters passed"] })
  });
  const portfolio = trader.getPortfolio();
  const guards = getRecentStopLossGuards(portfolio);
  const openAddresses = new Set((portfolio.positions || []).map(position => position.tokenAddress));
  const currentGuards = [];
  for (const candidate of candidates) {
    const guard = guards.get(candidate.tokenAddress);
    if (guard && (guard.permanent || guard.until > Date.now())) {
      console.log("REENTRY BLOCK | " + candidate.symbol + " | " +
        (guard.permanent ? "permanent ban after loss over 25%" : "24-hour stop-loss cooldown"));
      continue;
    }
    if (openAddresses.has(candidate.tokenAddress)) continue;
    const sizing = getBuySizing(portfolio, candidate);
    if (sizing.amountInvested < CONFIG.capital.minimumTradeUsd) continue;
    const quote = await getSellRouteQuote(candidate.tokenAddress, sizing.amountInvested, candidate.priceUsd);
    if (!quote.allowed) {
      console.log("SELL ROUTE GATE | " + candidate.symbol + " | skipped | " + quote.reason);
      continue;
    }
    currentGuards.push({
      ...candidate,
      reasons: [...(Array.isArray(candidate.reasons) ? candidate.reasons : []), STRATEGY_VERSION + " sell route passed"],
      experimentEntry: {
        strategy: STRATEGY_VERSION,
        compoundRatePercent: sizing.compoundRate * 100,
        entryMetrics: {
          pairAgeMinutes: Math.max(0, (Date.now() - Number(candidate.pairCreatedAt)) / 60000),
          liquidityUsd: Number(candidate.liquidityUsd),
          volume5mUsd: Number(candidate.volume5m) || 0,
          volume1hUsd: Number(candidate.volume1h) || 0,
          priceChange5mPercent: Number(candidate.priceChange5m) || 0,
          priceChange1hPercent: Number(candidate.priceChange1h) || 0,
          buys5m: Number(candidate.buys5m) || 0,
          sells5m: Number(candidate.sells5m) || 0,
          buys1h: Number(candidate.buys1h) || 0,
          sells1h: Number(candidate.sells1h) || 0,
          sellQuoteReturnPercent: Number(quote.returnPercent.toFixed(2)),
          sellQuoteRouter: quote.router
        },
        estimatedCostModel: {
          label: "Estimated paper execution costs",
          tradeSizeUsd: Number(sizing.amountInvested.toFixed(2)),
          entryLiquidityUsd: Number(candidate.liquidityUsd),
          estimatedEntryImpactPercent: estimatedImpactPercent(sizing.amountInvested, candidate.liquidityUsd),
          assumedPoolFeePercentPerSwap: CONFIG.estimatedCosts.poolFeePercentPerSwap,
          estimatedSolanaNetworkFeeUsdPerSwap: CONFIG.estimatedCosts.solanaFeeUsdPerSwap,
          estimatedPriorityFeeUsdPerSwap: CONFIG.estimatedCosts.priorityFeeUsdPerSwap
        }
      }
    });
  }
  return currentGuards;
}

const lastMarketData = new Map();
const staleRiskLogAt = new Map();
async function getPositionMarketData(tokenAddress, options = {}) {
  let data = null;
  try {
    data = await market.getTokenData(tokenAddress, options);
  } catch (_) {
    data = null;
  }
  if (data && Number(data.priceUsd) > 0) {
    const observedAt = Date.now();
    const previous = lastMarketData.get(tokenAddress);
    if (previous && previous.data.pairAddress && data.pairAddress !== previous.data.pairAddress) {
      data = { ...data, _pairChangedFrom: previous.data.pairAddress };
    }
    const value = { data: { ...data }, observedAt };
    lastMarketData.set(tokenAddress, value);
    return { ...value.data, _observedAtMs: observedAt, _priceDataAgeMs: 0 };
  }
  const previous = lastMarketData.get(tokenAddress);
  if (!previous) return null;
  return {
    ...previous.data,
    _observedAtMs: previous.observedAt,
    _priceDataAgeMs: Date.now() - previous.observedAt
  };
}

function appendExitAudit(trade, ageMs, reason) {
  const record = {
    strategyVersion: STRATEGY_VERSION,
    botLabel: BOT_LABEL,
    positionId: trade.positionId,
    tokenAddress: trade.tokenAddress,
    exitPriceActuallyUsed: trade.exitPrice,
    priceDataAgeMsAtExit: Number.isFinite(ageMs) ? ageMs : null,
    reason,
    estimatedFeesUsd: Number(trade.estimatedFeesUsd) || 0,
    estimatedSlippageUsd: Number(trade.estimatedSlippageUsd) || 0,
    pnl: Number(trade.pnl) || 0,
    exitTime: trade.exitTime
  };
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.appendFileSync(auditFile, JSON.stringify(record) + "\n", "utf8");
}

let currentExitContext = null;
const targetTrader = {
  buy: trader.buy,
  getPortfolio: trader.getPortfolio,
  updateHigh: trader.updateHigh,
  positionKey: trader.positionKey,
  sell: (...args) => {
    const result = trader.sell(...args);
    if (!result?.success) return result;
    const trade = result.trade;
    const reason = String(trade.reason || args[2]?.reason || "");
    const stage = Number(profitStages.get(trade.positionId)) || 0;
    if (reason.startsWith("TAKE PROFIT +")) {
      profitStages.set(trade.positionId, stage + 1);
      persistStages();
    } else if (Number(args[1] ?? 100) === 100) {
      profitStages.delete(trade.positionId);
      persistStages();
    }
    try {
      appendExitAudit(trade, currentExitContext?.ageMs, reason);
    } catch (error) {
      console.error("EXIT AUDIT WRITE FAILED | " + error.message);
    }
    console.log("EXIT TRADE AUDIT | " + JSON.stringify({
      strategyVersion: STRATEGY_VERSION,
      positionId: trade.positionId,
      exitPriceActuallyUsed: trade.exitPrice,
      priceDataAgeMsAtExit: Number.isFinite(currentExitContext?.ageMs) ? currentExitContext.ageMs : null,
      reason,
      estimatedFeesUsd: trade.estimatedFeesUsd,
      estimatedSlippageUsd: trade.estimatedSlippageUsd
    }));
    return result;
  }
};

function getPoolLiquidity(position, freshData) {
  if (freshData._pairChangedFrom && freshData._pairChangedFrom === position.pairAddress) {
    return { mismatch: true, liquidityUsd: 0 };
  }
  if (position.pairAddress && freshData.pairAddress !== position.pairAddress) {
    return { mismatch: true, liquidityUsd: 0 };
  }
  return { mismatch: false, liquidityUsd: Number(freshData.liquidityUsd) };
}

function evaluateExit({ position, freshData, currentPrice, now = Date.now() }) {
  const ageMs = Math.max(0, Number(freshData?._priceDataAgeMs) || 0);
  const lastLogAt = staleRiskLogAt.get(position.id) || 0;
  if (ageMs > CONFIG.exit.stalePriceDataMs) {
    if (now - lastLogAt >= CONFIG.exit.stalePriceDataMs) {
      console.error("STALE PRICE RISK | " + position.symbol + " | price data age " + Math.round(ageMs) + "ms; exits held until fresh price returns");
      staleRiskLogAt.set(position.id, now);
    }
    return null;
  }
  staleRiskLogAt.delete(position.id);
  const pool = getPoolLiquidity(position, freshData);
  if (pool.mismatch) {
    return { reason: "liquidity_drop", percent: 100 };
  }
  const entryLiquidity = Number(position.entryLiquidityUsd);
  if (entryLiquidity > 0 && Number.isFinite(pool.liquidityUsd) &&
      pool.liquidityUsd < entryLiquidity * (1 - CONFIG.exit.liquidityDropPercent / 100)) {
    return { reason: "liquidity_drop", percent: 100 };
  }

  const entry = Number(position.entryPrice);
  const high = Number(position.highestPrice || entry);
  const profitPercent = (currentPrice - entry) / entry * 100;
  const highProfitPercent = (high - entry) / entry * 100;
  const holdMinutes = Math.max(0, (now - new Date(position.entryTime).getTime()) / 60000);
  const dropFromHigh = high > 0 ? (high - currentPrice) / high * 100 : 0;
  const stage = getPositionStage(position);

  if (profitPercent <= -CONFIG.exit.stopLossPercent) {
    return { reason: "STOP LOSS -" + CONFIG.exit.stopLossPercent + "%", percent: 100 };
  }
  if (stage >= 1 && profitPercent <= CONFIG.exit.profitStopCushionPercent) {
    return { reason: "PROFIT STOP ENTRY +" + CONFIG.exit.profitStopCushionPercent + "%", percent: 100 };
  }
  if (holdMinutes >= CONFIG.exit.maximumHoldMinutes) {
    return { reason: "MAX HOLD 60M", percent: 100 };
  }
  if (holdMinutes >= CONFIG.exit.timeStopMinutes &&
      highProfitPercent < CONFIG.exit.minimumGainAtTimeStopPercent) {
    return { reason: "TIME STOP 15M", percent: 100 };
  }
  if (stage >= 3 && dropFromHigh >= CONFIG.exit.trailingStopPercent) {
    return { reason: "TRAILING STOP -" + CONFIG.exit.trailingStopPercent + "%", percent: 100 };
  }
  if (stage === 0 && profitPercent >= CONFIG.exit.firstTargetPercent) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.firstTargetPercent + "% SELL 30% ORIGINAL",
      percent: CONFIG.exit.firstTargetOriginalPositionPercent
    };
  }
  if (stage === 1 && profitPercent >= CONFIG.exit.secondTargetPercent) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.secondTargetPercent + "% SELL 30% ORIGINAL",
      percent: CONFIG.exit.secondTargetOriginalPositionPercent / 70 * 100
    };
  }
  if (stage === 2 && profitPercent >= CONFIG.exit.thirdTargetPercent) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.thirdTargetPercent + "% SELL 20% ORIGINAL",
      percent: 50
    };
  }
  return null;
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: message => telegram.notifyCritical(message)
};

const bot = createBot({
  trader: targetTrader,
  getTokenData: getPositionMarketData,
  discoverCandidates: discoverBuyPriorityCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  botLabel: BOT_LABEL + " | " + STRATEGY_VERSION,
  reentryStateFile: statePath("v31BuyPriorityTestReentryState.json"),
  maxOpenPositions: CONFIG.capital.maxOpenPositions,
  requireLiquidityLock: false,
  useReentryGuards: false,
  exitDecision: args => {
    currentExitContext = {
      ageMs: Number(args.freshData?._priceDataAgeMs) || 0,
      pairAddress: args.freshData?.pairAddress
    };
    return evaluateExit(args);
  },
  pauseEntriesAtBalance: CONFIG.capital.pauseAtBalanceUsd,
  entryPauseStateFile: statePath("v31BuyPriorityTestEntryPause.json")
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount,
  evaluateExit,
  getBuySizing,
  getRecentStopLossGuards
};

function buildDashboardAccount() {
  const account = trader.getPortfolio();
  const history = Array.isArray(account.history) ? account.history.map(row => {
    if (row.type !== "SELL") return row;
    return {
      ...row,
      grossPnl: Number(row.grossPnl ?? row.pnl ?? 0),
      netPnl: Number(row.netPnl ?? row.pnl ?? 0),
      estimatedFeesUsd: Number(row.estimatedFeesUsd || 0),
      estimatedSlippageUsd: Number(row.estimatedSlippageUsd || 0),
      estimatedCostUsd: Number(row.estimatedCostUsd || 0),
      costEstimateAvailable: true
    };
  }) : [];
  return {
    ...account,
    label: BOT_LABEL,
    strategyVersion: STRATEGY_VERSION,
    history,
    positions: account.positions || [],
    position: (account.positions || [])[0] || null,
    completedTrades: [],
    stats: null,
    running: bot.getBotStatus(),
    entriesPaused: bot.getEntriesPaused(),
    costModel: {
      label: "Estimated paper execution costs",
      poolFeePercentPerSwap: CONFIG.estimatedCosts.poolFeePercentPerSwap,
      solanaFeeUsdPerSwap: CONFIG.estimatedCosts.solanaFeeUsdPerSwap,
      priorityFeeUsdPerSwap: CONFIG.estimatedCosts.priorityFeeUsdPerSwap,
      slippageMethod: "Approximate constant-product impact using DexScreener liquidity",
      warning: "All costs are estimates; real swap routes, fees, priority fees and fills can differ."
    }
  };
}
