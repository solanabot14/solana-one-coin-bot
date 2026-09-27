const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPaperTrader, CURRENT_ENTRY_STRATEGY } = require("../paperTrader");
const { summarizeTrades, buildStrategyVersionStats, buildSourceStats, buildBirdeyeRankStats } = require("../dashboardData");

test("new OG buys start a clean V3.5 dataset without changing V3.4 risk management", () => {
	let stored = null;
	const io = {
		existsSync: () => false,
		mkdirSync: () => {},
		writeFileSync: (_path, value) => { stored = String(value); },
		renameSync: () => {},
		unlinkSync: () => {}
	};
	const trader = createPaperTrader("/tmp/v35-dataset.json", io);
	const result = trader.buy({
		symbol:"TEST", name:"Test", tokenAddress:"TOKEN", pairAddress:"PAIR", priceUsd:1,
		score:10, signal:"STRONG BUY", liquidityUsd:200000, volume5m:10000, volume24h:500000,
		buys5m:30, sells5m:10, birdeyeRank:3, discoverySources:["Birdeye Trending 1H"]
	});
	assert.equal(result.success, true);
	assert.equal(result.trade.strategyVersion, "V3.5");
	assert.equal(result.trade.riskManagementVersion, "V3.4");
	assert.equal(result.trade.entryBirdeyeRank, 3);
	assert.equal(CURRENT_ENTRY_STRATEGY, "V3.5");
	assert.ok(stored);
	const parsed = JSON.parse(stored);
	assert.equal(parsed.strategyDatasets.V3.5.startingBalance, 100);
	assert.ok(parsed.strategyDatasets.V3.5.startedAt);
});

test("clean research metrics calculate expectancy, payoff, loss streak and realized drawdown", () => {
	const trades = [
		{ pnl: 10, pnlPercent: 20, exitTime:"2026-09-27T01:00:00Z", holdTimeMs:1000, maxGainPercent:25 },
		{ pnl: -5, pnlPercent: -10, exitTime:"2026-09-27T02:00:00Z", holdTimeMs:1000, maxGainPercent:2 },
		{ pnl: -5, pnlPercent: -10, exitTime:"2026-09-27T03:00:00Z", holdTimeMs:1000, maxGainPercent:1 }
	];
	const s = summarizeTrades(trades, 100);
	assert.equal(s.completedTrades, 3);
	assert.ok(Math.abs(s.expectancyPercent - 0) < 1e-9);
	assert.equal(s.payoffRatio, 2);
	assert.equal(s.maxConsecutiveLosses, 2);
	assert.ok(Math.abs(s.maxDrawdownPercent - (10 / 110 * 100)) < 1e-9);
});

test("version, source and Birdeye-rank attribution stay separate", () => {
	const trades = [
		{ strategyVersion:"V3.4", pnl:1, pnlPercent:5, entryDiscoverySources:["Latest Boosts"] },
		{ strategyVersion:"V3.5", pnl:2, pnlPercent:10, entryDiscoverySources:["Birdeye Trending 1H"], entryBirdeyeRank:1 },
		{ strategyVersion:"V3.5", pnl:-1, pnlPercent:-5, entryDiscoverySources:["Birdeye Trending 1H","Latest Profiles"], entryBirdeyeRank:7 }
	];
	assert.equal(buildStrategyVersionStats(trades).find(row => row.version === "V3.5").trades, 2);
	assert.equal(buildSourceStats(trades.filter(t => t.strategyVersion === "V3.5")).find(row => row.source === "Birdeye Trending 1H").trades, 2);
	const ranks = buildBirdeyeRankStats(trades.filter(t => t.strategyVersion === "V3.5"));
	assert.equal(ranks.find(row => row.rank === "#1").trades, 1);
	assert.equal(ranks.find(row => row.rank === "#6–10").trades, 1);
});
