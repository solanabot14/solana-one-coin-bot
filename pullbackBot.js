const fs = require("node:fs");
const path = require("node:path");
const { createBot } = require("./bot");
const { createPaperTrader } = require("./paperTrader");
const { createCandleBreakoutExitPolicy } = require("./candleBreakoutExitPolicy");
const { getLockStatus } = require("./lpLockChecker");
const pullbackDiscovery = require("./pullbackDiscovery");
const pubxDiscovery = require("./pubxDiscovery");
const candidateDiscovery = pullbackDiscovery.createPullbackDiscovery({
  discoverExisting: pubxDiscovery.discoverCandidates
});

const EXPERIMENT_VERSION = "CANDLE-BREAKOUT-1M-V1";
const MAX_CANDIDATES_PER_SCAN = 2;
const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 45000;

function experimentDataFile(env = process.env) {
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the isolated paper trader.");
  }
  const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
	return path.join(path.resolve(directory), "candleBreakoutTradingData.json");
}

function createPullbackBot({ trader, timers = globalThis, getTokenData,
  discover = candidateDiscovery.discoverCandidates, notifier = null,
  positionMonitorMs = POSITION_MONITOR_MS, scannerIntervalMs = SCANNER_INTERVAL_MS,
  checkLiquidityLock = getLockStatus } = {}) {
  const strategy = require("./pullbackStrategy").createPullbackStrategy();
  let scanStats = { eligible: 0, candleCandidates: 0, lockConfirmed: 0, lockRejected: 0,
    candleInterval: "1m", candleSource: "GeckoTerminal public OHLCV", minimumLockedPercent: 90 };
  const telegram = require("./telegram");
  const notifyNone = notifier || {
    notifyTrade: (event, trade) => telegram.sendTelegramMessage(
      telegram.formatTradeNotification(event, trade)
        .replace("ONE COIN BOT | ", "CANDLE BREAKOUT V1 | ")
    ),
    notifyCritical: message => telegram.sendTelegramMessage(
      telegram.formatCriticalNotification(message)
        .replace("ONE COIN BOT | ", "CANDLE BREAKOUT V1 | ")
    )
  };
  const experimentScanner = async options => {
    const candidates = await discover(options || {});
    const ranked = (Array.isArray(candidates) ? candidates : [])
      .filter(coin => coin?.tokenAddress && coin?.pairAddress && Array.isArray(coin.ohlcv1m))
      .sort((a, b) => (Number(b.volume5m) || 0) - (Number(a.volume5m) || 0))
      .slice(0, MAX_CANDIDATES_PER_SCAN);
    const signals = strategy.observe(ranked);
    scanStats = { ...scanStats, eligible: candidates?.length || 0, candleCandidates: ranked.length,
      lockConfirmed: 0, lockRejected: 0, lastScanAt: new Date().toISOString() };
    const ready = [];
    for (const signal of signals) {
      const lock = await checkLiquidityLock(signal.tokenAddress);
      if (!lock?.allowed) {
        strategy.release(signal.tokenAddress, signal.experimentEntry.breakoutAt);
        scanStats.lockRejected += 1;
        continue;
      }
      scanStats.lockConfirmed += 1;
      signal.experimentEntry.lockedLiquidityPercent = lock.lockedPercent;
      signal.reasons.push(`CANDLE BREAKOUT V1: LP lock ${lock.lockedPercent.toFixed(1)}% confirmed by RugCheck`);
      ready.push(signal);
    }
    return ready;
  };
  const bot = createBot({
    trader: trader || createPaperTrader(experimentDataFile(), fs, { strategyVersion: EXPERIMENT_VERSION }),
    getTokenData,
    discoverCandidates: experimentScanner,
    timers,
    notifier: notifyNone,
    positionMonitorMs,
    scannerIntervalMs,
    botLabel: EXPERIMENT_VERSION,
    exitPolicy: createCandleBreakoutExitPolicy()
  });
  return { ...bot, getStrategyStatus: () => ({ ...strategy.getStatus(), ...scanStats }) };
}

const trader = createPaperTrader(experimentDataFile(), fs, { strategyVersion: EXPERIMENT_VERSION });
const bot = createPullbackBot({ trader });

module.exports = {
  EXPERIMENT_VERSION,
  MAX_CANDIDATES_PER_SCAN,
  POSITION_MONITOR_MS,
  SCANNER_INTERVAL_MS,
  experimentDataFile,
  createPullbackBot,
  start: bot.startBot,
  stop: bot.stopBot,
  getStatus: bot.getBotStatus,
  getLastError: bot.getLastError,
  getPortfolio: trader.getPortfolio,
  getStrategyStatus: bot.getStrategyStatus
};
