const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { evaluateCandidate } = require("../geminiFilter");
const { extractTop10Concentration } = require("../geminiSources");
const { createGeminiTrader } = require("../geminiTrader");
const { buildGeminiAnalytics } = require("../geminiAnalytics");

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
  holderConcentration: async () => ({ verified: true, top10Percent: 34.9 }),
  liquidityLock: async () => ({ verified: true, lockedPercent: 100 })
};

test("Gemini accepts only a candidate passing all strict safety checks", async () => {
  const result = await evaluateCandidate(candidate(), safeDeps);
  assert.equal(result.accepted, true);
  assert.equal(result.details.transactions5m, 15);
});
test("Gemini rejects candidates without a strong verified LP lock", async () => {
  const lowLock = await evaluateCandidate(candidate(), {
    ...safeDeps, liquidityLock: async () => ({ verified: true, lockedPercent: 94.99 })
  });
  assert.equal(lowLock.accepted, false);
  assert.equal(lowLock.reason, "Insufficient LP Locked or Burned");
  assert.equal(lowLock.details.minimum, 95);

  const unknownLock = await evaluateCandidate(candidate(), {
    ...safeDeps, liquidityLock: async () => ({ verified: false, reason: "report unavailable" })
  });
  assert.equal(unknownLock.accepted, false);
  assert.equal(unknownLock.reason, "Liquidity Lock Data Unverified");
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
test("RugCheck pool accounts are excluded before summing top holder concentration", () => {
  const topHolders = [{ address: "pool-account", owner: "pool-account", pct: 40 }];
  for (let i = 0; i < 10; i++) topHolders.push({ address: "holder-" + i, owner: "holder-" + i, pct: 4 });
  assert.equal(extractTop10Concentration({ topHolders, knownAccounts: { "pool-account": { name: "AMM Pool", type: "AMM" } } }), 40);
});
test("Gemini can remove an invalid closed paper position and reverse its full realized P&L", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ledger-correction-"));
  try {
    const trader = createGeminiTrader(path.join(dir, "state.json"));
    trader.buy(candidate({ tokenAddress: "FakeMint", symbol: "FAKE" }), 10);
    const positionId = trader.getState().position.id;
    trader.sell(1.2, 95, "TP +15% SELL 95%");
    const falseClose = trader.sell(1000, 5, "MANUAL CLOSE");
    const before = trader.getState().cashUsd;
    const result = trader.removeClosedPosition({ positionId, triggerSellId: falseClose.trade.id, tokenAddress: "FakeMint", symbol: "FAKE", minimumRealizedPnlUsd: 1 });
    assert.equal(result.success, true);
    assert.equal(result.removedRows, 3);
    assert.ok(Math.abs(trader.getState().cashUsd - 200) < 1e-9);
    assert.equal(trader.getState().history.length, 0);
    assert.ok(before > 1000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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


test("Gemini monitor uses GeckoTerminal when DexScreener cannot quote the open position", async () => {
  let position = {
    id: "open-1", tokenAddress: "Mint", pairAddress: "old-pair", symbol: "STUCK",
    entryPrice: 1, quantity: 10, originalQuantity: 10, originalCostUsd: 10,
    amountInvestedUsd: 10, entryTime: new Date(Date.now() - 20 * 60_000).toISOString(),
    highestPrice: 1, remainingPercent: 100
  };
  let fallbackCalls = 0;
  let sold = null;
  const trader = {
    getState: () => ({ position: position && { ...position }, lastScanAt: null }),
    updatePosition: patch => { position = { ...position, ...patch }; },
    sell: (price, percent, reason) => { sold = { price, percent, reason }; return { success: true }; },
    setScanTime() {}, recordRejection() {}
  };
  const fakeTimers = { setInterval: () => 1, clearInterval() {} };
  const bot = require("../geminiBot").createGeminiBot({
    trader, timers: fakeTimers,
    pairDetails: async () => { throw new Error("pair unavailable"); },
    pairFetcher: async () => { throw new Error("token lookup unavailable"); },
    tokenQuoteFallback: async () => { fallbackCalls++; return { priceUsd: 1.25, pairAddress: "live-pair", quoteProvider: "GeckoTerminal" }; },
    poolFetcher: async () => [], profileFetcher: async () => [], filter: async () => ({ accepted: false })
  });
  bot.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  bot.stop();
  assert.equal(fallbackCalls, 1);
  assert.equal(position.pairAddress, "live-pair");
  assert.deepEqual(sold, { price: 1.25, percent: 100, reason: "TP +20% FULL EXIT" });
});
