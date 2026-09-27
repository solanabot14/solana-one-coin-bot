const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	preDiscoveryPumpSnapshot,
	birdeyeOhlcvItems,
	normalizeBirdeyeCandle
} = require("../scanner");

function candles(now, { low, high, close, count = 31 }) {
	return Array.from({ length: count }, (_, index) => ({
		unixTime: now - (count - 1 - index) * 60,
		o: close,
		h: high,
		l: low,
		c: close,
		v: 1000 + index
	}));
}

test("blocks ANT FUN-like pre-discovery pump after current 5m momentum cools", () => {
	const now = 2000000;
	const snapshot = preDiscoveryPumpSnapshot(
		candles(now, { low: 0.0114, high: 0.01376, close: 0.0131 }),
		0.0131,
		0.97,
		now
	);

	assert.equal(snapshot.enoughHistory, true);
	assert.equal(snapshot.extended, true);
	assert.equal(snapshot.nearRecentHigh, true);
	assert.equal(snapshot.cooled5m, true);
	assert.equal(snapshot.blocked, true);
	assert.ok(snapshot.window15m.extensionPercent > 8);
	assert.ok(snapshot.window15m.retracePercent < 6);
});

test("does not block an actively accelerating runner solely because it is extended", () => {
	const now = 2000000;
	const snapshot = preDiscoveryPumpSnapshot(
		candles(now, { low: 0.0114, high: 0.01376, close: 0.0131 }),
		0.0131,
		3.2,
		now
	);

	assert.equal(snapshot.extended, true);
	assert.equal(snapshot.cooled5m, false);
	assert.equal(snapshot.blocked, false);
});

test("does not block a token without meaningful recent extension", () => {
	const now = 2000000;
	const snapshot = preDiscoveryPumpSnapshot(
		candles(now, { low: 0.0128, high: 0.0132, close: 0.0131 }),
		0.0131,
		1.1,
		now
	);

	assert.equal(snapshot.extended, false);
	assert.equal(snapshot.blocked, false);
});

test("normalizes Birdeye OHLCV item shapes", () => {
	const payload = { data: { items: [{ unixTime: 123, o: 1, h: 2, l: 0.5, c: 1.5, v: 900 }] } };
	const items = birdeyeOhlcvItems(payload);
	assert.equal(items.length, 1);
	assert.deepEqual(normalizeBirdeyeCandle(items[0]), {
		time: 123,
		open: 1,
		high: 2,
		low: 0.5,
		close: 1.5,
		volume: 900
	});
});
