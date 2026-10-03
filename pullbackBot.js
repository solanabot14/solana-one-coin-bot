const fs = require("node:fs");
const path = require("node:path");
const { createBot } = require("./bot");
const { createPaperTrader } = require("./paperTrader");
const { createPubxMomentumStrategy } = require("./pubxMomentumStrategy");
const { createPubxExitPolicy } = require("./pubxExitPolicy");
const pullbackDiscovery = require("./pullbackDiscovery");
const pubxDiscovery = require("./pubxDiscovery");
const candidateDiscovery = pullbackDiscovery.createPullbackDiscovery({
  discoverExisting: pubxDiscovery.discoverCandidates
});

const EXPERIMENT_VERSION = "PUBX-FAST-MOMENTUM-V1";
const MAX_CANDIDATES_PER_SCAN = 60;
const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 20000;

function experimentDataFile(env = process.env) {
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the PubX paper trader.");
  }
  const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "pubxFastMomentumTradingData.json");
}

function createPullbackBot({ trader, timers = globalThis, getTokenData,
  discover = candidateDiscovery.discoverCandidates, notifier = null,
  positionMonitorMs = POSITION_MONITOR_MS, scannerIntervalMs = SCANNER_INTERVAL_MS } = {}) {
  const strategy = createPubxMomentumStrategy();
  const telegram = require("./telegram");
  const notifyNone = notifier || {
    notifyTrade: (event, trade) => telegram.sendTelegramMessage(
      telegram.formatTradeNotification(event, trade)
        .replace("ONE COIN BOT | ", "PUBX FAST MOMENTUM | ")
    ),
    notifyCritical: message => telegram.sendTelegramMessage(
      telegram.formatCriticalNotification(message)
        .replace("ONE COIN BOT | ", "PUBX FAST MOMENTUM | ")
    )
  };
  const experimentScanner = async options => {
    const candidates = await discover(options || {});
    const ranked = (Array.isArray(candidates) ? candidates : [])
      .filter(coin => coin?.tokenAddress && coin?.pairAddress)
      .sort((a, b) => (Number(b.volume5m) || 0) - (Number(a.volume5m) || 0))
      .slice(0, MAX_CANDIDATES_PER_SCAN);
    return strategy.observe(ranked);
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
    exitPolicy: createPubxExitPolicy()
  });
  return { ...bot, getStrategyStatus: strategy.getStatus };
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
