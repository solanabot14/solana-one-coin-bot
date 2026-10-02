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
		buys5m: 12,
		sells5m: 8,
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

function rig(history, candidates) {
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
		getTokenData: async () => null, notifier });
	return { bot, state, timers };
}

test("a losing pair is skipped while another qualified pair fills the open slot", async t => {
	const { bot, state } = rig(closedLoss("repeat"), [strongBuy("repeat"), strongBuy("fresh")]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["fresh"]);
});

test("an early re-entry requires two consecutive cooled and improving scans", async t => {
	const candidate = strongBuy("repeat");
	const { bot, state, timers } = rig(closedLoss("repeat"), [candidate]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.equal(state.positions.length, 0);

	candidate.priceChange5m = 1.2;
	await timers.run(120000);
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["repeat"]);
});

test("a hard stop uses the longer cooldown", async t => {
	const hardStopHistory = closedLoss("repeat", { minutesAgo: 120, reason: "HARD STOP", id: "hard-stop" });
	const { bot, state } = rig(hardStopHistory, [strongBuy("repeat"), strongBuy("fresh")]);
	t.after(() => bot.stopBot());
	bot.startBot();
	await settle();
	assert.deepEqual(state.positions.map(position => position.tokenAddress), ["fresh"]);
});

test("two losing closes in 24 hours use the longer cooldown", async t => {
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
