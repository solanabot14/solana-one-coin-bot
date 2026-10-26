const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
const sampleBytes = Uint8Array.from({ length: 64 }, (_, index) => index);
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.endsWith("geminiLiveExecution.js") && request === "@solana/web3.js") {
    return { Keypair: {
      fromSecretKey: bytes => ({ publicKey: { toBase58: () => Buffer.from(bytes).toString("hex") } }),
      fromSeed: bytes => ({ publicKey: { toBase58: () => Buffer.from(bytes).toString("hex") } })
    }};
  }
  if (parent?.filename?.endsWith("geminiLiveExecution.js") && request === "bs58") {
    return { decode: value => {
      if (value === "valid-base58-key") return sampleBytes;
      throw new Error("Non-base58 character");
    }};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { status, signerFromSecret, createGeminiLiveExecution, USDC } = require("../geminiLiveExecution");
test.after(() => { Module._load = originalLoad; });

test("live execution is paper-only unless both explicit enable and secret exist", async () => {
  assert.equal(status({}).mode, "PAPER_ONLY");
  assert.equal(status({ GEMINI_LIVE_ENABLED: "true" }).hasSigningKey, false);
  const execution = createGeminiLiveExecution({ env: {} });
  await assert.rejects(execution.executeSwap({ inputMint: USDC, outputMint: "mint", amount: 1 }), /disabled/);
});
test("live signer accepts Solana JSON, hex, base58, JSON-quoted base58, and base64 secret formats", () => {
  const expected = Buffer.from(sampleBytes).toString("hex");
  const base64 = Buffer.from(sampleBytes).toString("base64");
  for (const secret of [JSON.stringify(Array.from(sampleBytes)), expected, "0x" + expected, "valid-base58-key", JSON.stringify("valid-base58-key"), "valid-base58-\nkey", base64])
    assert.equal(signerFromSecret(secret).publicKey.toBase58(), expected);
});
