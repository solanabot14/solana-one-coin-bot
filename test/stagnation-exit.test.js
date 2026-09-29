const { test } = require("node:test");
const assert = require("node:assert/strict");
const { shouldStagnationExit } = require("../bot");

const entryTime = "2026-09-29T08:00:00.000Z";
const now = Date.parse("2026-09-29T09:31:00.000Z");

function position(overrides = {}) {
	return {
		strategyVersion: "V5.9",
		firstTakeProfitDone: false,
		secondTakeProfitDone: false,
		entryTime,
		...overrides
	};
}

test("V5.9 exits a weak stagnant position after 90 minutes", () => {
	assert.equal(
		shouldStagnationExit(position(), {
			profitPercent: 1.5,
			highestProfitPercent: 4.5,
			momentum5m: 0.1,
			now
		}),
		true
	);
});

test("V5.9 does not cut a position that has shown runner strength", () => {
	assert.equal(
		shouldStagnationExit(position(), {
			profitPercent: 2,
			highestProfitPercent: 10.5,
			momentum5m: 0,
			now
		}),
		false
	);
});

test("V5.9 does not cut before 90 minutes", () => {
	assert.equal(
		shouldStagnationExit(position(), {
			profitPercent: -1,
			highestProfitPercent: 2,
			momentum5m: -0.2,
			now: Date.parse("2026-09-29T09:20:00.000Z")
		}),
		false
	);
});

test("V5.9 does not cut a position with live positive 5m momentum", () => {
	assert.equal(
		shouldStagnationExit(position(), {
			profitPercent: 2,
			highestProfitPercent: 4,
			momentum5m: 1.2,
			now
		}),
		false
	);
});

test("stagnation exit does not retroactively apply to older strategy versions", () => {
	assert.equal(
		shouldStagnationExit(position({ strategyVersion: "V5.7" }), {
			profitPercent: 0,
			highestProfitPercent: 1,
			momentum5m: 0,
			now
		}),
		false
	);
});
