const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus, getTokenReport } = require("./lpLockChecker");
const telegram = require("./telegram");

const BOT_LABEL = "New Claude Exit Test";
const CONFIG = Object.freeze({
  capital: {
    startingUsd: 100,
    maxOpenPositions: 4,
    tradeFraction: 0.10,
    minimumTradeUsd: 10,
    maximumLiquidityFraction: 0.01,
    pauseAtBalanceUsd: null
  },
  entry: {
    minimumAgeMinutes: 10,
    maximumAgeHours: 24,
    minimumLiquidityUsd: 15000,
    minimumVolume1hUsd: 5000,
    maximumRise15mPercent: 100,
    momentumLookbackMinutes: 5,
    momentumObservationRetentionMinutes: 10,
    maximumTop10HolderPercent: 30
  },
  exit: {
    stopLossPercent: 15,
    breakevenTriggerPercent: 15,
    firstTargetPercent: 25,
    firstTargetOriginalPositionPercent: 20,
    secondTargetPercent: 60,
    secondTargetOriginalPositionPercent: 20,
    trailingStopPercent: 12,
    timeStopMinutes: 15,
    minimumGainAtTimeStopPercent: 5
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

function nextCompoundRate() {
  return CONFIG.capital.tradeFraction;
}

function getBuySizing(portfolio, coin = {}) {
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const realizedBalance = Number(portfolio.cashBalance || 0) +
    positions.reduce((sum, position) => sum + (Number(position.amountInvested) || 0), 0);
  const cash = Number(portfolio.cashBalance) || 0;
  const liquidityCap = Number(coin.liquidityUsd) * CONFIG.capital.maximumLiquidityFraction;
  const requested = Math.max(realizedBalance * nextCompoundRate(), CONFIG.capital.minimumTradeUsd);
  const amountInvested = Math.min(requested, cash, liquidityCap);
  return {
    compoundRate: nextCompoundRate(),
    amountInvested: Number.isFinite(amountInvested) ? amountInvested : 0
  };
}

const trader = createPaperTrader(
  statePath("v31BuyPriorityExitTestTradingData.json"),
  fs,
  {
    strategyVersion: "New-Claude-Exit-Test-Paper",
    getBuySizing,
    maxOpenPositions: CONFIG.capital.maxOpenPositions,
    startingBalance: CONFIG.capital.startingUsd,
    estimateExecutionCosts
  }
);

const recentPriceObservations = new Map();
async function checkEntryFilters(data, token, stats) {
  const reject = reason => {
    if (stats) stats[reason] = (stats[reason] || 0) + 1;
    return false;
  };
  if (stats) stats.checked = (stats.checked || 0) + 1;
  const now = Date.now();
  const pairCreatedAt = Number(data.pairCreatedAt);
  const ageMinutes = Number.isFinite(pairCreatedAt) ? (now - pairCreatedAt) / 60000 : NaN;
  if (!Number.isFinite(ageMinutes) ||
      ageMinutes < CONFIG.entry.minimumAgeMinutes ||
      ageMinutes > CONFIG.entry.maximumAgeHours * 60) return reject("age");

  const liquidity = Number(data.liquidityUsd);
  const volume1h = Number(data.volume1h);
  const buys1h = Number(data.buys1h);
  const sells1h = Number(data.sells1h);
  if (![liquidity, volume1h, buys1h, sells1h].every(Number.isFinite)) return reject("missing_market_data");
  if (liquidity < CONFIG.entry.minimumLiquidityUsd) return reject("liquidity");
  if (volume1h < CONFIG.entry.minimumVolume1hUsd) return reject("volume_1h");
  if (buys1h <= sells1h) return reject("sell_pressure");

  const price = Number(data.priceUsd);
  const tokenAddress = token?.tokenAddress;
  if (!(price > 0) || !tokenAddress || !data.pairAddress) return reject("missing_price_or_pair");
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
  if (!before || !after || after.at === before.at) return reject("momentum_observations_pending");
  const baselinePrice = before.price + (after.price - before.price) *
    ((thresholdAt - before.at) / (after.at - before.at));
  const rise15m = (price - baselinePrice) / baselinePrice * 100;
  if (!Number.isFinite(rise15m)) return reject("momentum_unavailable");
  if (rise15m > CONFIG.entry.maximumRise15mPercent) return reject("late_spike");
  data.priceChange15m = rise15m;

  const report = await getTokenReport(tokenAddress);
  if (!report || report.rugged !== false || !Array.isArray(report.risks) ||
      !report.token || !Array.isArray(report.topHolders)) return reject("rugcheck_report_unavailable_or_incomplete");
  const revoked = value => value === null || value === false || value === "";
  if (!revoked(report.token.mintAuthority) || !revoked(report.token.freezeAuthority)) return reject("authority_active");
  const holders = report.topHolders.slice(0, 10);
  if (!holders.length || holders.some(holder => !Number.isFinite(Number(holder?.pct)))) return reject("holder_data_unavailable");
  const top10Percent = holders.reduce((sum, holder) => sum + Number(holder.pct), 0);
  if (top10Percent >= CONFIG.entry.maximumTop10HolderPercent) return reject("top_holder_concentration");
  const unsafeRisk = report.risks.some(risk => {
    const name = String(risk?.name || "").toLowerCase();
    const level = String(risk?.level || "").toLowerCase();
    return ["danger", "critical"].includes(level) ||
      /honeypot|blacklist|freeze authority|mint authority|transfer fee|high tax/.test(name);
  });
  if (unsafeRisk) return reject("rugcheck_risk");
  data.top10HolderPercent = top10Percent;
  data.mintAuthorityRevoked = true;
  data.freezeAuthorityRevoked = true;
  data.rugCheckPassed = true;
  if (stats) stats.passed = (stats.passed || 0) + 1;
  return true;
}
async function discoverBuyPriorityCandidates(options = {}) {
  const filterStats = {};
  const candidates = await scanner.discoverCandidates({
    ...options,
    minimumLiquidityUsd: CONFIG.entry.minimumLiquidityUsd,
    minimumVolume24hUsd: 0,
    candidateFilter: (data, token) => checkEntryFilters(data, token, filterStats),
    analyzeCandidate: () => ({ score: 1, signal: "BUY", reasons: ["All configured New Claude Exit Test filters passed"] })
  });
  console.log("NEW CLAUDE FILTER SUMMARY | " + JSON.stringify(filterStats));
  const portfolio = trader.getPortfolio();
  return candidates.map(candidate => {
    const sizing = getBuySizing(portfolio, candidate);
    return {
      ...candidate,
      reasons: [...(Array.isArray(candidate.reasons) ? candidate.reasons : []), "New Claude Exit Test filters passed"],
      experimentEntry: {
        strategy: "New Claude Exit Test",
        compoundRatePercent: sizing.compoundRate * 100,
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
    };
  });
}

function evaluateExit({ position, currentPrice, now = Date.now() }) {
  const entry = Number(position.entryPrice);
  const high = Number(position.highestPrice || entry);
  const profitPercent = (currentPrice - entry) / entry * 100;
  const highProfitPercent = (high - entry) / entry * 100;
  const holdMinutes = Math.max(0, (now - new Date(position.entryTime).getTime()) / 60000);
  const dropFromHigh = high > 0 ? (high - currentPrice) / high * 100 : 0;

  if (position.secondTakeProfitDone && dropFromHigh >= CONFIG.exit.trailingStopPercent) {
    return { reason: "TRAILING STOP " + CONFIG.exit.trailingStopPercent + "%", percent: 100 };
  }
  if (!position.secondTakeProfitDone &&
      highProfitPercent >= CONFIG.exit.breakevenTriggerPercent &&
      profitPercent <= 0) {
    return { reason: "BREAKEVEN STOP", percent: 100 };
  }
  if (profitPercent <= -CONFIG.exit.stopLossPercent) {
    return { reason: "STOP LOSS -" + CONFIG.exit.stopLossPercent + "%", percent: 100 };
  }
  if (holdMinutes >= CONFIG.exit.timeStopMinutes &&
      highProfitPercent < CONFIG.exit.minimumGainAtTimeStopPercent) {
    return { reason: "TIME STOP 15M", percent: 100 };
  }
  if (profitPercent >= CONFIG.exit.firstTargetPercent && !position.firstTakeProfitDone) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.firstTargetPercent + "% SELL " + CONFIG.exit.firstTargetOriginalPositionPercent + "%",
      percent: CONFIG.exit.firstTargetOriginalPositionPercent,
      takeProfit: "firstTakeProfitDone"
    };
  }
  if (profitPercent >= CONFIG.exit.secondTargetPercent &&
      position.firstTakeProfitDone && !position.secondTakeProfitDone) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.secondTargetPercent + "% SELL " + CONFIG.exit.secondTargetOriginalPositionPercent + "%",
      percent: CONFIG.exit.secondTargetOriginalPositionPercent /
        (100 - CONFIG.exit.firstTargetOriginalPositionPercent) * 100,
      takeProfit: "secondTakeProfitDone"
    };
  }
  return null;
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: message => telegram.notifyCritical(message)
};

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  getTokensData: market.getTokensData,
  batchPositionPrices: true,
  positionMonitorMs: 1500,
  discoverCandidates: discoverBuyPriorityCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  botLabel: BOT_LABEL,
  reentryStateFile: statePath("v31BuyPriorityExitTestReentryState.json"),
  maxOpenPositions: CONFIG.capital.maxOpenPositions,
  acceptedSignals: ["BUY", "STRONG BUY"],
  requireLiquidityLock: false,
  useReentryGuards: false,
  exitDecision: evaluateExit,
  pauseEntriesAtBalance: null,
  entryPauseStateFile: null
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount,
  exitTestConfig: CONFIG,
  evaluateExit
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
