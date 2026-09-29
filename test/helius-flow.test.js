const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarizeHeliusTransactions, isParsedSwap } = require("../heliusFlow");

test("Helius flow counts recent swaps and unique fee payers", () => {
	const now = 2000000000;
	const txs = [
		{ timestamp: now - 10, type: "SWAP", feePayer: "A" },
		{ timestamp: now - 20, type: "SWAP", feePayer: "B" },
		{ timestamp: now - 30, type: "SWAP", feePayer: "A" },
		{ timestamp: now - 40, type: "TRANSFER", feePayer: "C" },
		{ timestamp: now - 400, type: "SWAP", feePayer: "D" }
	];
	const flow = summarizeHeliusTransactions(txs, now);
	assert.equal(flow.status, "OK");
	assert.equal(flow.swapsLast5m, 3);
	assert.equal(flow.uniqueMakers5m, 2);
	assert.ok(Math.abs(flow.uniqueMakerRatio - 2 / 3) < 1e-12);
});

test("Helius flow handles an empty sample", () => {
	const flow = summarizeHeliusTransactions([], 2000000000);
	assert.equal(flow.swapsLast5m, 0);
	assert.equal(flow.uniqueMakers5m, 0);
	assert.equal(flow.uniqueMakerRatio, 0);
});


test("Helius flow recognizes parsed swap events even when type is not SWAP", () => {
	const now = 2000000000;
	const txs = [
		{ timestamp: now - 10, type: "UNKNOWN", feePayer: "A", events: { swap: { nativeInput: {} } } },
		{ timestamp: now - 20, type: "TRANSFER", feePayer: "B" }
	];
	const flow = summarizeHeliusTransactions(txs, now);
	assert.equal(isParsedSwap(txs[0]), true);
	assert.equal(flow.swapsLast5m, 1);
	assert.equal(flow.uniqueMakers5m, 1);
});
