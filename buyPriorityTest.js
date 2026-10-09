const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus, getTokenReport } = require("./lpLockChecker");
const telegram = require("./telegram");

const BOT_LABEL = "New Claude Strategy";
const CONFIG = Object.freeze({
  capital: {
    startingUsd: 100,
    maxOpenPositions: 4,
    tradeFraction: 0.10,
    minimumTradeUsd: 10,
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
    maximumTop10HolderPercent: 30
  },
  exit: {
    stopLossPercent: 15,
    breakevenTriggerPercent: 15,
    firstTargetPercent: 25,
    firstTargetOriginalPositionPercent: 40,
    secondTargetPercent: 60,
    secondTargetOriginalPositionPercent: 30,
    trailingStopPercent: 20,
    timeStopMinutes: 15,
    minimumGainAtTimeStopPercent: 5
  },
  estimatedCosts: {
    poolFeePercentPerSwap: 0.30,
    solanaFeeUsdPerSwap: 0.01,
    priorityFeeUsdPerSwap: 0.01
  }
});
const PROFIT_LOCK_TRIGGER_NET_PERCENT = 10;
const PROFIT_LOCK_FLOOR_NET_PERCENT = 3;
const LIQUIDITY_DROP_PERCENT = 35;
const LIQUIDITY_DROP_CONFIRMATIONS = 2;
const MIGRATION_GRACE_MS = 20000;
const PUMP_SWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const migrationMetadataCache = new Map();
const migrationMetadataPending = new Map();
const monitoredLiquidity = new Map();

async function loadMigrationMetadata(tokenAddress, signal) {
  const now = Date.now();
  const cached = migrationMetadataCache.get(tokenAddress);
  if (cached && now - cached.at < 15000) return cached.value;
  if (migrationMetadataPending.has(tokenAddress)) return migrationMetadataPending.get(tokenAddress);

  const request = (async () => {
    let pairs = [];
    let pumpCoin = null;
    try {
      const [pairsResult, pumpResult] = await Promise.allSettled([
        axios.get("https://api.dexscreener.com/token-pairs/v1/solana/" + encodeURIComponent(tokenAddress), { timeout: 8000, signal }),
        axios.get("https://frontend-api-v3.pump.fun/coins-v2/" + encodeURIComponent(tokenAddress), { timeout: 8000, signal })
      ]);
      if (pairsResult.status === "fulfilled" && Array.isArray(pairsResult.value?.data)) {
        pairs = pairsResult.value.data;
      }
      if (pumpResult.status === "fulfilled" && pumpResult.value?.data && typeof pumpResult.value.data === "object") {
        pumpCoin = pumpResult.value.data;
      }
    } catch (_) {}

    let canonicalPair = null;
    const pumpSwapPoolAddress = typeof pumpCoin?.pump_swap_pool === "string" ? pumpCoin.pump_swap_pool : null;
    if (pumpCoin?.complete === true && pumpSwapPoolAddress) {
      canonicalPair = pairs.find(pair =>
        String(pair?.chainId || "").toLowerCase() === "solana" &&
        String(pair?.dexId || "").toLowerCase() === "pumpswap" &&
        String(pair?.pairAddress || "").toLowerCase() === pumpSwapPoolAddress.toLowerCase() &&
        String(pair?.baseToken?.address || "").toLowerCase() === tokenAddress.toLowerCase()
      ) || null;
    }

    let verifiedPumpMigration = false;
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (canonicalPair && heliusApiKey) {
      try {
        const response = await axios.post(
          "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(heliusApiKey),
          {
            jsonrpc: "2.0",
            id: "new-claude-migration-check",
            method: "getAccountInfo",
            params: [pumpSwapPoolAddress, { encoding: "base64" }]
          },
          { timeout: 8000, signal }
        );
        verifiedPumpMigration = response?.data?.result?.value?.owner === PUMP_SWAP_PROGRAM_ID;
      } catch (_) {}
    }

    return { pairs, canonicalPair, pumpSwapPoolAddress, verifiedPumpMigration };
  })().finally(() => migrationMetadataPending.delete(tokenAddress));

  migrationMetadataPending.set(tokenAddress, request);
  const value = await request;
  migrationMetadataCache.set(tokenAddress, { at: Date.now(), value });
  return value;
}

function pairToTokenData(pair, fallback = {}) {
  if (!pair) return fallback;
  return {
    ...fallback,
    priceUsd: pair.priceUsd ?? fallback.priceUsd,
    liquidityUsd: pair.liquidity?.usd ?? fallback.liquidityUsd,
    volume5m: pair.volume?.m5 ?? fallback.volume5m,
    volume1h: pair.volume?.h1 ?? fallback.volume1h,
    volume24h: pair.volume?.h24 ?? fallback.volume24h,
    priceChange5m: pair.priceChange?.m5 ?? fallback.priceChange5m,
    priceChange1h: pair.priceChange?.h1 ?? fallback.priceChange1h,
    priceChange24h: pair.priceChange?.h24 ?? fallback.priceChange24h,
    pairCreatedAt: pair.pairCreatedAt ?? fallback.pairCreatedAt,
    buys1h: pair.txns?.h1?.buys ?? fallback.buys1h,
    sells1h: pair.txns?.h1?.sells ?? fallback.sells1h,
    buys5m: pair.txns?.m5?.buys ?? fallback.buys5m,
    sells5m: pair.txns?.m5?.sells ?? fallback.sells5m,
    pairAddress: pair.pairAddress ?? fallback.pairAddress,
    dexId: pair.dexId ?? fallback.dexId
  };
}

async function getPositionTokenData(tokenAddress, options = {}) {
  const baseData = await market.getTokenData(tokenAddress, options);
  const metadata = await loadMigrationMetadata(tokenAddress, options.signal);
  const basePairAddress = String(baseData?.pairAddress || "").toLowerCase();
  const matchingBasePair = metadata.pairs.find(pair =>
    String(pair?.pairAddress || "").toLowerCase() === basePairAddress
  ) || null;
  const selectedPair = metadata.verifiedPumpMigration
    ? metadata.canonicalPair
    : (matchingBasePair || metadata.pairs.sort((a, b) =>
      (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0)
    )[0] || null);
  const data = pairToTokenData(selectedPair, baseData || {});
  if (!data || !data.priceUsd) return null;
  return {
    ...data,
    verifiedPumpMigration: metadata.verifiedPumpMigration,
    pumpSwapPoolAddress: metadata.pumpSwapPoolAddress
  };
}

function evaluateLiquidityProtection(position, freshData, now) {
  const liquidityUsd = Number(freshData?.liquidityUsd);
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) return null;
  const currentPair = String(freshData?.pairAddress || "");
  const key = String(position.id || position.tokenAddress);
  let state = monitoredLiquidity.get(key);
  if (!state) {
    state = {
      pairAddress: String(position.pairAddress || currentPair),
      peakLiquidityUsd: Math.max(0, Number(position.entryLiquidityUsd) || liquidityUsd),
      dropObservations: 0,
      graceUntil: 0
    };
  }

  if (currentPair && state.pairAddress && currentPair.toLowerCase() !== state.pairAddress.toLowerCase()) {
    const verifiedCanonicalMigration =
      freshData.verifiedPumpMigration === true &&
      String(freshData.pumpSwapPoolAddress || "").toLowerCase() === currentPair.toLowerCase();
    if (!verifiedCanonicalMigration) return null;
    state = {
      pairAddress: currentPair,
      peakLiquidityUsd: liquidityUsd,
      dropObservations: 0,
      graceUntil: now + MIGRATION_GRACE_MS
    };
    monitoredLiquidity.set(key, state);
    console.log("MIGRATION VERIFIED | " + position.symbol + " | canonical PumpSwap pool; liquidity baseline reset");
    return null;
  }

  state.pairAddress = currentPair || state.pairAddress;
  if (now < state.graceUntil) {
    monitoredLiquidity.set(key, state);
    return null;
  }
  state.peakLiquidityUsd = Math.max(state.peakLiquidityUsd, liquidityUsd);
  const drawdown = state.peakLiquidityUsd > 0
    ? (state.peakLiquidityUsd - liquidityUsd) / state.peakLiquidityUsd * 100
    : 0;
  state.dropObservations = drawdown >= LIQUIDITY_DROP_PERCENT ? state.dropObservations + 1 : 0;
  monitoredLiquidity.set(key, state);

  if (liquidityUsd === 0 || state.dropObservations >= LIQUIDITY_DROP_CONFIRMATIONS) {
    return { reason: "LIQUIDITY DROP " + LIQUIDITY_DROP_PERCENT + "%", percent: 100 };
  }
  return null;
}

function estimateNetProfitPercent(position, currentPrice, liquidityUsd) {
  const basis = Number(position.amountInvested);
  const quantity = Number(position.quantity);
  if (!(basis > 0) || !(quantity > 0) || !(currentPrice > 0)) return null;
  const saleValue = quantity * currentPrice;
  const costs = estimateExecutionCosts({ amountUsd: saleValue, liquidityUsd, position });
  if (!costs) return null;
  const entryCosts = position.remainingEntryCosts || {};
  const totalCosts = (Number(entryCosts.feesUsd) || 0) +
    (Number(entryCosts.slippageUsd) || 0) +
    (Number(costs.feesUsd) || 0) +
    (Number(costs.slippageUsd) || 0);
  return (saleValue - basis - totalCosts) / basis * 100;
}


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
  statePath("v31BuyPriorityTestTradingData.json"),
  fs,
  {
    strategyVersion: "New-Claude-Strategy-Paper",
    getBuySizing,
    maxOpenPositions: CONFIG.capital.maxOpenPositions,
    startingBalance: CONFIG.capital.startingUsd,
    estimateExecutionCosts
  }
);

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

async function discoverBuyPriorityCandidates(options = {}) {
  const candidates = await scanner.discoverCandidates({
    ...options,
    minimumLiquidityUsd: CONFIG.entry.minimumLiquidityUsd,
    minimumVolume24hUsd: 0,
    candidateFilter: checkEntryFilters,
    analyzeCandidate: () => ({ score: 1, signal: "BUY", reasons: ["All configured New Claude Strategy filters passed"] })
  });
  const portfolio = trader.getPortfolio();
  return candidates.map(candidate => {
    const sizing = getBuySizing(portfolio, candidate);
    return {
      ...candidate,
      reasons: [...(Array.isArray(candidate.reasons) ? candidate.reasons : []), "New Claude Strategy filters passed"],
      experimentEntry: {
        strategy: "New Claude Strategy",
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

function evaluateExit({ position, freshData, currentPrice, now = Date.now() }) {
  const entry = Number(position.entryPrice);
  const high = Number(position.highestPrice || entry);
  const profitPercent = (currentPrice - entry) / entry * 100;
  const highProfitPercent = (high - entry) / entry * 100;
  const holdMinutes = Math.max(0, (now - new Date(position.entryTime).getTime()) / 60000);
  const dropFromHigh = high > 0 ? (high - currentPrice) / high * 100 : 0;

  if (profitPercent <= -CONFIG.exit.stopLossPercent) {
    return { reason: "STOP LOSS -" + CONFIG.exit.stopLossPercent + "%", percent: 100 };
  }
  const liquidityExit = evaluateLiquidityProtection(position, freshData, now);
  if (liquidityExit) return liquidityExit;

  const currentNetProfitPercent = estimateNetProfitPercent(
    position, currentPrice, freshData?.liquidityUsd
  );
  const peakNetProfitPercent = estimateNetProfitPercent(
    position, high, freshData?.liquidityUsd
  );
  if (peakNetProfitPercent !== null &&
      peakNetProfitPercent >= PROFIT_LOCK_TRIGGER_NET_PERCENT &&
      currentNetProfitPercent !== null &&
      currentNetProfitPercent <= PROFIT_LOCK_FLOOR_NET_PERCENT) {
    return {
      reason: "PROFIT LOCK +" + PROFIT_LOCK_TRIGGER_NET_PERCENT + "% NET / +" + PROFIT_LOCK_FLOOR_NET_PERCENT + "% NET FLOOR",
      percent: 100
    };
  }
  if (position.secondTakeProfitDone && dropFromHigh >= CONFIG.exit.trailingStopPercent) {
    return { reason: "TRAILING STOP " + CONFIG.exit.trailingStopPercent + "%", percent: 100 };
  }
  if (!position.secondTakeProfitDone &&
      highProfitPercent >= CONFIG.exit.breakevenTriggerPercent &&
      profitPercent <= 0) {
    return { reason: "BREAKEVEN STOP", percent: 100 };
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
  getTokenData: getPositionTokenData,
  discoverCandidates: discoverBuyPriorityCandidates,
  acceptedSignals: ["BUY"],
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  botLabel: BOT_LABEL,
  reentryStateFile: statePath("v31BuyPriorityTestReentryState.json"),
  maxOpenPositions: CONFIG.capital.maxOpenPositions,
  requireLiquidityLock: false,
  useReentryGuards: false,
  exitDecision: evaluateExit,
  pauseEntriesAtBalance: CONFIG.capital.pauseAtBalanceUsd,
  entryPauseStateFile: statePath("v31BuyPriorityTestEntryPause.json")
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount
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
