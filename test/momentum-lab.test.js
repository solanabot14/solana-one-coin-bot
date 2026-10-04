const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyzeToken } = require("../strategy");
const { createPaperTrader } = require("../paperTrader");

const higgsSnapshot = {
	liquidityUsd: 244000,
	volume5m: 70000,
	volume24h: 3000000,
	priceChange5m: 7.01,
	priceChange1h: -19.04,
	priceChange24h: 6176,
	buys5m: 352,
	sells5m: 341
};

test("HIGGS-like snapshot qualifies only for the isolated fast-momentum lane", () => {
	const result = analyzeToken(higgsSnapshot);
	assert.equal(result.labSignal, "FAST MOMENTUM WATCH");
	assert.notEqual(result.signal, "STRONG BUY");
	assert.ok(result.labReasons.some(reason => reason.includes("$10 minimum")));
});

test("lab rejects 5m moves above the anti-chase ceiling", () => {
	const result = analyzeToken({ ...higgsSnapshot, priceChange5m: 8.01 });
	assert.equal(result.labSignal, "WAIT");
});

test("lab requires 5m volume relative to liquidity", () => {
	const result = analyzeToken({ ...higgsSnapshot, volume5m: 1000 });
	assert.equal(result.labSignal, "WAIT");
});

test("lab rejects weak activity and net sell pressure", () => {
	assert.equal(analyzeToken({ ...higgsSnapshot, buys5m: 9, sells5m: 10 }).labSignal, "WAIT");
	assert.equal(analyzeToken({ ...higgsSnapshot, buys5m: 40, sells5m: 50 }).labSignal, "WAIT");
});

test("paper trader applies the $10 minimum and subtracts modeled execution costs", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "b31-lab-"));
	const trader = createPaperTrader(path.join(directory, "account.json"), fs, {
		strategyVersion: "B3.1-FastMomentum-Lab-Paper"
	});
	const bought = trader.buy({ symbol: "HIGGS", tokenAddress: "higgs-test", priceUsd: 1,
		experimentEntry: { sizeMultiplier: 0.5, lane: "FAST_MOMENTUM_REBOUND_PAPER" } });
	assert.equal(bought.success, true);
	assert.equal(bought.trade.amountInvested, 10);
	const position = trader.getPortfolio().position;
	const sold = trader.sell(1, 100, { expectedPosition: trader.positionKey(position), reason: "TEST" });
	assert.equal(sold.success, true);
	assert.equal(sold.trade.executionCostBps, 80);
	assert.ok(sold.trade.totalEstimatedExecutionCostUsd > 0);
	assert.ok(sold.trade.pnl < 0);
	fs.rmSync(directory, { recursive: true, force: true });
});


test("paper trader compounds at 10% after a realized win", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lab-compound-"));
	try {
		const trader = createPaperTrader(path.join(directory, "account.json"), fs);
		const first = trader.buy({ symbol: "FIRST", tokenAddress: "first-test", priceUsd: 1 });
		assert.equal(first.trade.amountInvested, 10);
		const position = trader.getPortfolio().position;
		const closed = trader.sell(2, 100, { expectedPosition: trader.positionKey(position), reason: "TEST" });
		assert.equal(closed.success, true);
		const balance = trader.getPortfolio().cashBalance;
		const second = trader.buy({ symbol: "SECOND", tokenAddress: "second-test", priceUsd: 1 });
		assert.equal(second.success, true);
		assert.ok(Math.abs(second.trade.amountInvested - balance * 0.10) < 1e-9);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("paper trader invests available cash when below the $10 minimum", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lab-cash-cap-"));
	try {
		const file = path.join(directory, "account.json");
		fs.writeFileSync(file, JSON.stringify({
			startingBalance: 4.5, cashBalance: 4.5, positions: [], history: []
		}));
		const trader = createPaperTrader(file, fs);
		const bought = trader.buy({ symbol: "SMALL", tokenAddress: "small-test", priceUsd: 1 });
		assert.equal(bought.success, true);
		assert.equal(bought.trade.amountInvested, 4.5);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
