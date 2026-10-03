const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy } = require("../pullbackStrategy");
const { createPaperTrader } = require("../paperTrader");
const { buildDashboardData } = require("../dashboardData");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createLpLockChecker } = require("../lpLockChecker");
const { createCandleBreakoutExitPolicy } = require("../candleBreakoutExitPolicy");

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
		...overrides
	};
}

test("non-candle momentum entry accepts the aggressive market thresholds", () => {
	const now = Date.now();
	const strategy = createPullbackStrategy();
	const [entry] = strategy.observe([coin()], now);
	assert.equal(entry.tokenAddress, "token-A");
	assert.equal(entry.signal, "STRONG BUY");
	assert.equal(entry.experimentEntry.model, "FAST_MOMENTUM_V1_3_AGGRESSIVE");
	assert.match(entry.reasons.join(" "), /no candle wait/);
});

test("aggressive entry allows 6 transactions, 50% buys, $1,000 volume, and slight negative 5m momentum", () => {
	const now = Date.now();
	const [entry] = createPullbackStrategy().observe([coin({
		volume5m: 1000, liquidityUsd: 20000, buys5m: 3, sells5m: 3,
		priceChange5m: -0.5, priceChange1h: -10
	})], now);
	assert.ok(entry, "the softened thresholds should accept the boundary candidate");
});

test("rejects weak liquidity, activity, buy pressure, volume, and overheated momentum with reason counts", () => {
	const now = Date.now();
	const strategy = createPullbackStrategy();
	const rejected = [
		coin({ tokenAddress: "low-liquidity", liquidityUsd: 19999 }),
		coin({ tokenAddress: "low-activity", buys5m: 2, sells5m: 3 }),
		coin({ tokenAddress: "low-buy-ratio", buys5m: 2, sells5m: 4 }),
		coin({ tokenAddress: "low-volume", volume5m: 999 }),
		coin({ tokenAddress: "chase", priceChange5m: 15.1 })
	];
	assert.deepEqual(strategy.observe(rejected, now), []);
	assert.deepEqual(strategy.getStatus().rejectedByFilter, {
		LIQUIDITY_BELOW_20000: 1,
		FEWER_THAN_6_TRANSACTIONS: 1,
		BUY_RATIO_BELOW_50_PERCENT: 1,
		FIVE_MINUTE_VOLUME_TOO_LOW: 1,
		FIVE_MINUTE_MOMENTUM_OUT_OF_RANGE: 1
	});
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
		strategyVersion: "FAST-MOMENTUM-DEX-V1.3-AGGRESSIVE"
	});

	const baseBuy = base.buy(coin());
	const experimentBuy = experiment.buy(coin());
	assert.equal(baseBuy.trade.amountInvested, 10);
	assert.equal(experimentBuy.trade.amountInvested, 10);
	assert.equal(base.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().positions[0].strategyVersion, "FAST-MOMENTUM-DEX-V1.3-AGGRESSIVE");

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
		pullbackStatus: { running: true, lockConfirmed: 1, signalCandidates: 2, minimumLockedPercent: 90, discoverySource: "DexScreener profiles/boosts", rejectedByFilter: {} } });
	assert.equal(nodes.get("pnl").textContent, "$4.25");
	assert.equal(nodes.get("pnlPct").textContent, "4.25%");
	assert.equal(nodes.get("pullbackPnl").textContent, "$-1.50");
	assert.equal(nodes.get("pullbackPnlPct").textContent, "-1.50%");
	assert.equal(nodes.get("pullbackWatching").textContent, "1 / 2");
	assert.equal(nodes.get("pullbackEntryFeed").textContent, "DexScreener profiles/boosts · LP lock ≥90%");
});
