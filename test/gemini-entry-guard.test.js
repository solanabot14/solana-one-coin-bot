"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "./geminiSources" && parent?.filename?.endsWith("geminiFilter.js"))
    return { getMintSafety: async () => ({ verified: true, mintRevoked: true, freezeDisabled: true }), getHolderConcentration: async () => ({ verified: true, top10Percent: 20 }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { evaluateCandidate } = require("../geminiFilter");
const candidate = priceChange5m => ({ tokenAddress: "mint", liquidityUsd: 10000, poolCreatedAt: new Date(Date.now() - 10*60*1000).toISOString(), buys5m: 20, sells5m: 10, priceChange5m });
const safeDeps = { mintSafety: async () => ({ verified: true, mintRevoked: true, freezeDisabled: true }), holderConcentration: async () => ({ verified: true, top10Percent: 20 }) };
test("rejects a falling five-minute chart", async () => {
  const result = await evaluateCandidate(candidate(-13.42), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "Negative or Flat 5m Momentum");
});
test("fails closed when five-minute trend is unavailable", async () => {
  const result = await evaluateCandidate(candidate(undefined), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "5m Price Trend Unverified");
});
test("allows positive momentum only after existing safety checks pass", async () => {
  const result = await evaluateCandidate(candidate(2.5), safeDeps);
  assert.equal(result.accepted, true);
  assert.equal(result.details.priceChange5m, 2.5);
});
