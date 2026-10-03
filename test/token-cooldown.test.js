const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBot } = require("../bot");

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
	let next = 0;
	const callbacks = new Map();
	return {
		callbacks,
		setInterval(fn, ms) { callbacks.set(++next, { fn, ms }); return next; },
		clearInterval(id) { callbacks.delete(id); },
		async run(ms) {
			await Promise.all([...callbacks.values()].filter(timer => timer.ms === ms).map(timer => timer.fn()));
		}
	};
}

function strongBuy(tokenAddress, changes = {}) {
	return {
		tokenAddress,
		symbol: tokenAddress,
		name: tokenAddress,
		priceUsd: 1,
		signal: "STRONG BUY",
		score: 10,
		priceChange5m: 1,
		priceChange1h: 5,
		liquidityUsd: 60000,
		volume5m: 6000,
		buys5m: 18,
		sells5m: 12,
		...changes
	};
}

function closedLoss(tokenAddress, { minutesAgo = 30, reason = "MOMENTUM EXIT", id = "old-position" } = {}) {
	const exitTime = new Date(Date.now() - minutesAgo * 60000).toISOString();
	return [
		{ type: "BUY", positionId: id, tokenAddress, entryTime: exitTime },
		{ type: "SELL", positionId: id, tokenAddress, entryTime: exitTime,
			exitTime, amountInvested: 10, saleValue: 9, pnl: -1, percentSold: 100, reason }
	];
}

function rig(history, candidates, checkLiquidityLock = async () => ({ allowed: true, lockedPercent: 95 })) {
	const state = { startingBalance: 100, cashBalance: 100, positions: [], history: structuredClone(history) };
	let nextPosition = 0;
	const trader = {
		buy(coin) {
			const position = { id: `new-${++nextPosition}`, tokenAddress: coin.tokenAddress, symbol: coin.symbol };
			state.positions.push(position);
			const trade = { type: "BUY", positionId: position.id, ...position };
			state.history.push(trade);
			return { success: true, trade };
		},
		sell() { throw new Error("Unexpected sale in cooldown test."); },
		updateHigh() { return true; },
		positionKey(position) { return position.id; },
		getPortfolio() { return structuredClone(state); }
	};
	const timers = fakeTimers();
	const notifier = { notifyTrade: async () => {}, notifyCritical: async () => {} };
	const bot = createBot({ trader, timers, discoverCandidates: async () => candidates,
		getTokenData: async () => null, notifier, checkLiquidityLock });
	return { bot, state, timers };
}

test("an unlocked pool cannot be bought even when its signal is STRONG BUY", async t => {
	const { bot, state } = rig([], [strongBuy("unsafe")],
		async () => ({ allowed: false, lockedPercent: 0, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" }));
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.equal(state.positions.length, 0);
});

test("a losing token is skipped while a different qualified token can fill the open slot", async t => {
	const { bot, state } = rig(closedLoss("repeat"), [strongBuy("repeat"), strongBuy("fresh")]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["fresh"]);
});

test("a loss lock cannot be bypassed before the existing cooldown expires", async t => {
	const repeatedCoin = strongBuy("repeat");
	const { bot, state, timers } = rig(closedLoss("repeat", { minutesAgo: 30 }), [repeatedCoin]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	await timers.run(120000);
	await settle();
	assert.equal(state.positions.length, 0);
});

test("a losing token re-enters only after two confirmed high-volume scans", async t => {
	const repeatedCoin = strongBuy("repeat");
	const { bot, state, timers } = rig(closedLoss("repeat", { minutesAgo: 120 }), [repeatedCoin]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.equal(state.positions.length, 0);
	await timers.run(120000);
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["repeat"]);
});

test("both the absolute and liquidity-relative volume thresholds are required", async t => {
	const belowAbsolute = strongBuy("below-absolute", { liquidityUsd: 30000, volume5m: 4999 });
	const belowRelative = strongBuy("below-relative", { liquidityUsd: 60000, volume5m: 5999 });
	const { bot, state, timers } = rig(
		[...closedLoss("below-absolute", { minutesAgo: 120 }), ...closedLoss("below-relative", { minutesAgo: 120, id: "other" })],
		[belowAbsolute, belowRelative]
	);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	await timers.run(120000);
	await settle();
	assert.equal(state.positions.length, 0);
});

test("a hard stop keeps the longer cooldown and still requires a high-volume breakout", async t => {
	const hardStopHistory = closedLoss("repeat", { minutesAgo: 120, reason: "HARD STOP", id: "hard-stop" });
	const { bot, state } = rig(hardStopHistory, [strongBuy("repeat"), strongBuy("fresh")]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["fresh"]);
});

test("two recent losing closes keep the longer cooldown and volume gate", async t => {
	const history = [
		...closedLoss("repeat", { minutesAgo: 180, id: "first-loss" }),
		...closedLoss("repeat", { minutesAgo: 90, id: "second-loss" })
	];
	const { bot, state } = rig(history, [strongBuy("repeat"), strongBuy("fresh")]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["fresh"]);
});
