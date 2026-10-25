const test = require("node:test");
const assert = require("node:assert/strict");
const { status, createGeminiLiveExecution, USDC } = require("../geminiLiveExecution");

test("live execution is paper-only unless both explicit enable and secret exist", async () => {
  assert.equal(status({}).mode, "PAPER_ONLY");
  assert.equal(status({ GEMINI_LIVE_ENABLED: "true" }).hasSigningKey, false);
  const execution = createGeminiLiveExecution({ env: {} });
  await assert.rejects(execution.executeSwap({ inputMint: USDC, outputMint: "mint", amount: 1 }), /disabled/);
});
