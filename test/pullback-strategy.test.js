const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackStrategy } = require("../pullbackStrategy");
const { createPaperTrader } = require("../paperTrader");
const { buildDashboardData } = require("../dashboardData");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function coin(overrides = {}) {
	return {
		tokenAddress: "token-A",
		symbol: "TEST",
		priceUsd: 1,
		priceChange5m: 3,
		priceChange1h: 5,
		volume5m: 12000,
		liquidityUsd: 100000,
		buys5m: 40,
		sells5m: 20,
		signal: "STRONG BUY",
		score: 10,
		reasons: [],
		...overrides
	};
}

test("waits for first pump, a 2%+ pullback, and reclaim with volume confirmation", () => {
	const strategy = createPullbackStrategy();
	assert.deepEqual(strategy.observe([coin({ priceUsd: 1 })], 1000), []);
	assert.deepEqual(strategy.observe([coin({ priceUsd: 1.05, priceChange5m: 2 })], 121000), []);
	assert.deepEqual(strategy.observe([coin({ priceUsd: 1.02, priceChange5m: -1, signal: "WAIT" })], 241000), []);
	assert.deepEqual(strategy.getStatus(), { firstPump: 0, pullback: 1, watching: 1 });

	const [entry] = strategy.observe([coin({ priceUsd: 1.053, priceChange5m: 1 })], 361000);
	assert.equal(entry.tokenAddress, "token-A");
	assert.equal(entry.experimentEntry.model, "PULLBACK_RECLAIM_SNAPSHOT_V1");
	assert.ok(entry.experimentEntry.pullbackPercent >= 2);
	assert.match(entry.reasons.join(" "), /reclaimed the prior high/);
	assert.equal(strategy.getStatus().watching, 0);
});

test("does not enter on reclaim when dollar volume, transaction count, or buy ratio is weak", () => {
	for (const finalOverrides of [
		{ volume5m: 9000 },
		{ buys5m: 20, sells5m: 15 },
		{ buys5m: 35, sells5m: 25 }
	]) {
		const strategy = createPullbackStrategy();
		strategy.observe([coin({ priceUsd: 1 })], 1000);
		strategy.observe([coin({ priceUsd: 1.05, priceChange5m: 2 })], 121000);
		strategy.observe([coin({ priceUsd: 1.02, priceChange5m: -1, signal: "WAIT" })], 241000);
		const entries = strategy.observe([coin({ priceUsd: 1.053, priceChange5m: 1, ...finalOverrides })], 361000);
		assert.equal(entries.length, 0);
	}
});

test("the experiment paper account persists separately and reports dollar plus percent returns", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pullback-paper-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const base = createPaperTrader(path.join(directory, "base.json"));
	const experiment = createPaperTrader(path.join(directory, "experiment.json"), fs, {
		strategyVersion: "PULLBACK-RECLAIM-SNAPSHOT-V1"
	});

	const baseBuy = base.buy(coin({ priceUsd: 1 }));
	const experimentBuy = experiment.buy(coin({ priceUsd: 1 }));
	assert.equal(baseBuy.trade.amountInvested, 10);
	assert.equal(experimentBuy.trade.amountInvested, 10);
	assert.equal(base.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().cashBalance, 90);
	assert.equal(experiment.getPortfolio().positions[0].strategyVersion, "PULLBACK-RECLAIM-SNAPSHOT-V1");

	experiment.sell(1.1, 100, { expectedPosition: experiment.positionKey(experiment.getPortfolio().positions[0]), reason: "TEST" });
	assert.equal(base.getPortfolio().history.filter(trade => trade.type === "SELL").length, 0);
	const summary = await buildDashboardData(experiment.getPortfolio(), async () => null);
	assert.equal(summary.totalPnl, 1);
	assert.equal(summary.totalPnlPercent, 1);
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
		pullbackStatus: { running: true, firstPump: 2, pullback: 1 } });
	assert.equal(nodes.get("pnl").textContent, "$4.25");
	assert.equal(nodes.get("pnlPct").textContent, "4.25%");
	assert.equal(nodes.get("pullbackPnl").textContent, "$-1.50");
	assert.equal(nodes.get("pullbackPnlPct").textContent, "-1.50%");
});
