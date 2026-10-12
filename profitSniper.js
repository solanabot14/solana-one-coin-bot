const fs = require("node:fs");
const path = require("node:path");
const launchSniper = require("./launchSniper");
const market = require("./dexscreener");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const strategy = require("./profitSniperStrategy");
const { constants } = strategy;
const { MAX_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MIN_VOLUME_5M_USD,
  MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MIN_MOMENTUM_5M, MAX_MOMENTUM_5M, HARD_STOP_PERCENT,
  TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
  PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD } = constants;
const MAX_OPEN_POSITIONS = 3;
const SCAN_INTERVAL_MS = 30000;
const POSITION_MONITOR_MS = 5000;

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

const { qualifiesMomentumCandidate, getBuySizing, chooseExit } = strategy;

let lastScanDiagnostics = { state: "waiting_for_first_scan", updatedAt: null, source: "GeckoTerminal new pools + DexScreener + RugCheck" };

async function discoverCandidates(options = {}) {
  const candidates = await launchSniper.discoverLaunchCandidates({ ...options, minimumLiquidityUsd: MIN_LIQUIDITY_USD });
  const now = Date.now();
  const qualified = candidates.filter(coin => qualifiesMomentumCandidate(coin, now))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.volume5m || 0) - Number(a.volume5m || 0))
    .map(coin => ({ ...coin, signal: "BUY", reasons: [...(coin.reasons || []), "Profit Sniper activity + momentum filters passed"] }));
  lastScanDiagnostics = {
    state: "scan_complete",
    updatedAt: new Date(now).toISOString(),
    source: "GeckoTerminal new pools + DexScreener + RugCheck",
    poolsReceived: launchSniper.getStatus().scanDiagnostics?.poolsReceived ?? null,
    recentPools: launchSniper.getStatus().scanDiagnostics?.poolsTracked ?? null,
    activityQualified: candidates.length,
    momentumQualified: qualified.length,
    selectedByScore: qualified.slice(0, MAX_OPEN_POSITIONS).map(coin => coin.symbol || coin.tokenAddress),
    error: launchSniper.getStatus().scanDiagnostics?.error || null
  };
  return qualified;
}

const trader = createPaperTrader(statePath(), fs, {
  strategyVersion: "Paper-Profit-Sniper-v1",
  startingBalance: 100,
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
  checkLiquidityLock: require("./lpLockChecker").getLockStatus,
  batchPositionPrices: true,
  positionMonitorMs: POSITION_MONITOR_MS,
  scannerIntervalMs: SCAN_INTERVAL_MS,
  botLabel: "Paper Profit Sniper",
  reentryStateFile: statePath("profitSniperReentryState.json"),
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxCandidateAgeMinutes: 30,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: MIN_VOLUME_24H_USD,
  acceptedSignals: ["BUY", "STRONG BUY"],
  requireLiquidityLock: true,
  useReentryGuards: true,
  useSimpleCooldown: false,
  exitDecision: chooseExit
});

function getStatus() {
  return {
    running: bot.getBotStatus(),
    error: bot.getLastError(),
    mode: "PAPER",
    execution: "No wallet connection or live swaps",
    scanIntervalMs: SCAN_INTERVAL_MS,
    positionMonitorIntervalMs: POSITION_MONITOR_MS,
    strategy: { hardStopPercent: HARD_STOP_PERCENT, tp1Percent: TAKE_PROFIT_1_PERCENT,
      tp1SellPercent: TAKE_PROFIT_1_SELL_PERCENT, tp2Percent: TAKE_PROFIT_2_PERCENT,
      postTp1FloorPercent: PROFIT_FLOOR_AFTER_TP1_PERCENT, compoundRates: COMPOUND_RATES,
      maxOpenPositions: MAX_OPEN_POSITIONS, minimumTradeUsd: MINIMUM_TRADE_USD },
    scanDiagnostics: lastScanDiagnostics
  };
}

module.exports = {
  ...bot,
  getStatus,
  getPortfolio: trader.getPortfolio,
  qualifiesMomentumCandidate,
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
    minimumLiquidityLockPercent: 70,
    maximumOpenPositions: MAX_OPEN_POSITIONS,
    minimumTradeUsd: MINIMUM_TRADE_USD
  }
};
