const { test } = require("node:test");
const assert = require("node:assert/strict");
const { postPumpSnapshot, normalizeSmartMoneyItem } = require("../scanner");
const { createPaperTrader } = require("../paperTrader");

test("post-pump guard waits for history then detects a multi-scan extension", () => {
	const token = "POSTPUMP_TEST_" + Date.now();
	const start = 1_000_000;
	const first = postPumpSnapshot(token, 1.00, start);
	const second = postPumpSnapshot(token, 1.03, start + 2 * 60 * 1000);
	const third = postPumpSnapshot(token, 1.07, start + 4 * 60 * 1000);

	assert.equal(first.blocked, false);
	assert.equal(second.blocked, false);
	assert.equal(third.enoughHistory, true);
	assert.ok(third.extensionPercent >= 6);
	assert.equal(third.blocked, true);
});

test("normalizes Birdeye smart-money token fields", () => {
	const item = normalizeSmartMoneyItem({
		token: "ABC",
		net_flow: 12000,
		smart_traders_no: 7,
		volume_buy_usd: 30000,
		volume_sell_usd: 18000
	});
	assert.deepEqual(item, {
		tokenAddress: "ABC",
		netFlow: 12000,
		smartTraders: 7,
		buyVolumeUsd: 30000,
		sellVolumeUsd: 18000
	});
});

test("paper BUY persists exact current-activity entry snapshot", () => {
	let stored = null;
	const io = {
		existsSync: () => false,
		mkdirSync: () => {},
		writeFileSync: (_path, value) => { stored = String(value); },
		renameSync: () => {},
		unlinkSync: () => {}
	};
	const trader = createPaperTrader("/tmp/activity-snapshot-test.json", io);
	const result = trader.buy({
		symbol: "TEST",
		name: "Test",
		tokenAddress: "TOKEN",
		pairAddress: "PAIR",
		priceUsd: 1,
		score: 10,
		signal: "STRONG BUY",
		priceChange5m: 1.2,
		priceChange1h: 4.5,
		priceChange24h: 9,
		liquidityUsd: 200000,
		volume5m: 15000,
		volume1h: 90000,
		volume24h: 700000,
		buys5m: 30,
		sells5m: 10,
		discoverySources: ["Birdeye Trending 1H"],
		currentActivity: { volume5m: 15000, volumeLiquidity5mPercent: 7.5, transactions5m: 40, buyRatio5m: 0.75 },
		postPump: { extensionPercent: 2.4, observations: 4, blocked: false },
		smartMoney: { netFlow: 25000, smartTraders: 6, buyVolumeUsd: 40000, sellVolumeUsd: 15000 }
	});

	assert.equal(result.success, true);
	assert.equal(result.trade.entryVolume5m, 15000);
	assert.equal(result.trade.entryVolume1h, 90000);
	assert.deepEqual(result.trade.entryDiscoverySources, ["Birdeye Trending 1H"]);
	assert.equal(result.trade.entryPostPump.extensionPercent, 2.4);
	assert.equal(result.trade.entrySmartMoney.smartTraders, 6);
	assert.ok(stored);
});
