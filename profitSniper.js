const fs = require("node:fs");
const path = require("node:path");
const poolDiscovery = require("./poolDiscovery");
const market = require("./dexscreener");
const { createPaperTrader } = require("./paperTrader");
const { reconcileProfitSniperAccount } = require("./profitSniperReconcile");
const { createBot } = require("./bot");
const strategy = require("./profitSniperStrategy");
const CONFIG = require("./profitSniperConfig");
const { createMomentumTracker } = require("./profitSniperMomentum");
const { createSniperEntryGuard } = require("./profitSniperEntryGuard");
const { WINDOW_MS, buildProfitSniper48h } = require("./profitSniperAnalytics");
const { constants } = strategy;
const { MAX_PAIR_AGE_MS, MIN_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MAX_VOLUME_TO_LIQUIDITY, MIN_VOLUME_5M_USD,
  MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MIN_MOMENTUM_5M, MAX_MOMENTUM_5M,
  MAX_MOMENTUM_1H, MAX_MOMENTUM_24H, HARD_STOP_PERCENT,
  TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
  TAKE_PROFIT_2_SELL_PERCENT, TRAILING_STOP_PERCENT, PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD } = constants;
const MAX_OPEN_POSITIONS = 3;
const SCAN_INTERVAL_MS = CONFIG.WATCHLIST_RECHECK_MS;
const POSITION_MONITOR_MS = 2000;
const MINIMUM_LIQUIDITY_LOCK_PERCENT = CONFIG.MIN_LP_LOCK_PERCENT;
const MAX_PAIR_AGE_MINUTES = CONFIG.MAX_CANDIDATE_AGE_MINUTES;
const prebuy = require("./profitSniperPrebuy").createEntryGuard();

function statePath(fileName = "profitSniperTradingData.json") {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting Profit Sniper.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), fileName);
}

function estimateExecutionCosts({ amountUsd, liquidityUsd }) {
  const amount = Number(amountUsd);
  const liquidity = Number(liquidityUsd);
  if (!(amount > 0) || !(liquidity > 0)) return null;
  const impactPercent = amount / (liquidity / 2 + amount) * 100;
  const slippageUsd = amount * impactPercent / 100;
  const poolFeeUsd = amount * 0.003;
  const solanaFeeUsd = 0.01;
  return { feesUsd: poolFeeUsd + solanaFeeUsd, slippageUsd, poolFeeUsd, solanaFeeUsd, priorityFeeUsd: 0 };
}

const { qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit, selectUniqueMintCandidates } = strategy;

let lastScanDiagnostics = { state: "waiting_for_first_scan", updatedAt: null, source: "GeckoTerminal new + trending/top pools (24h) + exact DexScreener pairs + RugCheck; pair age 5m-6h" };
const entryGuard = createSniperEntryGuard();
const momentumTracker = createMomentumTracker();
const ageWatchlist = new Map();
const cumulativeRejectionCounts = {};
const TELEMETRY_PATH = statePath("profitSniperTelemetry48h.json");
let rejectionEvents48h = [];
try {
  const saved = JSON.parse(fs.readFileSync(TELEMETRY_PATH, "utf8"));
  rejectionEvents48h = Array.isArray(saved?.rejectionEvents) ? saved.rejectionEvents : [];
} catch {}
let ageWatchlistRechecks = 0;

function recordRejections(now, counts) {
  rejectionEvents48h.push({ at: now, counts: { ...counts } });
  rejectionEvents48h = rejectionEvents48h.filter(event => Number(event.at) >= now - WINDOW_MS);
  try {
    const temporary = TELEMETRY_PATH + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ updatedAt: new Date(now).toISOString(), rejectionEvents: rejectionEvents48h }));
    fs.renameSync(temporary, TELEMETRY_PATH);
  } catch (error) {
    console.warn("PROFIT SNIPER TELEMETRY SAVE FAILED | " + error.message);
  }
}

async function discoverCandidates(options = {}) {
  const scanned = await poolDiscovery.discoverLaunchCandidates({ ...options, minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: MIN_VOLUME_24H_USD, includeObservationCandidates: true,
    includeMaturePools: true, includeTrendingPools: true, maximumPairAgeMs: MAX_PAIR_AGE_MINUTES * 60 * 1000,
    minimumMaturePairAgeMs: MIN_PAIR_AGE_MS, maturePoolReserve: CONFIG.MATURE_POOL_RESERVE });
  const now = Date.now();
  const currentKeys = new Set();
  const candidates = scanned.map(raw => {
    const key = String(raw.tokenAddress || "") + ":" + String(raw.pairAddress || "");
    currentKeys.add(key);
    const momentumPattern = momentumTracker.observe(raw, now);
    const coin = { ...raw, momentumPattern };
    const failures = getMomentumFailureReasons(coin, now);
    const ageMs = now - Number(coin.pairCreatedAt);
    const wasOnWatchlist = ageWatchlist.has(key);
    if (failures.length === 1 && failures[0] === "age" && ageMs < CONFIG.MIN_PAIR_AGE_MS) {
      const prior = ageWatchlist.get(key);
      ageWatchlist.set(key, prior || { addedAt: now, initialLiquidityUsd: Number(coin.liquidityUsd),
        tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress, lastSnapshot: coin, rechecks: 0 });
      const item = ageWatchlist.get(key);
      item.lastSnapshot = coin;
      item.lastSeenAt = now;
      item.rechecks++;
      if (prior) ageWatchlistRechecks++;
    } else if (ageWatchlist.has(key)) {
      const item = ageWatchlist.get(key);
      item.lastSnapshot = coin;
      item.lastSeenAt = now;
      item.rechecks++;
      ageWatchlistRechecks++;
    }
    return { key, coin, failures, ageMs, wasWatchlisted: wasOnWatchlist };
  });

  const portfolio = trader.getPortfolio();
  const history = Array.isArray(portfolio?.history) ? portfolio.history : [];
  const buysByMint = new Map();
  const stoppedMints = new Set();
  for (const row of history) {
    if (!row?.tokenAddress) continue;
    if (row.type === "BUY") buysByMint.set(row.tokenAddress, (buysByMint.get(row.tokenAddress) || 0) + 1);
    if (row.type === "SELL" && /HARD STOP|STOP LOSS/i.test(String(row.reason || "")))
      stoppedMints.add(row.tokenAddress);
  }

  for (const [key, item] of ageWatchlist) {
    if (history.some(row => row?.type === "BUY" && row.tokenAddress === item.tokenAddress &&
        (row.entryReasons || []).includes("AGE WATCHLIST REENTRY"))) ageWatchlist.delete(key);
  }

  const entries = [];
  const rejectedGates = {};
  const logs = [];
  for (const item of candidates) {
    const { coin, key, ageMs, wasWatchlisted } = item;
    let failures = [...item.failures];
    const watch = ageWatchlist.get(key);
    if (watch) {
      if (now - watch.addedAt > CONFIG.WATCHLIST_MAX_AGE_MS) {
        ageWatchlist.delete(key);
        failures = [...new Set([...failures, "ageWatchlistExpired"])];
      } else if (Number(coin.liquidityUsd) < watch.initialLiquidityUsd * (1 - CONFIG.WATCHLIST_MAX_LIQUIDITY_DROP)) {
        ageWatchlist.delete(key);
        failures = [...new Set([...failures, "watchlistLiquidityDroppedOver30Percent"])];
      }
    }
    if (stoppedMints.has(coin.tokenAddress)) failures.push("stopLossReentryBlocked");
    if ((buysByMint.get(coin.tokenAddress) || 0) >= CONFIG.MAX_TOKEN_ATTEMPTS) failures.push("maxTokenAttempts");
    if (!failures.length) {
      const poolStability = entryGuard.observe(coin, now);
      if (!poolStability.ready) failures.push("poolStability");
    }
    for (const reason of failures) {
      rejectedGates[reason] = (rejectedGates[reason] || 0) + 1;
      cumulativeRejectionCounts[reason] = (cumulativeRejectionCounts[reason] || 0) + 1;
    }
    const pattern = coin.momentumPattern || {};
    const record = {
      at: new Date(now).toISOString(),
      tokenAddress: coin.tokenAddress || null,
      pairAddress: coin.pairAddress || null,
      ageMinutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000 * 100) / 100 : null,
      volume5mUsd: Number(coin.volume5m),
      buys5m: Number(coin.buys5m),
      sells5m: Number(coin.sells5m),
      liquidityUsd: Number(coin.liquidityUsd),
      top10HoldersPercent: null,
      largestHolderPercent: null,
      holderSecurity: "checked only by existing pre-buy RugCheck request",
      momentumPattern: {
        pumpPercent: pattern.pumpPercent ?? null,
        retracePercent: pattern.retracePercent ?? null,
        recovering: !!pattern.recovering,
        recentBuys: pattern.flowBuys ?? null,
        recentSells: pattern.flowSells ?? null,
        flowIsApproximation: pattern.flowIsApproximation ?? true,
        ready: !!pattern.ready,
        reason: pattern.reason || null
      },
      fromAgeWatchlist: wasWatchlisted,
      reason: failures.length ? [...new Set(failures)].join(",") : "entry_candidate_selected"
    };
    logs.push(record);
    if (!failures.length) {
      entries.push({ ...coin, signal: "ORDER FLOW BUY",
        reasons: [...(coin.reasons || []), "Direct Sniper entry gates passed",
          ...(wasWatchlisted ? ["AGE WATCHLIST REENTRY"] : []),
          "Exact identity: Solana mint " + coin.tokenAddress + "; pool " + coin.pairAddress] });
    }
  }

  // Process cached watchlist items absent from this scan without fabricating fresh
  // market data. They remain pending and cannot enter until a fresh scan sees them.
  for (const [key, item] of ageWatchlist) {
    if (currentKeys.has(key)) continue;
    if (now - item.addedAt > CONFIG.WATCHLIST_MAX_AGE_MS) {
      ageWatchlist.delete(key);
      cumulativeRejectionCounts.ageWatchlistExpired = (cumulativeRejectionCounts.ageWatchlistExpired || 0) + 1;
    }
  }

  const qualified = selectUniqueMintCandidates(entries
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.volume5m || 0) - Number(a.volume5m || 0)));
  recordRejections(now, rejectedGates);
  const scanState = poolDiscovery.getScanDiagnostics();
  lastScanDiagnostics = {
    state: "scan_complete",
    updatedAt: new Date(now).toISOString(),
    source: "GeckoTerminal new + trending/top pools (24h) + exact DexScreener pairs + RugCheck; pair age 5m-6h",
    poolsReceived: scanState?.poolsReceived ?? null,
    recentPools: scanned.length,
    activityQualified: scanned.length,
    momentumQualified: qualified.length,
    momentumRejectedGates: rejectedGates,
    rejectionCountsLifetime: { ...cumulativeRejectionCounts },
    ageWatchlistPending: ageWatchlist.size,
    ageWatchlistRechecks,
    entriesFromAgeWatchlist: history.filter(row => row?.type === "BUY" &&
      (row.entryReasons || []).includes("AGE WATCHLIST REENTRY")).length,
    evaluations: logs,
    selectedByScore: qualified.slice(0, MAX_OPEN_POSITIONS).map(coin => ({
      symbol: coin.symbol || null, tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress,
      score: Number(coin.score) || 0, fromAgeWatchlist: (coin.reasons || []).includes("AGE WATCHLIST REENTRY")
    })),
    error: scanState?.error || null
  };
  for (const record of logs) console.log("PROFIT SNIPER ENTRY EVALUATION | " + JSON.stringify(record));
  console.log("PROFIT SNIPER SCAN | pools observed: " + scanned.length +
    " | entry-qualified: " + qualified.length +
    " | watchlist pending: " + ageWatchlist.size +
    " | rejected gates: " + (Object.keys(rejectedGates).length ? JSON.stringify(rejectedGates) : "none"));
  return qualified;
}

const SESSION_RESET_ID = "profit-sniper-reset-200-2026-10-13T144522Z";
const savedSessionIsCurrent = fs.existsSync(statePath()) &&
  JSON.parse(fs.readFileSync(statePath(), "utf8")).sessionId === SESSION_RESET_ID;
const reconciliation = savedSessionIsCurrent
  ? { applied: false, reason: "already-applied" }
  : reconcileProfitSniperAccount(statePath());
const reconciliationReady = reconciliation.applied || ["already-applied", "no-account"].includes(reconciliation.reason);
if (reconciliation.reason === "account-differs-from-audited-ledger") {
  console.error("Profit Sniper reconciliation skipped: saved account changed; scanner must stay paused.");
}
const trader = createPaperTrader(statePath(), fs, {
  strategyVersion: "Paper-Profit-Sniper-original-10-20",
  startingBalance: 200,
  sessionResetId: SESSION_RESET_ID,
  maxOpenPositions: MAX_OPEN_POSITIONS,
  getBuySizing,
  estimateExecutionCosts
});

const quietNotifier = { notifyTrade: async () => {}, notifyCritical: async () => {} };

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  discoverCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: prebuy.checkLiquidityLock,
  batchPositionPrices: true,
  lockPositionPair: true,
  positionMonitorMs: POSITION_MONITOR_MS,
  scannerIntervalMs: SCAN_INTERVAL_MS,
  scanWhenFull: true,
  botLabel: "Paper Profit Sniper",
  reentryStateFile: statePath("profitSniperReentryState-reset-20261013T144522Z.json"),
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxCandidateAgeMinutes: MAX_PAIR_AGE_MINUTES,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: MIN_VOLUME_24H_USD,
  minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
  reentryMinimumLpLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
  acceptedSignals: ["ORDER FLOW BUY"],
  requireLiquidityLock: true,
  allowUnknownLiquidityLock: false,
  useReentryGuards: true,
  useSimpleCooldown: false,
  exitDecision: chooseExit,
  validateEntry: async (coin, options) => {
    const stable = await entryGuard.validate(coin, options);
    return stable.allowed ? prebuy.prepareEntry(stable.coin, options) : stable;
  }
});

async function closePosition(positionId) {
  const position = trader.getPortfolio().positions.find(item => String(item.id) === String(positionId));
  if (!position) return { success: false, error: "Profit Sniper position not found." };
  let quote = null;
  let quoteError = null;
  try {
    quote = await market.getTokenData(position.tokenAddress, {
      pairAddress: position.pairAddress || undefined,
      allowAlternatePairQuote: true
    });
  } catch (error) {
    quoteError = error?.message || String(error);
  }
  const price = Number(quote?.priceUsd);
  const liquidityUsd = Number(quote?.liquidityUsd);
  const unexecutable = price > 0 && liquidityUsd > 0 &&
    strategy.chooseExit({ position, currentPrice: price, freshData: quote })?.writeOff;
  if (!(price > 0) || !(liquidityUsd > 0) || unexecutable) {
    const result = bot.writeOffPosition(trader.positionKey(position), "MANUAL PAPER WRITE-OFF · NO LIQUIDITY");
    return { ...result, symbol: position.symbol, writeOff: !!result.success,
      saleValue: 0, quoteError, quotePairAddress: quote?.pairAddress || null };
  }
  const result = bot.closePosition(trader.positionKey(position), price, liquidityUsd, "MANUAL EMERGENCY EXIT");
  return { ...result, symbol: position.symbol, currentPrice: price, liquidityUsd,
    quotePairAddress: quote.pairAddress || null, alternatePool: quote.pairAddress !== position.pairAddress };
}

function getStatus() {
  const portfolio = trader.getPortfolio();
  return {
    running: bot.getBotStatus(),
    error: bot.getLastError(),
    mode: "PAPER",
    execution: "No wallet connection or live swaps",
    scanIntervalMs: SCAN_INTERVAL_MS,
    positionMonitorIntervalMs: POSITION_MONITOR_MS,
    allowUnknownLiquidityLockInPaper: false,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
    entryVerification: prebuy.getStatus(),
    strategy: { hardStopPercent: HARD_STOP_PERCENT, tp1Percent: TAKE_PROFIT_1_PERCENT,
      tp1SellPercent: TAKE_PROFIT_1_SELL_PERCENT, tp1OriginalPositionSellPercent: TAKE_PROFIT_1_SELL_PERCENT,
      tp2Percent: TAKE_PROFIT_2_PERCENT, tp2OriginalPositionSellPercent: 40,
      tp2SellRemainingPercent: TAKE_PROFIT_2_SELL_PERCENT, runnerOriginalPositionPercent: 20,
      trailingStopPercent: TRAILING_STOP_PERCENT,
      postTp1FloorPercent: PROFIT_FLOOR_AFTER_TP1_PERCENT, compoundRates: COMPOUND_RATES,
      maxOpenPositions: MAX_OPEN_POSITIONS, minimumTradeUsd: MINIMUM_TRADE_USD,
      sizingMode: "compounding" },
    analytics48h: {
      ...buildProfitSniper48h(portfolio, rejectionEvents48h),
      rejectionCoverageStartedAt: rejectionEvents48h.length
        ? new Date(Math.min(...rejectionEvents48h.map(event => Number(event.at)))).toISOString() : null,
      unavailableRejectionMetrics: ["noSellRoute", "roundTripLoss", "priceImpact", "failClosed"]
    },
    scanDiagnostics: lastScanDiagnostics,
    entryDiagnostics: {
      rejectionCounts: { ...cumulativeRejectionCounts },
      poolStability: entryGuard.getStatus(),
      ageWatchlistPending: ageWatchlist.size,
      ageWatchlistRechecks,
      entriesFromAgeWatchlist: (trader.getPortfolio().history || []).filter(row => row?.type === "BUY" &&
        (row.entryReasons || []).includes("AGE WATCHLIST REENTRY")).length,
      lastVerifiedHolderSecurity: entryGuard.getSecurityDiagnostics(),
      watchlistRecheckIntervalMs: CONFIG.WATCHLIST_RECHECK_MS
    }
  };
}

module.exports = {
  ...bot,
  reconciliationReady,
  startBot: () => {
    if (!reconciliationReady) throw new Error("Profit Sniper account differs from the audited ledger; scanner remains paused.");
    return bot.startBot();
  },
  getStatus,
  getPortfolio: trader.getPortfolio,
  closePosition,
  qualifiesMomentumCandidate,
  getMomentumFailureReasons,
  getBuySizing,
  chooseExit,
  estimateExecutionCosts,
  thresholds: {
    maximumPairAgeMinutes: MAX_PAIR_AGE_MINUTES,
    minimumPairAgeMinutes: MIN_PAIR_AGE_MS / 60000,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: null,
    volume24hFilterEnabled: false,
    minimumStablePoolObservations: 3,
    minimumVolume5mUsd: MIN_VOLUME_5M_USD,
    minimumTransactions5m: MIN_TRANSACTIONS_5M,
    minimumBuyRatio5m: MIN_BUY_RATIO_5M,
    minimumMomentum5mPercent: MIN_MOMENTUM_5M,
    maximumMomentum5mPercent: MAX_MOMENTUM_5M,
    maximumMomentum1hPercent: MAX_MOMENTUM_1H,
    maximumMomentum24hPercent: MAX_MOMENTUM_24H,
    minimumPumpPercent: CONFIG.MIN_PUMP_PERCENT,
    minimumRetracePercent: CONFIG.MIN_RETRACE_PERCENT,
    maximumEntryRetracePercent: CONFIG.MAX_ENTRY_RETRACE_PERCENT,
    maximumRetracePercent: CONFIG.MAX_RETRACE_PERCENT,
    minimumBuyShare5m: CONFIG.MIN_BUY_SHARE_5M,
    minimumBuySellRatio5m: CONFIG.MIN_BUY_SELL_RATIO_5M,
    watchlistRecheckMs: CONFIG.WATCHLIST_RECHECK_MS,
    watchlistMaximumAgeMs: CONFIG.WATCHLIST_MAX_AGE_MS,
    watchlistMaximumLiquidityDropPercent: CONFIG.WATCHLIST_MAX_LIQUIDITY_DROP * 100,
    maximumTokenAttempts: CONFIG.MAX_TOKEN_ATTEMPTS,
    maximumTop10HolderPercent: CONFIG.MAX_TOP10_HOLDER_PERCENT,
    maximumIndividualHolderPercent: CONFIG.MAX_SINGLE_HOLDER_PERCENT,
    minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
    maximumOpenPositions: MAX_OPEN_POSITIONS,
    minimumTradeUsd: MINIMUM_TRADE_USD
  }
};



