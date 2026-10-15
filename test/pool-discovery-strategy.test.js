const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzePoolCandidate } = require("../poolDiscoveryStrategy");

function candidate(overrides = {}) {
  return {
    liquidityUsd: 25000,
    volume24h: 45000,
    volume5m: 2200,
    buys5m: 10,
    sells5m: 5,
    priceChange5m: 1.2,
    priceChange1h: 6,
    priceChange24h: 12,
    ...overrides
  };
}

test("qualifying active launch signals BUY without V3.1's 20-transaction score penalty", () => {
  const result = analyzePoolCandidate(candidate());
  assert.equal(result.signal, "BUY");
  assert.deepEqual(result.failedGates, []);
});

test("anti-chase limits block extended 5m, 1h, and 24h moves", () => {
  assert.ok(analyzePoolCandidate(candidate({ priceChange5m: 8.1 })).failedGates.includes("5m momentum"));
  assert.ok(analyzePoolCandidate(candidate({ priceChange1h: 40.1 })).failedGates.includes("1h trend"));
  assert.ok(analyzePoolCandidate(candidate({ priceChange24h: 251 })).failedGates.includes("24h anti-chase"));
});

test("weak activity and falling buy flow do not qualify", () => {
  assert.equal(analyzePoolCandidate(candidate({ volume5m: 1499 })).signal, "AVOID");
  assert.equal(analyzePoolCandidate(candidate({ buys5m: 7, sells5m: 6 })).signal, "AVOID");
});

test("missing momentum data does not qualify", () => {
  assert.equal(analyzePoolCandidate(candidate({ priceChange5m: null })).signal, "AVOID");
});

test("missing 1h and 24h price changes do not block an otherwise active fresh launch", () => {
  const result = analyzePoolCandidate(candidate({ priceChange1h: undefined, priceChange24h: undefined }));
  assert.equal(result.signal, "BUY");
});

