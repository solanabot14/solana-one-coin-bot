const { test } = require("node:test");
const assert = require("node:assert/strict");
const { failedStructureSnapshot } = require("../scanner");

function candle(time, low, high, close = high) {
	return { unixTime: time, o: close, h: high, l: low, c: close, v: 1000 };
}

test("blocks JEANPHIL-like pump dump partial rebound structure", () => {
	const now = 2_000_000;
	const candles = [];
	for (let i = 0; i < 12; i++) {
		const low = 0.0035 + i * 0.00003;
		const high = low + 0.00008;
		candles.push(candle(now - (29 - i) * 60, low, high));
	}
	candles.push(candle(now - 17 * 60, 0.0041, 0.0045, 0.00435));
	candles.push(candle(now - 16 * 60, 0.0040, 0.0043, 0.0041));
	candles.push(candle(now - 15 * 60, 0.00385, 0.0041, 0.0039));
	candles.push(candle(now - 14 * 60, 0.00365, 0.00395, 0.0037));
	for (let i = 13; i >= 0; i--) {
		candles.push(candle(now - i * 60, 0.00368, 0.00390, 0.003832));
	}

	const snapshot = failedStructureSnapshot(candles, 0.003832, now);

	assert.equal(snapshot.status, "OK");
	assert.ok(snapshot.runupPercent >= 8);
	assert.ok(snapshot.drawdownPercent >= 10);
	assert.ok(snapshot.reboundPercent >= 2 && snapshot.reboundPercent <= 8);
	assert.ok(snapshot.belowPeakPercent >= 6);
	assert.equal(snapshot.blocked, true);
});

test("does not block a healthy breakout without a major post-peak dump", () => {
	const now = 2_000_000;
	const candles = Array.from({ length: 30 }, (_, i) => {
		const base = 0.0035 + i * 0.00002;
		return candle(now - (29 - i) * 60, base, base + 0.00005, base + 0.00004);
	});

	const snapshot = failedStructureSnapshot(candles, 0.0041, now);
	assert.equal(snapshot.blocked, false);
});

test("does not block when rebound has already recovered beyond the partial-bounce zone", () => {
	const now = 2_000_000;
	const candles = [];
	for (let i = 0; i < 12; i++) candles.push(candle(now - (29 - i) * 60, 0.0035, 0.0037));
	candles.push(candle(now - 17 * 60, 0.0041, 0.0045, 0.0044));
	candles.push(candle(now - 16 * 60, 0.00365, 0.0040, 0.0037));
	for (let i = 15; i >= 0; i--) candles.push(candle(now - i * 60, 0.0037, 0.0042, 0.00415));

	const snapshot = failedStructureSnapshot(candles, 0.00415, now);
	assert.ok(snapshot.reboundPercent > 8);
	assert.equal(snapshot.blocked, false);
});
