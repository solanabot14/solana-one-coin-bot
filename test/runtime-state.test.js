const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeState } = require("../runtimeState");

test("first migration defaults to running so deployment does not silently stop the bot", t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-"));
	t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
	const state = createRuntimeState(path.join(dir, "runtimeState.json"));
	assert.deepEqual(state.read(), { desiredRunning:true, initialized:false });
});

test("main STOP choice persists across process restarts", t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-stop-"));
	t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
	const file = path.join(dir, "runtimeState.json");

	createRuntimeState(file).setStopped();
	const restored = createRuntimeState(file).read();

	assert.equal(restored.desiredRunning, false);
	assert.equal(restored.initialized, true);
});

test("main START choice persists across process restarts", t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-start-"));
	t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
	const file = path.join(dir, "runtimeState.json");

	createRuntimeState(file).setRunning();
	const restored = createRuntimeState(file).read();

	assert.equal(restored.desiredRunning, true);
	assert.equal(restored.initialized, true);
});
