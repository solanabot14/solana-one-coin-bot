const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyzeToken } = require("../strategy");
const { createPaperTrader } = require("../paperTrader");

function strongCandidate(overrides = {}) {
	return {
		tokenAddress: "token",
		symbol: "TEST",
		name: "Test",
		priceUsd: 1,
		liquidityUsd: 150000,
		volume24h: 500000,
		priceChange5m: 1,
		priceChange1h: 5,
		priceChange24h: 10,
		buys5m: 55,
		sells5m: 45,
		...overrides
	};
}

test("V3.2 STRONG BUY requires the new entry floors", () => {
	assert.equal(analyzeToken(strongCandidate()).signal, "STRONG BUY");
	assert.notEqual(analyzeToken(strongCandidate({ priceChange5m: 0.49 })).signal, "STRONG BUY");
	assert.notEqual(analyzeToken(strongCandidate({ priceChange1h: 0.79 })).signal, "STRONG BUY");
	assert.notEqual(analyzeToken(strongCandidate({ buys5m: 54, sells5m: 46 })).signal, "STRONG BUY");
});

test("V3.2 paper trader compounds at 10 percent of current cash balance", t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-v32-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "tradingData.json");
	const trader = createPaperTrader(file);

	const first = { ...strongCandidate(), signal: "STRONG BUY", score: 12 };
	assert.equal(trader.buy(first).success, true);
	assert.equal(trader.getPortfolio().position.amountInvested, 10);
	assert.equal(trader.getPortfolio().position.strategyVersion, "V3.2");

	trader.sell(2, 100);
	assert.equal(trader.getPortfolio().cashBalance, 110);

	const second = { ...first, tokenAddress: "token2" };
	assert.equal(trader.buy(second).success, true);
	assert.ok(Math.abs(trader.getPortfolio().position.amountInvested - 11) < 1e-10);
});
