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
const candidate = (priceChange5m, overrides = {}) => ({ tokenAddress: "mint", dexId: "pumpswap", liquidityUsd: 10000, poolCreatedAt: new Date(Date.now() - 20*60*1000).toISOString(), buys5m: 20, sells5m: 10, volume5m: 6000, priceChange5m, ...overrides });
const safeDeps = { mintSafety: async () => ({ verified: true, mintRevoked: true, freezeDisabled: true }), holderConcentration: async () => ({ verified: true, top10Percent: 20 }) };
test("rejects a falling five-minute chart", async () => {
  const result = await evaluateCandidate(candidate(-13.42), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "5m Momentum Below +2%");
});
test("fails closed when five-minute trend is unavailable", async () => {
  const result = await evaluateCandidate(candidate(undefined), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "5m Price Trend Unverified");
});
test("allows confirmed +2% five-minute momentum only after existing safety checks pass", async () => {
  const result = await evaluateCandidate(candidate(2), safeDeps);
  assert.equal(result.accepted, true);
  assert.equal(result.details.priceChange5m, 2);
});
test("rejects pools that are not verified PumpSwap graduations", async () => {
  const result = await evaluateCandidate({ ...candidate(2.5), dexId: "raydium" }, safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "Not a PumpSwap Graduation");
});
test("accepts strong momentum without an arbitrary upper cap", async () => {
  const result = await evaluateCandidate(candidate(30), safeDeps);
  assert.equal(result.accepted, true);
});
test("rejects a PumpSwap graduation younger than 15 minutes", async () => {
  const result = await evaluateCandidate(candidate(3, { poolCreatedAt: new Date(Date.now() - 14*60*1000).toISOString() }), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "Pool Age Outside 15–45 Minutes");
});
test("requires more buys than sells and more than 55% buying pressure", async () => {
  const result = await evaluateCandidate(candidate(3, { buys5m: 16, sells5m: 14 }), safeDeps);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "Buy Pressure Not Above 55%");
});
