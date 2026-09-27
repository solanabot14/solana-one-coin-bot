const { test } = require("node:test");
const assert = require("node:assert/strict");
const { entryDiagnostics, buildRejectionTelemetry } = require("../scanner");

function candidate(overrides = {}) {
	return {
		symbol:"TEST",
		score:9,
		signal:"BUY",
		priceChange5m:1,
		priceChange1h:5,
		buys5m:52,
		sells5m:48,
		discoverySources:["Trending Metas"],
		...overrides
	};
}

test("score 9 BUY explains exact failed confirmation gate", () => {
	const coin = candidate();
	const diagnostics = entryDiagnostics(coin, { score:9, signal:"BUY", reasons:[] });
	assert.deepEqual(diagnostics.blockers, ["BUY_RATIO"]);
	assert.equal(diagnostics.buyRatio, 0.52);
	assert.equal(diagnostics.totalTransactions, 100);
});

test("multiple confirmation failures are counted independently", () => {
	const coin = candidate({
		score:7,
		priceChange5m:0.2,
		priceChange1h:0.4,
		buys5m:8,
		sells5m:7
	});
	coin.entryDiagnostics = entryDiagnostics(coin, { score:7, signal:"BUY", reasons:[] });

	const telemetry = buildRejectionTelemetry([coin]);
	assert.equal(telemetry.notStrongBuy, 1);
	assert.equal(telemetry.scoreBelow8, 1);
	assert.equal(telemetry.fiveMinute, 1);
	assert.equal(telemetry.oneHour, 1);
	assert.equal(telemetry.buyRatio, 1);
	assert.equal(telemetry.transactions, 1);
});

test("anti-chase reason is reported separately from normal confirmation gates", () => {
	const coin = candidate({
		score:0,
		signal:"AVOID",
		priceChange5m:5,
		buys5m:70,
		sells5m:30
	});
	coin.entryDiagnostics = entryDiagnostics(coin, {
		score:0,
		signal:"AVOID",
		reasons:["ANTI-CHASE: 5m move already too high"]
	});

	const telemetry = buildRejectionTelemetry([coin]);
	assert.equal(telemetry.antiChase5m, 1);
	assert.equal(telemetry.fiveMinute, 0);
	assert.equal(telemetry.buyRatio, 0);
});

test("STRONG BUY is not counted as rejected", () => {
	const coin = candidate({ score:10, signal:"STRONG BUY", buys5m:60, sells5m:40 });
	coin.entryDiagnostics = entryDiagnostics(coin, {
		score:10,
		signal:"STRONG BUY",
		reasons:[]
	});

	const telemetry = buildRejectionTelemetry([coin]);
	assert.equal(telemetry.notStrongBuy, 0);
	assert.equal(telemetry.nearEntries.length, 0);
});
