const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSlotSimulation } = require("../dashboardData");

function trade(symbol, pnlPercent, index) {
	return {
		symbol,
		pnlPercent,
		entryTime: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
		exitTime: `2026-01-01T00:01:${String(index).padStart(2, "0")}Z`
	};
}

test("slot lab starts with five $2 slots and does not need trading state", () => {
	const sim = buildSlotSimulation([]);
	assert.equal(sim.mode, "SIMULATION_ONLY");
	assert.equal(sim.slotCount, 5);
	assert.equal(sim.startingSlotValue, 2);
	assert.equal(sim.startingCapital, 10);
	assert.equal(sim.totalCapital, 10);
	assert.equal(sim.currentTarget, 10);
	assert.equal(sim.tradesReplayed, 0);
	assert.deepEqual(sim.targets, [10, 50, 100, 150]);
	assert.deepEqual(sim.slots.map(slot => slot.balance), [2, 2, 2, 2, 2]);
});

test("slot lab compounds completed trade returns round-robin", () => {
	const sim = buildSlotSimulation([
		trade("A", 50, 1),
		trade("B", -25, 2),
		trade("C", 100, 3),
		trade("D", 10, 4),
		trade("E", 0, 5),
		trade("F", 50, 6)
	]);
	assert.equal(sim.tradesReplayed, 6);
	assert.ok(Math.abs(sim.slots[0].balance - 4.5) < 1e-10);
	assert.ok(Math.abs(sim.slots[1].balance - 1.5) < 1e-10);
	assert.ok(Math.abs(sim.slots[2].balance - 4) < 1e-10);
	assert.ok(Math.abs(sim.slots[3].balance - 2.2) < 1e-10);
	assert.ok(Math.abs(sim.slots[4].balance - 2) < 1e-10);
	assert.equal(sim.slots[0].trades, 2);
	assert.equal(sim.slots[0].winners, 2);
});

test("target ladder advances only when every slot reaches the milestone", () => {
	const fiveFourHundredPercentWins = Array.from({ length: 5 }, (_, i) =>
		trade(String(i), 400, i + 1)
	);
	const sim = buildSlotSimulation(fiveFourHundredPercentWins);
	assert.equal(sim.currentTarget, 50);
	assert.deepEqual(sim.completedTargets, [10]);
	assert.ok(sim.slots.every(slot => Math.abs(slot.balance - 10) < 1e-10));
});
