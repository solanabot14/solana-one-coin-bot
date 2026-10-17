const fs = require("node:fs");
const path = require("node:path");
const poolDiscovery = require("./profitSniperDexDiscovery");
const market = require("./dexscreener");
const { createPaperTrader } = require("./paperTrader");
const { reconcileProfitSniperAccount } = require("./profitSniperReconcile");
const { createBot } = require("./bot");
const strategy = require("./profitSniperStrategy");
const CONFIG = require("./profitSniperConfig");
const {hourlyRank,compareHourly}=require("./profitSniperHourlyRank");
const { createMomentumTracker } = require("./profitSniperMomentum");
const { createRecoveryWatchlist } = require("./profitSniperRecoveryWatchlist");
const { createSniperEntryGuard } = require("./profitSniperEntryGuard");
const { WINDOW_MS, buildProfitSniper48h } = require("./profitSniperAnalytics");
const { constants } = strategy;
const { MAX_PAIR_AGE_MS, MIN_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD,
  MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M,
  HARD_STOP_PERCENT,
  TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
  TAKE_PROFIT_2_SELL_PERCENT, TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT,
  TRAILING_STOP_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD } = constants;
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
function chooseSniperExit(options = {}) {
  return chooseExit({ ...options, estimateExecutionCosts });
}

let lastEntryDecision = null;
const finalEntryCounts = { passed: 0, rejected: 0 };
let lastScanDiagnostics = { state: "waiting_for_first_scan", updatedAt: null, source: "DexScreener public feeds + live observations + RugCheck" };
const entryGuard = createSniperEntryGuard();
const momentumTracker = createMomentumTracker();
const ageWatchlist = new Map();
const recoveryWatchlist = createRecoveryWatchlist({
  maxAgeMs: CONFIG.RECOVERY_WATCHLIST_MAX_AGE_MS,
  maxSize: CONFIG.RECOVERY_WATCHLIST_MAX_SIZE,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume5mUsd: MIN_VOLUME_5M_USD
});
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
  const scanned = await poolDiscovery.discoverCandidates(options);
  const now = Date.now();
  const currentKeys = new Set();
  const candidates = [];
  for (const raw of scanned) {
    const key = String(raw.tokenAddress || "") + ":" + String(raw.pairAddress || "");
    currentKeys.add(key);
    const momentumPattern = momentumTracker.observe(raw, now);
    const coin = { ...raw, momentumPattern };
    recoveryWatchlist.remember(coin, now);
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
    candidates.push({ key, coin, failures, ageMs, wasWatchlisted: wasOnWatchlist });
  }

  // Discovery feeds rotate quickly. Keep promising exact pools warm with fresh
  // DexScreener quotes so a temporary feed omission cannot erase confirmation.
  const missingRecovery = recoveryWatchlist.missing(currentKeys, now);
  if (missingRecovery.length) {
    const uniqueByMint = new Map();
    for (const item of missingRecovery) {
      const current = uniqueByMint.get(item.tokenAddress);
      if (!current || Number(item.lastSnapshot?.liquidityUsd) > Number(current.lastSnapshot?.liquidityUsd))
        uniqueByMint.set(item.tokenAddress, item);
    }
    const tracked = [...uniqueByMint.values()];
    const pairAddresses = new Map(tracked.map(item => [item.tokenAddress, item.pairAddress]));
    const freshByMint = await market.getTokensData(tracked.map(item => item.tokenAddress),
      { signal: options.signal, pairAddresses });
    for (const item of tracked) {
      const fresh = freshByMint.get(item.tokenAddress);
      if (!fresh || fresh.pairAddress !== item.pairAddress) continue;
      const raw = { ...item.lastSnapshot, ...fresh, pairAddress: item.pairAddress,
        tokenAddress: item.tokenAddress };
      const momentumPattern = momentumTracker.observe(raw, now);
      const coin = { ...raw, momentumPattern, recoveryWatchlistRecheck: true };
      recoveryWatchlist.recordDirectRecheck(item.key, coin, now);
      recoveryWatchlist.remember(coin, now);
      currentKeys.add(item.key);
      candidates.push({ key: item.key, coin, failures: getMomentumFailureReasons(coin, now),
        ageMs: now - Number(coin.pairCreatedAt), wasWatchlisted: ageWatchlist.has(item.key) });
    }
  }

  const portfolio = trader.getPortfolio();
  const history = Array.isArray(portfolio?.history) ? portfolio.history : [];
  const stoppedMints = new Set();
  for (const row of history) {
    if (!row?.tokenAddress) continue;
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
    // Observe the pool during momentum warmup, so both independent windows
    // mature together. Entry still requires current momentum and stable reserves.
    const poolStability = entryGuard.observe(coin, now);
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
    if (!failures.length) {
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
        flowMeasurement: pattern.flowMeasurement || null,
        activitySufficient: pattern.activitySufficient ?? null,
        volumeBasis: pattern.volumeBasis || null,
        historicalHydrated: !!pattern.historicalHydrated,
        entryRoute: pattern.entryRoute || null,
        confirmationSpanMs: pattern.confirmationSpanMs ?? null,
        risingSteps: pattern.risingSteps ?? null,
        strongActivityContinuation: !!pattern.strongActivityContinuation,
        liquidityRetained: pattern.liquidityRetained ?? null,
        volumeIncreasing: pattern.volumeIncreasing ?? null,
        pullbackObserved: !!pattern.pullbackObserved,
        ready: !!pattern.ready,
        reason: pattern.reason || null
      },
      fromAgeWatchlist: wasWatchlisted,
      fromRecoveryWatchlist: !!coin.recoveryWatchlistRecheck,
      reason: failures.length ? [...new Set(failures)].join(",") : "entry_candidate_selected"
    };
    logs.push(record);
    if (!failures.length) {
      entries.push({ ...coin, signal: "ORDER FLOW BUY",
        reasons: [...(coin.reasons || []), "Direct Sniper entry gates passed",
          "CONFIRMED ACTIVITY ENTRY: " + (coin.momentumPattern?.entryRoute || "unknown"),
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
    .sort(compareHourly)).sort(compareHourly);
  recordRejections(now, rejectedGates);
  const scanState = poolDiscovery.getScanDiagnostics();
  lastScanDiagnostics = {
    state: "scan_complete",
    updatedAt: new Date(now).toISOString(),
    source: "DexScreener public feeds + fresh exact pairs + local momentum + RugCheck; pair age 5m-24h",
    exactTrending5mRanking: false,
    exactTrending1hRanking: false,
    ranking: "Custom 1h activity; 5m entry confirmation",
    poolsReceived: scanState?.poolsReceived ?? null,
    recentPools: scanned.length,
    activityQualified: scanned.length,
    momentumQualified: qualified.length,
    momentumRejectedGates: rejectedGates,
    rejectionCountsLifetime: { ...cumulativeRejectionCounts },
    ageWatchlistPending: ageWatchlist.size,
    recoveryWatchlistPending: recoveryWatchlist.size(),
    recoveryWatchlistDirectRechecks: recoveryWatchlist.values()
      .reduce((sum, item) => sum + item.directRechecks, 0),
    ageWatchlistRechecks,
    entriesFromAgeWatchlist: history.filter(row => row?.type === "BUY" &&
      (row.entryReasons || []).includes("AGE WATCHLIST REENTRY")).length,
    evaluations: logs,
    selectedByScore: qualified.slice(0, MAX_OPEN_POSITIONS).map(coin => ({
      symbol: coin.symbol || null, tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress,
      score: Number(coin.score) || 0, hourlyActivity:hourlyRank(coin),
      fromAgeWatchlist: (coin.reasons || []).includes("AGE WATCHLIST REENTRY")
    })),
    error: scanState?.error || null
  };
  for (const record of logs) console.log("PROFIT SNIPER ENTRY EVALUATION | " + JSON.stringify(record));
  console.log("PROFIT SNIPER SCAN | pools observed: " + scanned.length +
    " | entry-qualified: " + qualified.length +
    " | watchlist pending: " + ageWatchlist.size +
    " | recovery tracking: " + recoveryWatchlist.size() +
    " | rejected gates: " + (Object.keys(rejectedGates).length ? JSON.stringify(rejectedGates) : "none"));
  return qualified;
}

const SESSION_RESET_ID = "profit-sniper-reset-200-2026-10-16T2134PR";
const savedSessionId = fs.existsSync(statePath())
  ? JSON.parse(fs.readFileSync(statePath(), "utf8")).sessionId : null;
const savedSessionIsCurrent = savedSessionId === SESSION_RESET_ID;
// A new session is an intentional paper-account reset. The trader archives the prior
// account snapshot below; comparing it with an older audited ledger would incorrectly
// keep the freshly reset Sniper paused.
const reconciliation = savedSessionIsCurrent
  ? { applied: false, reason: "already-applied" }
  : reconcileProfitSniperAccount(statePath());
// The explicit session reset below replaces the pre-reset account, so its old
// audited-ledger comparison cannot gate this one startup. Later restarts use the
// new session id and resume the normal reconciliation check.
const reconciliationReady = !savedSessionIsCurrent || reconciliation.applied ||
  ["already-applied", "no-account"].includes(reconciliation.reason);
if (reconciliation.reason === "account-differs-from-audited-ledger") {
  console.error("Profit Sniper reconciliation skipped: saved account changed; scanner must stay paused.");
}
const trader = createPaperTrader(statePath(), fs, {
  strategyVersion: "Profit-Sniper-200-10-Compound-2026-10-17",
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
  reentryStateFile: statePath("profitSniperReentryState-reset-20261016T2134PR.json"),
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxCandidateAgeMinutes: MAX_PAIR_AGE_MINUTES,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: 0,
  minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
  reentryMinimumLpLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
  acceptedSignals: ["ORDER FLOW BUY"],
  requireLiquidityLock: true,
  allowUnknownLiquidityLock: false,
  // Sniper already enforces fresh momentum and stop-loss bans; completed buys have no lifetime cap.
  // The inherited V3.1 reentry filter imposes a conflicting <4% 5m cap and
  // another two observations with 25% rolling-volume acceleration.
  useReentryGuards: false,
  useSimpleCooldown: false,
  exitDecision: chooseSniperExit,
  validateEntry: async (coin, options) => {
    let result;
    try {
      const stable = await entryGuard.validate(coin, options);
      result = stable.allowed ? await prebuy.prepareEntry(stable.coin, options) : stable;
    } catch (error) {
      result = { allowed: false, reason: error.message || "ENTRY_DATA_UNAVAILABLE" };
    }
    finalEntryCounts[result.allowed ? "passed" : "rejected"]++;
    lastEntryDecision = { checkedAt: new Date().toISOString(), symbol: coin.symbol,
      tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress,
      allowed: !!result.allowed, reason: result.reason || (result.allowed ? "VERIFIED" : "ENTRY_REJECTED") };
    console.log("PROFIT SNIPER FINAL ENTRY | " + JSON.stringify(lastEntryDecision));
    return result;
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
    chooseSniperExit({ position, currentPrice: price, freshData: quote, history: trader.getPortfolio().history })?.writeOff;
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
  const nextSizing = getBuySizing(portfolio);
  const completedEntries = (portfolio.history || []).filter(row => row?.type === "BUY").length;
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
      tp2Percent: TAKE_PROFIT_2_PERCENT, tp2OriginalPositionSellPercent: TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT - TAKE_PROFIT_1_SELL_PERCENT,
      tp2SellRemainingPercent: TAKE_PROFIT_2_SELL_PERCENT, runnerOriginalPositionPercent: 20,
      trailingStopPercent: TRAILING_STOP_PERCENT,
      postTp1FloorPercent: null,
      postTp1FloorBasis: "disabled",
      compoundRates: COMPOUND_RATES, nextTradeCompoundRate: nextSizing.compoundRate,
      nextTradeSizeUsd: nextSizing.amountInvested, nextTradeNumber: completedEntries + 1,
      maxOpenPositions: MAX_OPEN_POSITIONS, minimumTradeUsd: MINIMUM_TRADE_USD,
      sizingMode: "10% account-equity compounding per trade" },
    analytics48h: {
      ...buildProfitSniper48h(portfolio, rejectionEvents48h),
      rejectionCoverageStartedAt: rejectionEvents48h.length
        ? new Date(Math.min(...rejectionEvents48h.map(event => Number(event.at)))).toISOString() : null,
      unavailableRejectionMetrics: ["noSellRoute", "roundTripLoss", "priceImpact", "failClosed"]
    },
    scanDiagnostics: lastScanDiagnostics,
    entryDiagnostics: {
      rejectionCounts: { ...cumulativeRejectionCounts },
      finalEntryCounts: { ...finalEntryCounts },
      lastEntryDecision,
      reentryPolicy: { inheritedV31FilterEnabled: false, maximumTokenAttempts: null, tokenAttemptLimitEnabled: false,
        stopLossReentryBlocked: true, openMintDuplicatesBlocked: true },
      poolStability: entryGuard.getStatus(),
      ageWatchlistPending: ageWatchlist.size,
      recoveryWatchlistPending: recoveryWatchlist.size(),
      ageWatchlistRechecks,
      entriesFromAgeWatchlist: (trader.getPortfolio().history || []).filter(row => row?.type === "BUY" &&
        (row.entryReasons || []).includes("AGE WATCHLIST REENTRY")).length,
      lastVerifiedHolderSecurity: entryGuard.getSecurityDiagnostics(),
      historicalLookupPending: false,
      historicalProvider: {provider:"Local DexScreener observations", geckoTerminalEnabled:false},
      discoveryProvider: poolDiscovery.getScanDiagnostics(),
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
  chooseExit: chooseSniperExit,
  estimateExecutionCosts,
  thresholds: {
    maximumPairAgeMinutes: MAX_PAIR_AGE_MINUTES,
    minimumPairAgeMinutes: MIN_PAIR_AGE_MS / 60000,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: null,
    volume24hFilterEnabled: false,
    minimumStablePoolObservations: CONFIG.MIN_STABLE_POOL_OBSERVATIONS,
    minimumVolume5mUsd: MIN_VOLUME_5M_USD,
    minimumTransactions5m: MIN_TRANSACTIONS_5M,
    minimumBuyRatio5m: MIN_BUY_RATIO_5M,
    minimumMomentum5mPercent: null,
    maximumMomentum5mPercent: null,
    maximumMomentum1hPercent: null,
    maximumMomentum24hPercent: null,
    minimumPumpPercent: null,
    pumpRequired: false,
    pullbackRequired: false,
    highVolume5mUsd: CONFIG.HIGH_VOLUME_5M_USD,
    highTransactions5m: CONFIG.HIGH_TRANSACTIONS_5M,
    maxRoundTripLossPercent: CONFIG.MAX_ROUND_TRIP_LOSS_PERCENT,
    maxQuotedRoundTripCostPercent:CONFIG.MAX_QUOTED_ROUND_TRIP_COST_PERCENT,
    roundTripUncertaintyReservePercent:CONFIG.ROUND_TRIP_SLIPPAGE_BUFFER_PERCENT,
    maximumMarketDataAgeMs:CONFIG.MAX_MARKET_DATA_AGE_MS,
    maximumExecutionQuoteAgeMs:CONFIG.MAX_EXECUTION_QUOTE_AGE_MS,
    maximumRetracePercent: null,
    recoveryMinimumBuyShare: CONFIG.RECOVERY_MIN_BUY_SHARE,
    recoveryConfirmationSpanMs: CONFIG.RECOVERY_CONFIRMATION_SPAN_MS,
    recoveryMinimumLiquidityRetentionPercent: null,
    recentPoolLiquidityRetentionPercent: 90,
    minimumBuyShare5m: CONFIG.MIN_BUY_SHARE_5M,
    minimumBuySellRatio5m: null,
    watchlistRecheckMs: CONFIG.WATCHLIST_RECHECK_MS,
    watchlistMaximumAgeMs: CONFIG.WATCHLIST_MAX_AGE_MS,
    watchlistMaximumLiquidityDropPercent: CONFIG.WATCHLIST_MAX_LIQUIDITY_DROP * 100,
    maximumTokenAttempts: null, tokenAttemptLimitEnabled: false,
    maximumTop10HolderPercent: CONFIG.MAX_TOP10_HOLDER_PERCENT,
    matureActiveHolderPolicy: { maximumTop10HolderPercent: CONFIG.MATURE_MAX_TOP10_HOLDER_PERCENT,
      minimumPairAgeMinutes: CONFIG.MATURE_MIN_PAIR_AGE_MS / 60000,
      minimumLiquidityUsd: CONFIG.MATURE_MIN_LIQUIDITY_USD,
      minimumVolume5mUsd: CONFIG.HIGH_VOLUME_5M_USD,
      minimumTransactions5m: CONFIG.HIGH_TRANSACTIONS_5M,
      minimumBuyShare: CONFIG.STRONG_ACTIVITY_MIN_BUY_SHARE },
    maximumIndividualHolderPercent: CONFIG.MAX_SINGLE_HOLDER_PERCENT,
    minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
    maximumOpenPositions: MAX_OPEN_POSITIONS,
    minimumTradeUsd: MINIMUM_TRADE_USD
  }
};




