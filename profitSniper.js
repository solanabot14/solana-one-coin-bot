const fs = require("node:fs");
const path = require("node:path");
const launchSniper = require("./launchSniper");
const market = require("./dexscreener");
const { createPaperTrader } = require("./paperTrader");
const { reconcileProfitSniperAccount } = require("./profitSniperReconcile");
const { createBot } = require("./bot");
const strategy = require("./profitSniperStrategy");
const { constants } = strategy;
const { MAX_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MIN_VOLUME_5M_USD,
  MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MIN_MOMENTUM_5M, MAX_MOMENTUM_5M, HARD_STOP_PERCENT,
  TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
  TAKE_PROFIT_2_SELL_PERCENT, TRAILING_STOP_PERCENT, PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD } = constants;
const MAX_OPEN_POSITIONS = 3;
const SCAN_INTERVAL_MS = 30000;
const POSITION_MONITOR_MS = 5000;
const MINIMUM_LIQUIDITY_LOCK_PERCENT = 30;
const profitSniperLockChecker = require("./lpLockChecker").createLpLockChecker({
  minimumLockedPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT
});

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

const { qualifiesMomentumCandidate, getMomentumFailureReasons, getBuySizing, chooseExit } = strategy;

let lastScanDiagnostics = { state: "waiting_for_first_scan", updatedAt: null, source: "GeckoTerminal new pools + DexScreener + RugCheck" };

async function discoverCandidates(options = {}) {
  const candidates = await launchSniper.discoverLaunchCandidates({ ...options, minimumLiquidityUsd: MIN_LIQUIDITY_USD, minimumVolume24hUsd: MIN_VOLUME_24H_USD });
  const now = Date.now();
  const evaluated = candidates.map(coin => ({ coin, failures: getMomentumFailureReasons(coin, now) }));
  const rejectedGates = {};
  for (const item of evaluated) {
    for (const reason of item.failures) rejectedGates[reason] = (rejectedGates[reason] || 0) + 1;
  }
  const qualified = evaluated.filter(item => item.failures.length === 0).map(item => item.coin)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.volume5m || 0) - Number(a.volume5m || 0))
    .map(coin => ({ ...coin, signal: "BUY", reasons: [...(coin.reasons || []), "Profit Sniper activity + momentum filters passed"] }));
  const samples = evaluated.slice(0, 3).map(({ coin, failures }) => ({
    symbol: coin.symbol || null,
    momentum5m: Number(coin.priceChange5m),
    volume5m: Number(coin.volume5m),
    buys5m: Number(coin.buys5m),
    sells5m: Number(coin.sells5m),
    rejectedGates: failures
  }));
  const scanState = launchSniper.getStatus().scanDiagnostics;
  lastScanDiagnostics = {
    state: "scan_complete",
    updatedAt: new Date(now).toISOString(),
    source: "GeckoTerminal new pools + DexScreener + RugCheck",
    poolsReceived: scanState?.poolsReceived ?? null,
    recentPools: scanState?.poolsTracked ?? null,
    activityQualified: candidates.length,
    momentumQualified: qualified.length,
    momentumRejectedGates: rejectedGates,
    candidateSamples: samples,
    selectedByScore: qualified.slice(0, MAX_OPEN_POSITIONS).map(coin => coin.symbol || coin.tokenAddress),
    error: scanState?.error || null
  };
  console.log("PROFIT SNIPER SCAN | activity-qualified: " + candidates.length +
    " | momentum-qualified: " + qualified.length +
    " | rejected gates: " + (Object.keys(rejectedGates).length ? JSON.stringify(rejectedGates) : "none") +
    " | candidate samples: " + JSON.stringify(samples));
  return qualified;
}

const reconciliation = reconcileProfitSniperAccount(statePath());
const reconciliationReady = reconciliation.applied || ["already-applied", "no-account"].includes(reconciliation.reason);
if (reconciliation.reason === "account-differs-from-audited-ledger") {
  console.error("Profit Sniper reconciliation skipped: saved account changed; scanner must stay paused.");
}
const trader = createPaperTrader(statePath(), fs, {
  strategyVersion: "Paper-Profit-Sniper-v2-45-45-10",
  startingBalance: 200,
  sessionResetId: "profit-sniper-45-45-10-2026-10-13",
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
  checkLiquidityLock: profitSniperLockChecker.getLockStatus,
  batchPositionPrices: true,
  lockPositionPair: true,
  positionMonitorMs: POSITION_MONITOR_MS,
  scannerIntervalMs: SCAN_INTERVAL_MS,
  botLabel: "Paper Profit Sniper",
  reentryStateFile: statePath("profitSniperReentryState-v3.json"),
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxCandidateAgeMinutes: 30,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: MIN_VOLUME_24H_USD,
  minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
  acceptedSignals: ["BUY", "STRONG BUY"],
  requireLiquidityLock: true,
  allowUnknownLiquidityLock: false,
  useReentryGuards: true,
  useSimpleCooldown: false,
  exitDecision: chooseExit
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
  return {
    running: bot.getBotStatus(),
    error: bot.getLastError(),
    mode: "PAPER",
    execution: "No wallet connection or live swaps",
    scanIntervalMs: SCAN_INTERVAL_MS,
    positionMonitorIntervalMs: POSITION_MONITOR_MS,
    allowUnknownLiquidityLockInPaper: false,
    minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
    strategy: { hardStopPercent: HARD_STOP_PERCENT, tp1Percent: TAKE_PROFIT_1_PERCENT,
      tp1SellPercent: TAKE_PROFIT_1_SELL_PERCENT, tp1OriginalPositionSellPercent: 45,
      tp2Percent: TAKE_PROFIT_2_PERCENT, tp2OriginalPositionSellPercent: 45,
      tp2SellRemainingPercent: TAKE_PROFIT_2_SELL_PERCENT, runnerOriginalPositionPercent: 10,
      trailingStopPercent: TRAILING_STOP_PERCENT,
      postTp1FloorPercent: PROFIT_FLOOR_AFTER_TP1_PERCENT, compoundRates: COMPOUND_RATES,
      maxOpenPositions: MAX_OPEN_POSITIONS, minimumTradeUsd: MINIMUM_TRADE_USD },
    scanDiagnostics: lastScanDiagnostics
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
    maximumPairAgeMinutes: 30,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: MIN_VOLUME_24H_USD,
    minimumVolume5mUsd: MIN_VOLUME_5M_USD,
    minimumTransactions5m: MIN_TRANSACTIONS_5M,
    minimumBuyRatio5m: MIN_BUY_RATIO_5M,
    minimumMomentum5mPercent: MIN_MOMENTUM_5M,
    maximumMomentum5mPercent: MAX_MOMENTUM_5M,
    minimumLiquidityLockPercent: MINIMUM_LIQUIDITY_LOCK_PERCENT,
    maximumOpenPositions: MAX_OPEN_POSITIONS,
    minimumTradeUsd: MINIMUM_TRADE_USD
  }
};
