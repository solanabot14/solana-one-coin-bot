const fs = require("node:fs");
const path = require("node:path");
const scanner = require("./scanner");
const { createBot } = require("./bot");
const { createPaperTrader } = require("./paperTrader");
const { createPullbackStrategy } = require("./pullbackStrategy");

const EXPERIMENT_VERSION = "PULLBACK-RECLAIM-SNAPSHOT-V1";

function experimentDataFile(env = process.env) {
	if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
		throw new Error("Attach a Railway volume before starting the pullback paper trader.");
	}
	const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
	return path.join(path.resolve(directory), "pullbackExperimentTradingData.json");
}

function createPullbackBot({ trader, timers = globalThis, getTokenData,
	discover = scanner.discoverCandidates, notifier = null,
	positionMonitorMs = 5000, scannerIntervalMs = 120000 } = {}) {
	const strategy = createPullbackStrategy();
	const notifyNone = notifier || {
		notifyTrade: async () => {},
		notifyCritical: async () => {}
	};
	const experimentScanner = async options => {
		const candidates = await discover(options || {});
		return strategy.observe(candidates);
	};
	const bot = createBot({
		trader: trader || createPaperTrader(experimentDataFile(), fs, { strategyVersion: EXPERIMENT_VERSION }),
		getTokenData,
		discoverCandidates: experimentScanner,
		timers,
		notifier: notifyNone,
		positionMonitorMs,
		scannerIntervalMs,
		botLabel: EXPERIMENT_VERSION
	});
	return { ...bot, getStrategyStatus: strategy.getStatus };
}

const trader = createPaperTrader(experimentDataFile(), fs, { strategyVersion: EXPERIMENT_VERSION });
const bot = createPullbackBot({ trader });

module.exports = {
	EXPERIMENT_VERSION,
	experimentDataFile,
	createPullbackBot,
	start: bot.startBot,
	stop: bot.stopBot,
	getStatus: bot.getBotStatus,
	getLastError: bot.getLastError,
	getPortfolio: trader.getPortfolio,
	getStrategyStatus: bot.getStrategyStatus
};
