const fs = require("node:fs");
const path = require("node:path");
const { createBot } = require("./bot");
const { createPaperTrader } = require("./paperTrader");
const marketScanner = require("./scanner");

const EXPERIMENT_VERSION = "PUBX-V31-ENTRY-TP40-PROFIT-LOCK-V1";
const MAX_OPEN_POSITIONS = 2;
const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const MINIMUM_LP_LOCK_PERCENT = 85;

function experimentDataFile(env = process.env) {
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the isolated V3.1 paper trader.");
  }
  const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "pubxV31Tp40PaperData.json");
}

function experimentReentryStateFile(env = process.env) {
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the isolated V3.1 reentry guard.");
  }
  const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "pubxV31ReentryState.json");
}

function createPullbackBot({ trader, timers = globalThis, getTokenData,
  discover = marketScanner.discoverCandidates, notifier = null,
  positionMonitorMs = POSITION_MONITOR_MS, scannerIntervalMs = SCANNER_INTERVAL_MS,
  checkLiquidityLock } = {}) {
  let scanStats = { eligible: 0, signalCandidates: 0, lockConfirmed: 0, lockRejected: 0,
    discoverySource: "DexScreener profiles/boosts • V3.1 scanner", minimumLockedPercent: MINIMUM_LP_LOCK_PERCENT,
    rejectedByFilter: {} };

  const experimentScanner = async options => {
    const candidates = await discover(options || {});
    const list = Array.isArray(candidates) ? candidates : [];
    const signalCandidates = list.filter(coin => coin?.signal === "BUY" || coin?.signal === "STRONG BUY");
    scanStats = { ...scanStats, eligible: list.length, signalCandidates: signalCandidates.length,
      lockConfirmed: 0, lockRejected: 0,
      rejectedByFilter: { SIGNAL_BELOW_BUY: list.length - signalCandidates.length },
      lastScanAt: new Date().toISOString() };
    console.log(`PUBX V3.1 ENTRY SCAN | discovered: ${list.length} | BUY/STRONG BUY: ${signalCandidates.length}`);
    return list;
  };

  const telegram = require("./telegram");
  const notify = notifier || {
    notifyTrade: (event, trade) => telegram.sendTelegramMessage(
      telegram.formatTradeNotification(event, trade).replace("ONE COIN BOT | ", "PUBX V3.1 TP40 | ")
    ),
    notifyCritical: message => telegram.sendTelegramMessage(
      telegram.formatCriticalNotification(message).replace("ONE COIN BOT | ", "PUBX V3.1 TP40 | ")
    )
  };

  const bot = createBot({
    trader: trader || createPaperTrader(experimentDataFile(), fs, {
      strategyVersion: EXPERIMENT_VERSION,
      maxOpenPositions: MAX_OPEN_POSITIONS
    }),
    getTokenData,
    discoverCandidates: experimentScanner,
    timers,
    notifier: notify,
    checkLiquidityLock,
    onLiquidityLockCheck: lock => {
      if (lock?.allowed && Number(lock.lockedPercent) >= MINIMUM_LP_LOCK_PERCENT) scanStats.lockConfirmed += 1;
      else scanStats.lockRejected += 1;
    },
    positionMonitorMs,
    scannerIntervalMs,
    botLabel: EXPERIMENT_VERSION,
    reentryStateFile: experimentReentryStateFile()
  });

  return { ...bot, getStrategyStatus: () => ({ ...scanStats }) };
}

const trader = createPaperTrader(experimentDataFile(), fs, {
  strategyVersion: EXPERIMENT_VERSION,
  maxOpenPositions: MAX_OPEN_POSITIONS
});
const bot = createPullbackBot({ trader });

module.exports = {
  EXPERIMENT_VERSION,
  MAX_OPEN_POSITIONS,
  POSITION_MONITOR_MS,
  SCANNER_INTERVAL_MS,
  experimentDataFile,
  experimentReentryStateFile,
  createPullbackBot,
  start: bot.startBot,
  stop: bot.stopBot,
  getStatus: bot.getBotStatus,
  getLastError: bot.getLastError,
  getPortfolio: trader.getPortfolio,
  positionKey: trader.positionKey,
  sell: trader.sell,
  getStrategyStatus: bot.getStrategyStatus
};
