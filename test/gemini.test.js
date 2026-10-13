const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { evaluateCandidate } = require("../geminiFilter");
const { createGeminiTrader } = require("../geminiTrader");
const { buildGeminiAnalytics } = require("../geminiAnalytics");

function candidate(overrides = {}) {
  return {
    tokenAddress: "Mint111111111111111111111111111111111111111",
    pairAddress: "Pair111111111111111111111111111111111111111",
    symbol: "TEST", priceUsd: 0.01, liquidityUsd: 6000,
    poolCreatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    buys5m: 10, sells5m: 5,
    ...overrides
  };
}
const safeDeps = {
  mintSafety: async () => ({ verified: true, mintRevoked: true, freezeDisabled: true }),
  holderConcentration: async () => ({ verified: true, top10Percent: 34.9 })
};

test("Gemini accepts only a candidate passing all strict safety checks", async () => {
  const result = await evaluateCandidate(candidate(), safeDeps);
  assert.equal(result.accepted, true);
  assert.equal(result.details.transactions5m, 15);
});
test("Gemini rejects missing authority evidence and excessive holder concentration", async () => {
  assert.equal((await evaluateCandidate(candidate(), { ...safeDeps, mintSafety: async () => ({ verified: false }) })).accepted, false);
  const holders = await evaluateCandidate(candidate(), { ...safeDeps, holderConcentration: async () => ({ verified: true, top10Percent: 35 }) });
  assert.equal(holders.reason, "Top 10 Concentration At or Above 35%");
});
test("Gemini analytics count partial fills as one completed position", () => {
  const now = new Date().toISOString();
  const state = {
    startingBalanceUsd: 200, cashUsd: 210, position: null, rejections: [],
    history: [
      { type: "SELL", positionId: "p1", symbol: "TEST", quantity: 5, amountUsd: 7.5, costBasisUsd: 5, pnlUsd: 2.5, pnlPercent: 50, entryPrice: 1, exitPrice: 1.5, maxGainPercent: 55, entryTime: now, time: now, reason: "TP1" },
      { type: "SELL", positionId: "p1", symbol: "TEST", quantity: 5, amountUsd: 5, costBasisUsd: 5, pnlUsd: 0, pnlPercent: 0, entryPrice: 1, exitPrice: 1, maxGainPercent: 55, entryTime: now, time: now, reason: "TRAIL" },
      { type: "BUY", positionId: "p1", symbol: "TEST", tokenAddress: "Mint", pairAddress: "Pair", quantity: 10, entryPrice: 1, amountUsd: 10, time: now }
    ]
  };
  const result = buildGeminiAnalytics(state);
  assert.equal(result.stats.completedTrades, 1);
  assert.equal(result.stats.winners, 1);
  assert.equal(result.completedTrades[0].pnlUsd, 2.5);
  assert.equal(result.completedTrades[0].returnPercent, 25);
});
test("Gemini paper sells allocate 50%, then 30%, leaving 20% runner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  try {
    const trader = createGeminiTrader(path.join(dir, "state.json"));
    trader.buy(candidate(), 10);
    trader.sell(0.015, 50, "TP1 +50%");
    trader.sell(0.02, 30, "TP2 +100%");
    const state = trader.getState();
    assert.equal(state.position.remainingPercent, 20);
    assert.equal(state.position.tp1Done, true);
    assert.equal(state.position.tp2Done, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
