const { test } = require("node:test");
const assert = require("node:assert/strict");
const { entryQualitySnapshot } = require("../scanner");

test("blocks PYTHIA-like low-activity late entry", () => {
	const q = entryQualitySnapshot({
		liquidityUsd: 491000,
		volume5m: 2900,
		volume1h: 100000,
		priceChange5m: 0.99,
		priceChange1h: 24.95,
		buys5m: 15,
		sells5m: 4
	});
	assert.equal(q.activityHealthy, false);
	assert.equal(q.lateMomentum, true);
	assert.ok(q.volumeLiquidity5mPercent > 0.5 && q.volumeLiquidity5mPercent < 0.7);
});

test("allows strong current turnover even below the fixed dollar volume floor", () => {
	const q = entryQualitySnapshot({
		liquidityUsd: 100000,
		volume5m: 3000,
		priceChange5m: 2.2,
		priceChange1h: 8,
		buys5m: 30,
		sells5m: 10
	});
	assert.equal(q.activityHealthy, true);
	assert.equal(q.lateMomentum, false);
});

test("allows high dollar participation even when liquidity ratio is below one percent", () => {
	const q = entryQualitySnapshot({
		liquidityUsd: 1500000,
		volume5m: 12000,
		priceChange5m: 2.0,
		priceChange1h: 10,
		buys5m: 40,
		sells5m: 15
	});
	assert.equal(q.activityHealthy, true);
	assert.equal(q.lateMomentum, false);
});
