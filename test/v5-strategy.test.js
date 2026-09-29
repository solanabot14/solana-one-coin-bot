const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyzeTokenV5, tokenAgeRegime } = require("../strategyV5");

function coin(overrides = {}) {
	return {
		liquidityUsd: 180000,
		volume5m: 15000,
		volume1h: 90000,
		volume24h: 900000,
		priceChange5m: 0.35,
		priceChange1h: 0.65,
		priceChange24h: 8,
		buys5m: 36,
		sells5m: 20,
		pairCreatedAt: Date.now() - 12 * 60 * 60 * 1000,
		...overrides
	};
}

test("V5 uses token age instead of one universal 1h floor", () => {
	const now = Date.now();
	assert.equal(tokenAgeRegime(now - 30 * 60 * 1000, now).name, "LAUNCH");
	assert.equal(tokenAgeRegime(now - 3 * 60 * 60 * 1000, now).name, "EARLY");
	assert.equal(tokenAgeRegime(now - 12 * 60 * 60 * 1000, now).name, "EXPANSION");
	assert.equal(tokenAgeRegime(now - 3 * 24 * 60 * 60 * 1000, now).name, "ESTABLISHED");
});

test("V5 can qualify sub-0.8 percent 1h momentum when quality is strong", () => {
	const result = analyzeTokenV5(coin(), {
		heliusFlow: { status: "OK", swapsLast5m: 24, uniqueMakers5m: 12, uniqueMakerRatio: 0.5 }
	});
	assert.equal(result.signal, "STRONG BUY");
	assert.ok(result.score >= 65);
	assert.equal(result.v5.dynamic1hPass, true);
});

test("V5 retains 4 percent 5m anti-chase", () => {
	const result = analyzeTokenV5(coin({ priceChange5m: 4.1 }));
	assert.equal(result.signal, "AVOID");
	assert.ok(result.reasons.some(reason => reason.includes("ANTI-CHASE")));
});

test("V5 rejects weak buy pressure as a hard core condition", () => {
	const result = analyzeTokenV5(coin({ buys5m: 25, sells5m: 30 }), {
		heliusFlow: { status: "OK", swapsLast5m: 25, uniqueMakers5m: 14, uniqueMakerRatio: 0.56 }
	});
	assert.notEqual(result.signal, "STRONG BUY");
});
