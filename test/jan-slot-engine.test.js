const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJanSlotEngine } = require("../janSlotEngine");

function completedTrade(id, symbol, pnlPercent) {
	return {
		positionId: id,
		symbol,
		pnlPercent,
		entryTime: "2026-01-01T00:00:00Z",
		exitTime: "2026-01-01T00:01:00Z"
	};
}

function engineForTest(t, { slotCount = 2, startingSlotValue = 2, targets = [10, 50, 100, 150] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jan-slots-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messages = [];
	const engine = createJanSlotEngine({
		dataFile: path.join(dir, "janSlotData.json"),
		config: { slotCount, startingSlotValue, targets },
		notifier: async message => { messages.push(message); return { sent: true }; }
	});
	return { engine, messages, file: path.join(dir, "janSlotData.json") };
}

test("slots compound independently and persist separately from the original bot", async t => {
	const { engine, file } = engineForTest(t);
	const original = { cashBalance: 100, history: [{ untouched: true }] };
	const before = JSON.stringify(original);

	await engine.applyCompletedTrade(completedTrade("a", "A", 400));
	await engine.applyCompletedTrade(completedTrade("b", "B", 50));

	const state = engine.getDashboardState();
	assert.equal(JSON.stringify(original), before);
	assert.equal(state.slots[0].balance, 10);
	assert.equal(state.slots[0].currentTarget, 50);
	assert.equal(state.slots[1].balance, 3);
	assert.equal(state.slots[1].currentTarget, 10);
	assert.ok(fs.existsSync(file));
});

test("each slot sends its own milestone notification exactly once", async t => {
	const { engine, messages } = engineForTest(t);

	await engine.applyCompletedTrade(completedTrade("a", "A", 400));
	assert.equal(messages.length, 1);
	assert.match(messages[0], /Slot: 1/);
	assert.match(messages[0], /Reached: \$10\.00/);

	await engine.applyCompletedTrade(completedTrade("a", "A", 400));
	assert.equal(messages.length, 1);

	await engine.applyCompletedTrade(completedTrade("b", "B", 400));
	assert.equal(messages.length, 2);
	assert.match(messages[1], /Slot: 2/);
});

test("a slot can advance through multiple scalable milestones independently", async t => {
	const { engine, messages } = engineForTest(t, { slotCount: 1 });

	await engine.applyCompletedTrade(completedTrade("a", "A", 4900));
	let state = engine.getDashboardState();
	assert.equal(state.slots[0].balance, 100);
	assert.deepEqual(state.slots[0].milestonesReached, [10, 50, 100]);
	assert.equal(state.slots[0].currentTarget, 150);
	assert.equal(messages.length, 3);

	await engine.applyCompletedTrade(completedTrade("b", "B", 50));
	state = engine.getDashboardState();
	assert.equal(state.slots[0].balance, 150);
	assert.deepEqual(state.slots[0].milestonesReached, [10, 50, 100, 150]);
	assert.equal(state.slots[0].currentTarget, null);
	assert.equal(state.slots[0].allTargetsComplete, true);
	assert.equal(messages.length, 4);
});

test("bootstrap can backfill history without sending old milestone alerts", async t => {
	const { engine, messages } = engineForTest(t, { slotCount: 1 });
	const portfolio = {
		position: null,
		history: [
			{ type: "BUY", id: "p1", positionId: "p1", symbol: "A", tokenAddress: "token-a", entryTime: "2026-01-01T00:00:00Z", entryPrice: 1, quantity: 10, amountInvested: 10 },
			{ type: "SELL", positionId: "p1", symbol: "A", tokenAddress: "token-a", entryTime: "2026-01-01T00:00:00Z", exitTime: "2026-01-01T00:01:00Z", entryPrice: 1, exitPrice: 5, quantitySold: 10, percentSold: 100, amountInvested: 10, saleValue: 50, pnl: 40 }
		]
	};
	await engine.initializeFromPortfolio(portfolio);
	assert.equal(messages.length, 0);
	assert.equal(engine.getDashboardState().slots[0].balance, 10);
});
