const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mapWithConcurrency } = require("../scanner");

test("bounded scanner concurrency never exceeds configured worker count", async () => {
	let active = 0;
	let maxActive = 0;
	const started = [];

	const result = await mapWithConcurrency(
		Array.from({ length: 12 }, (_, index) => index),
		4,
		async value => {
			started.push(value);
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--;
			return value * 2;
		}
	);

	assert.equal(started.length, 12);
	assert.ok(maxActive > 1);
	assert.ok(maxActive <= 4);
	assert.deepEqual(result, Array.from({ length: 12 }, (_, index) => index * 2));
});

test("scanner concurrency preserves result positions", async () => {
	const result = await mapWithConcurrency(
		[40, 10, 30, 20],
		3,
		async value => {
			await new Promise(resolve => setTimeout(resolve, value / 10));
			return value;
		}
	);

	assert.deepEqual(result, [40, 10, 30, 20]);
});

test("aborted concurrent scanner stops taking new work", async () => {
	const controller = new AbortController();
	let calls = 0;

	await mapWithConcurrency(
		Array.from({ length: 20 }, (_, index) => index),
		3,
		async value => {
			calls++;
			if (value === 0) controller.abort();
			await new Promise(resolve => setTimeout(resolve, 1));
			return value;
		},
		controller.signal
	);

	assert.ok(calls <= 3);
});
