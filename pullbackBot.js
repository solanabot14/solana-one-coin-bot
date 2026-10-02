const fs = require("node:fs");
const path = require("node:path");
const scanner = require("./scanner");
const { createBot } = require("./bot");
const { createPaperTrader } = require("./paperTrader");
const { createPullbackStrategy } = require("./pullbackStrategy");
const geckoTerminal = require("./geckoTerminal");

const EXPERIMENT_VERSION = "PULLBACK-RECLAIM-OHLCV-V2";
const MAX_CANDLE_WATCHLIST = 4;

function experimentDataFile(env = process.env) {
	if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
		throw new Error("Attach a Railway volume before starting the pullback paper trader.");
	}
	const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
	return path.join(path.resolve(directory), "pullbackExperimentTradingData.json");
}

function createPullbackBot({ trader, timers = globalThis, getTokenData,
	discover = scanner.discoverCandidates, notifier = null,
	getPoolCandles = geckoTerminal.getPoolCandles,
	positionMonitorMs = 5000, scannerIntervalMs = 120000 } = {}) {
	const strategy = createPullbackStrategy();
	const notifyNone = notifier || {
		notifyTrade: async () => {},
		notifyCritical: async () => {}
	};
	const experimentScanner = async options => {
		const candidates = await discover(options || {});
		const tracked = new Set(strategy.getTrackedTokens());
		const ranked = candidates.filter(coin => coin?.tokenAddress && coin?.pairAddress)
			.sort((a, b) => {
				const trackedRank = Number(tracked.has(b.tokenAddress)) - Number(tracked.has(a.tokenAddress));
				if (trackedRank) return trackedRank;
				const strongBuyRank = Number(b.signal === "STRONG BUY") - Number(a.signal === "STRONG BUY");
				if (strongBuyRank) return strongBuyRank;
				const scoreRank = (Number(b.score) || 0) - (Number(a.score) || 0);
				if (scoreRank) return scoreRank;
				return (Number(b.volume5m) || 0) - (Number(a.volume5m) || 0);
			})
			.slice(0, MAX_CANDLE_WATCHLIST);
		const candleCandidates = await Promise.all(ranked.map(async coin => {
			try {
				const ohlcv1m = await getPoolCandles(coin.pairAddress, coin.tokenAddress, options || {});
				return { ...coin, ohlcv1m };
			} catch (error) {
				console.warn(`PULLBACK CANDLE DATA UNAVAILABLE | ${coin.symbol} | ${error.message}`);
				return { ...coin, ohlcv1m: [] };
			}
		}));
		return strategy.observe(candleCandidates);
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
	MAX_CANDLE_WATCHLIST,
	experimentDataFile,
	createPullbackBot,
	start: bot.startBot,
	stop: bot.stopBot,
	getStatus: bot.getBotStatus,
	getLastError: bot.getLastError,
	getPortfolio: trader.getPortfolio,
	getStrategyStatus: bot.getStrategyStatus
};
