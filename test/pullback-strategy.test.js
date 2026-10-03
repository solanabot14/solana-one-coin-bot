const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy, detectPattern } = require("../pullbackStrategy");
const { createPaperTrader } = require("../paperTrader");
const { buildDashboardData } = require("../dashboardData");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createLpLockChecker } = require("../lpLockChecker");
const { createCandleBreakoutExitPolicy } = require("../candleBreakoutExitPolicy");

function candlesForBreakout(now = Date.now(), breakoutVolume = 140) {
	const lastStart = Math.floor(now / 60000) * 60 - 60;
	const candles = Array.from({ length: 8 }, (_, index) => ({
		timestamp: lastStart - (7 - index) * 60,
		open: 1,
		high: 1.003,
		low: 0.997,
		close: 1,
		volume: 100
	}));
	Object.assign(candles[7], { open: 1.002, high: 1.014, low: 0.999, close: 1.01, volume: breakoutVolume });
	return candles;
}

function coin(overrides = {}) {
	return {
		tokenAddress: "token-A",
		pairAddress: "pool-A",
		symbol: "TEST",
		priceUsd: 1.012,
		priceChange5m: 1,
		priceChange1h: 5,
		volume5m: 1800,
		liquidityUsd: 25000,
		buys5m: 7,
		sells5m: 5,
		signal: "STRONG BUY",
		score: 10,
		reasons: [],
		ohlcv1m: candlesForBreakout(),
		...overrides
	};
}

test("recognizes a modest volume-confirmed 3-candle channel breakout in closed one-minute candles", () => {
	const now = Date.now();
	const pattern = detectPattern(candlesForBreakout(now), now);
	assert.equal(pattern.phase, "BREAKOUT");
	assert.ok(pattern.breakoutPercent >= 0.1);
	assert.ok(pattern.breakoutVolumeMultiple >= 1.1);
});

test("paper entry accepts the looser candle setup and rejects weak activity, liquidity, or a chased quote", () => {
	const now = Date.now();
	const strategy = createPullbackStrategy();
	const [entry] = strategy.observe([coin({ ohlcv1m: candlesForBreakout(now) })], now);
	assert.equal(entry.tokenAddress, "token-A");
	assert.equal(entry.signal, "STRONG BUY", "the common paper-trader contract needs STRONG BUY after the candle and LP gates");
	assert.equal(entry.experimentEntry.model, "CANDLE_BREAKOUT_1M_V1_1_EXPANDED");
	assert.equal(entry.experimentEntry.candleInterval, "1m");
	assert.equal(entry.experimentEntry.candleSource, "GeckoTerminal public OHLCV");
	assert.ok(entry.experimentEntry.breakoutVolumeMultiple >= 1.1);
	assert.match(entry.reasons.join(" "), /closed 1m candle/);
	assert.deepEqual(strategy.observe([coin({ ohlcv1m: candlesForBreakout(now) })], now), [], "same closed breakout candle is not emitted twice");

	const rejects = [
		coin({ ohlcv1m: [] }),
		coin({ ohlcv1m: candlesForBreakout(now, 99) }),
		coin({ priceUsd: 1.05, ohlcv1m: candlesForBreakout(now) }),
		coin({ buys5m: 4, sells5m: 5, ohlcv1m: candlesForBreakout(now) }),
		coin({ liquidityUsd: 19000, ohlcv1m: candlesForBreakout(now) })
	];
	for (const candidate of rejects) {
		assert.deepEqual(createPullbackStrategy().observe([candidate], now), []);
	}
});

test("expanded trigger accepts a fresh close just above the channel with average volume", () => {
	const now = Date.now();
	const bars = candlesForBreakout(now, 100);
	Object.assign(bars[7], { open: 1.003, high: 1.01, low: 0.999, close: 1.004, volume: 100 });
	const pattern = detectPattern(bars, now);
	assert.equal(pattern.phase, "BREAKOUT");
	assert.ok(pattern.breakoutPercent > 0 && pattern.breakoutPercent < 0.1);
	assert.equal(pattern.breakoutVolumeMultiple, 1);
	const [entry] = createPullbackStrategy().observe([coin({ priceUsd: 1.004, ohlcv1m: bars })], now);
	assert.equal(entry.experimentEntry.model, "CANDLE_BREAKOUT_1M_V1_1_EXPANDED");
	assert.ok(entry.experimentEntry.closeLocation >= 0.45);
});

test("rejects stale candles, candle gaps, and insufficient candle history", () => {
	const now = Date.now();
	const bars = candlesForBreakout(now);
	assert.equal(detectPattern(bars.slice(0, 5), now).reason, "NOT_ENOUGH_CLOSED_CANDLES");
	assert.equal(detectPattern(bars, now + 5 * 60 * 1000).reason, "STALE_CANDLES");
	const broken = structuredClone(bars); broken[4].timestamp += 90;
	assert.equal(detectPattern(broken, now).reason, "CANDLE_GAP");
});

test("requires confirmed 90% LP lock and caches RugCheck decisions", async () => {
	let calls = 0;
	const checker = createLpLockChecker({ httpGet: async () => { calls += 1; return { data: { lpLockedPct: 92 } }; } });
	const first = await checker.getLockStatus("token-A");
	const second = await checker.getLockStatus("token-A");
	assert.deepEqual(first, { allowed: true, lockedPercent: 92, reason: "LOCKED_LIQUIDITY_CONFIRMED" });
	assert.deepEqual(second, first);
	assert.equal(calls, 1);
	const unknown = createLpLockChecker({ httpGet: async () => { throw new Error("unavailable"); } });
	assert.deepEqual(await unknown.getLockStatus("token-B"), { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" });
});

test("candle breakout exits stop losses, trim at target, and protect the runner", () => {
	const exit = createCandleBreakoutExitPolicy();
	const position = { entryTime: new Date(Date.now() - 3 * 60 * 1000).toISOString() };
	assert.equal(exit({ position, profitPercent: -9, dropFromHigh: 0, highestProfitPercent: 0 }).reason, "CANDLE BREAKOUT HARD STOP");
	assert.equal(exit({ position: { ...position, firstTakeProfitDone: false }, profitPercent: 12, dropFromHigh: 0, highestProfitPercent: 12 }).percent, 50);
	assert.equal(exit({ position: { ...position, firstTakeProfitDone: true }, profitPercent: 5, dropFromHigh: 7, highestProfitPercent: 15 }).reason, "CANDLE BREAKOUT RUNNER TRAIL");
});

test("the experiment paper account persists separately and reports dollar plus percent returns", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pullback-paper-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const base = createPaperTrader(path.join(directory, "base.json"));
	const experiment = createPaperTrader(path.join(directory, "experiment.json"), fs, {
		strategyVersion: "CANDLE-BREAKOUT-1M-V1.1-EXPANDED"
	});

	const baseBuy = base.buy(coin());
	const experimentBuy = experiment.buy(coin());
	assert.equal(baseBuy.trade.amountInvested, 10);
	assert.equal(experimentBuy.trade.amountInvested, 10);
	assert.equal(base.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().positions[0].strategyVersion, "CANDLE-BREAKOUT-1M-V1.1-EXPANDED");

	experiment.sell(1.1, 100, { expectedPosition: experiment.positionKey(experiment.getPortfolio().positions[0]), reason: "TEST" });
	assert.equal(base.getPortfolio().history.filter(trade => trade.type === "SELL").length, 0);
	const summary = await buildDashboardData(experiment.getPortfolio(), async () => null);
	const expectedPnl = (1.1 - 1.012) / 1.012 * 10;
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
		pullbackStatus: { running: true, lockConfirmed: 1, candleCandidates: 2, minimumLockedPercent: 90, candleSource: "GeckoTerminal public OHLCV", candleInterval: "1m" } });
	assert.equal(nodes.get("pnl").textContent, "$4.25");
	assert.equal(nodes.get("pnlPct").textContent, "4.25%");
	assert.equal(nodes.get("pullbackPnl").textContent, "$-1.50");
	assert.equal(nodes.get("pullbackPnlPct").textContent, "-1.50%");
	assert.equal(nodes.get("pullbackWatching").textContent, "1 / 2");
	assert.equal(nodes.get("pullbackCandleFeed").textContent, "GeckoTerminal public OHLCV · 1m · LP lock ≥90%");
});
