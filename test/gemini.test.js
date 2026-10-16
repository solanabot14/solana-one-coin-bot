const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { evaluateCandidate } = require("../geminiFilter");
const { extractTop10Concentration } = require("../geminiSources");
const { createGeminiTrader } = require("../geminiTrader");
const { buildGeminiAnalytics } = require("../geminiAnalytics");
const { getGeminiPositionMark } = require("../geminiDashboard");

function candidate(overrides = {}) {
  return {
    tokenAddress: "Mint111111111111111111111111111111111111111",
    pairAddress: "Pair111111111111111111111111111111111111111",
    symbol: "TEST", priceUsd: 0.01, liquidityUsd: 6000, priceChange5m: 2,
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
test("Gemini dashboard values an open position from an alternate active pool", async () => {
  const entryTime = new Date("2026-10-16T16:00:00.000Z").toISOString();
  let request;
  const mark = await getGeminiPositionMark({
    tokenAddress: "Mint", pairAddress: "SavedPool", quantity: 2,
    amountInvestedUsd: 10, entryTime
  }, async (address, options) => {
    request = { address, options };
    return {
      pairAddress: "ActivePool", priceUsd: "6",
      quoteWarning: "Saved pool unavailable; price uses the most active current pool for this token."
    };
  }, Date.parse(entryTime) + 60_000);

  assert.equal(request.address, "Mint");
  assert.equal(request.options.pairAddress, "SavedPool");
  assert.equal(request.options.allowAlternatePairQuote, true);
  assert.equal(mark.priceUsd, 6);
  assert.equal(mark.currentValueUsd, 12);
  assert.equal(mark.pnl, 2);
  assert.equal(mark.pnlPercent, 20);
  assert.equal(mark.pairAddress, "ActivePool");
  assert.match(mark.quoteWarning, /active pool/);
});
test("Gemini dashboard keeps equity unavailable when no valid market quote exists", async () => {
  const mark = await getGeminiPositionMark({
    tokenAddress: "Mint", pairAddress: "SavedPool", quantity: 2,
    amountInvestedUsd: 10, entryTime: new Date().toISOString()
  }, async () => ({ priceUsd: null }));
  assert.equal(mark, null);
});
test("RugCheck pool accounts are excluded before summing top holder concentration", () => {
  const topHolders = [{ address: "pool-account", owner: "pool-account", pct: 40 }];
  for (let i = 0; i < 10; i++) topHolders.push({ address: "holder-" + i, owner: "holder-" + i, pct: 4 });
  assert.equal(extractTop10Concentration({ topHolders, knownAccounts: { "pool-account": { name: "AMM Pool", type: "AMM" } } }), 40);
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

