const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus } = require("./lpLockChecker");

const MAX_PAIR_AGE_MS = 30 * 60 * 1000;
const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_24H_USD = 25000;
const MIN_VOLUME_5M_USD = 1500;
const MIN_TRANSACTIONS_5M = 12;
const MIN_BUY_RATIO_5M = 0.55;

function statePath(fileName = "launchSniperPaperTradingData.json") {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the launch watcher.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), fileName);
}

function qualifiesLaunchCandidate(data, now = Date.now()) {
  if (!data || typeof data !== "object") return false;
  const createdAt = Number(data.pairCreatedAt);
  const ageMs = now - createdAt;
  const liquidity = Number(data.liquidityUsd);
  const volume24h = Number(data.volume24h);
  const volume5m = Number(data.volume5m);
  const buys5m = Number(data.buys5m);
  const sells5m = Number(data.sells5m);
  const transactions5m = buys5m + sells5m;
  const buyRatio5m = transactions5m > 0 ? buys5m / transactions5m : 0;
  return Number.isFinite(createdAt) && ageMs >= 0 && ageMs <= MAX_PAIR_AGE_MS &&
    Number.isFinite(liquidity) && liquidity >= MIN_LIQUIDITY_USD &&
    Number.isFinite(volume24h) && volume24h >= MIN_VOLUME_24H_USD &&
    Number.isFinite(volume5m) && volume5m >= MIN_VOLUME_5M_USD &&
    transactions5m >= MIN_TRANSACTIONS_5M && buyRatio5m >= MIN_BUY_RATIO_5M;
}

function estimateExecutionCosts({ amountUsd, liquidityUsd }) {
  const amount = Number(amountUsd);
  const liquidity = Number(liquidityUsd);
  if (!(amount > 0) || !(liquidity > 0)) return null;
  const impactPercent = amount / (liquidity / 2 + amount) * 100;
  const slippageUsd = amount * impactPercent / 100;
  const poolFeeUsd = amount * 0.003;
  const solanaFeeUsd = 0.01;
  return {
    feesUsd: poolFeeUsd + solanaFeeUsd,
    slippageUsd,
    poolFeeUsd,
    solanaFeeUsd,
    priorityFeeUsd: 0
  };
}

const trader = createPaperTrader(
  statePath(),
  fs,
  {
    strategyVersion: "Paper-Launch-Watcher-v1",
    startingBalance: 100,
    maxOpenPositions: 1,
    getBuySizing: () => ({ amountInvested: 10, compoundRate: 0.10 }),
    estimateExecutionCosts
  }
);

function discoverLaunchCandidates(options = {}) {
  return scanner.discoverCandidates({
    ...options,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: MIN_VOLUME_24H_USD,
    candidateFilter: data => qualifiesLaunchCandidate(data)
  }).then(candidates => candidates.map(candidate => ({
    ...candidate,
    experimentEntry: {
      ...(candidate.experimentEntry || {}),
      pairAgeMs: Math.max(0, Date.now() - Number(candidate.pairCreatedAt)),
      discoverySource: "DexScreener polling"
    }
  })));
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: async () => {}
};

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  discoverCandidates: discoverLaunchCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  positionMonitorMs: 2000,
  scannerIntervalMs: 30000,
  botLabel: "Paper Launch Watcher",
  reentryStateFile: statePath("launchSniperPaperReentryState.json"),
  maxOpenPositions: 1,
  maxCandidateAgeMinutes: 30,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: MIN_VOLUME_24H_USD,
  acceptedSignals: ["BUY", "STRONG BUY"],
  requireLiquidityLock: true,
  useSimpleCooldown: true
});

function getStatus() {
  return {
    running: bot.getBotStatus(),
    error: bot.getLastError(),
    mode: "PAPER",
    execution: "No wallet connection or live swaps",
    scanIntervalMs: 30000,
    maximumPairAgeMinutes: 30,
    minimumLiquidityLockPercent: 70
  };
}

module.exports = {
  ...bot,
  getStatus,
  getPortfolio: trader.getPortfolio,
  qualifiesLaunchCandidate,
  estimateExecutionCosts,
  thresholds: {
    maximumPairAgeMinutes: 30,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: MIN_VOLUME_24H_USD,
    minimumVolume5mUsd: MIN_VOLUME_5M_USD,
    minimumTransactions5m: MIN_TRANSACTIONS_5M,
    minimumBuyRatio5m: MIN_BUY_RATIO_5M,
    maximumOpenPositions: 1,
    paperEntryUsd: 10
  }
};
