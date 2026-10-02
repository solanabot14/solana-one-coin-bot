const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy, detectPattern } = require("../pullbackStrategy");
const { createPaperTrader } = require("../paperTrader");
const { buildDashboardData } = require("../dashboardData");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function candlesForReclaim(now = Date.now(), breakoutVolume = 240) {
	const lastStart = Math.floor(now / 60000) * 60 - 60;
	const candles = Array.from({ length: 14 }, (_, index) => ({
		timestamp: lastStart - (13 - index) * 60,
		open: 1,
		high: 1.005,
		low: 0.995,
		close: 1,
		volume: 100
	}));
	Object.assign(candles[5], { open: 1.01, high: 1.05, low: 1.01, close: 1.04, volume: 140 });
	Object.assign(candles[6], { open: 1.04, high: 1.045, low: 1.03, close: 1.04, volume: 130 });
	Object.assign(candles[7], { open: 1.04, high: 1.04, low: 1.02, close: 1.035, volume: 100 });
	Object.assign(candles[8], { open: 1.035, high: 1.035, low: 1.015, close: 1.02, volume: 80 });
	Object.assign(candles[9], { open: 1.02, high: 1.023, low: 1.018, close: 1.02, volume: 90 });
	Object.assign(candles[10], { open: 1.02, high: 1.026, low: 1.019, close: 1.024, volume: 110 });
	Object.assign(candles[11], { open: 1.024, high: 1.028, low: 1.022, close: 1.026, volume: 100 });
	Object.assign(candles[12], { open: 1.026, high: 1.03, low: 1.024, close: 1.028, volume: 100 });
	Object.assign(candles[13], { open: 1.028, high: 1.04, low: 1.027, close: 1.034, volume: breakoutVolume });
	return candles;
}

function coin(overrides = {}) {
	return {
		tokenAddress: "token-A",
		pairAddress: "pool-A",
		symbol: "TEST",
		priceUsd: 1.035,
		priceChange5m: 1,
		priceChange1h: 5,
		volume5m: 12000,
		liquidityUsd: 100000,
		buys5m: 40,
		sells5m: 20,
		signal: "STRONG BUY",
		score: 10,
		reasons: [],
		ohlcv1m: candlesForReclaim(),
		...overrides
	};
}

test("recognizes pump, pullback, and volume-backed reclaim in closed one-minute candles", () => {
	const now = Date.now();
	const pattern = detectPattern(candlesForReclaim(now), now);
	assert.equal(pattern.phase, "RECLAIMED");
	assert.ok(pattern.firstPumpPercent >= 1.5 && pattern.firstPumpPercent <= 8);
	assert.ok(pattern.pullbackPercent >= 2 && pattern.pullbackPercent <= 12);
	assert.ok(pattern.breakoutVolumeMultiple >= 1.5);
});

test("paper entry requires candle confirmation, activity filters, and a quote near breakout", () => {
	const now = Date.now();
	const strategy = createPullbackStrategy();
	const [entry] = strategy.observe([coin({ ohlcv1m: candlesForReclaim(now) })], now);
	assert.equal(entry.tokenAddress, "token-A");
	assert.equal(entry.experimentEntry.model, "PULLBACK_RECLAIM_OHLCV_V2");
	assert.equal(entry.experimentEntry.candleInterval, "1m");
	assert.equal(entry.experimentEntry.candleSource, "GeckoTerminal public OHLCV");
	assert.ok(entry.experimentEntry.breakoutVolumeMultiple >= 1.5);
	assert.match(entry.reasons.join(" "), /closed GeckoTerminal 1m candles/);
	assert.equal(strategy.getStatus().watching, 0);
	assert.deepEqual(strategy.observe([coin({ ohlcv1m: candlesForReclaim(now) })], now), [], "same closed breakout candle is not emitted twice");

	const rejects = [
		coin({ ohlcv1m: [] }),
		coin({ ohlcv1m: candlesForReclaim(now, 100) }),
		coin({ priceUsd: 1.07, ohlcv1m: candlesForReclaim(now) }),
		coin({ buys5m: 20, sells5m: 15, ohlcv1m: candlesForReclaim(now) }),
		coin({ volume5m: 9000, ohlcv1m: candlesForReclaim(now) })
	];
	for (const candidate of rejects) {
		assert.deepEqual(createPullbackStrategy().observe([candidate], now), []);
	}
});

test("only counts a pullback after candle evidence and drops stale candle patterns", () => {
	const now = Date.now();
	const strategy = createPullbackStrategy();
	const bars = candlesForReclaim(now);
	const partial = bars.slice(0, 12);
	const partialNow = Number(partial.at(-1).timestamp) * 1000 + 60 * 1000;
	assert.deepEqual(strategy.observe([coin({ ohlcv1m: partial })], partialNow), []);
	assert.equal(strategy.getStatus().watching, 1);
	assert.equal(strategy.getStatus().candleInterval, "1m");
	const fullNow = Number(bars.at(-1).timestamp) * 1000 + 60 * 1000;
	assert.deepEqual(strategy.observe([coin({ priceUsd: 1.1, ohlcv1m: bars })], fullNow), []);
	assert.equal(strategy.getStatus().pullback, 1);
	const staleNow = fullNow + 10 * 60 * 1000;
	assert.deepEqual(strategy.observe([coin({ ohlcv1m: bars })], staleNow), []);
	assert.equal(strategy.getStatus().watching, 0);
});

test("the experiment paper account persists separately and reports dollar plus percent returns", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pullback-paper-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const base = createPaperTrader(path.join(directory, "base.json"));
	const experiment = createPaperTrader(path.join(directory, "experiment.json"), fs, {
		strategyVersion: "PULLBACK-RECLAIM-OHLCV-V2"
	});

	const baseBuy = base.buy(coin());
	const experimentBuy = experiment.buy(coin());
	assert.equal(baseBuy.trade.amountInvested, 10);
	assert.equal(experimentBuy.trade.amountInvested, 10);
	assert.equal(base.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().positions[0].strategyVersion, "PULLBACK-RECLAIM-OHLCV-V2");

	experiment.sell(1.1, 100, { expectedPosition: experiment.positionKey(experiment.getPortfolio().positions[0]), reason: "TEST" });
	assert.equal(base.getPortfolio().history.filter(trade => trade.type === "SELL").length, 0);
	const summary = await buildDashboardData(experiment.getPortfolio(), async () => null);
	const expectedPnl = (1.1 - 1.035) / 1.035 * 10;
	assert.ok(Math.abs(summary.totalPnl - expectedPnl) < 1e-10);
	assert.ok(Math.abs(summary.totalPnlPercent - expectedPnl) < 1e-10);
});

test("dashboard renders separate dollar and percent P/L for baseline and experiment", () => {
	const nodes = new Map();
	const context = { document: { getElementById(id) {
		if (!nodes.has(id)) nodes.set(id, { addEventListener() {} });
		return nodes.get(id);
	} } };
	const clientFile = path.join(__dirname, "..", "dashboard-client.js");
	const source = fs.readFileSync(clientFile, "utf8").replace(/pollStatus\(\);\s*pollData\(\);\s*$/, "");
	vm.runInNewContext(source, context);
	const stats = { completedTrades: 0, winners: 0, losers: 0, winRate: 0, grossProfit: 0,
		grossLoss: 0, netPnl: 0, profitFactorLabel: "—" };
	const account = (totalPnl, totalPnlPercent) => ({ startingBalance: 100, cashBalance: 100,
		equity: 100 + totalPnl, totalPnl, totalPnlPercent, positions: [], livePositions: [],
		openSlots: 0, completedTrades: [], scoreStats: [], exitReasonCounts: {}, stats });
	context.renderData({ v31: account(4.25, 4.25), pullback: account(-1.5, -1.5),
		pullbackStatus: { running: true, firstPump: 2, pullback: 1, candleSource: "GeckoTerminal public OHLCV", candleInterval: "1m" } });
	assert.equal(nodes.get("pnl").textContent, "$4.25");
	assert.equal(nodes.get("pnlPct").textContent, "4.25%");
	assert.equal(nodes.get("pullbackPnl").textContent, "$-1.50");
	assert.equal(nodes.get("pullbackPnlPct").textContent, "-1.50%");
	assert.equal(nodes.get("pullbackCandleFeed").textContent, "GeckoTerminal public OHLCV · 1m closed candles");
});
