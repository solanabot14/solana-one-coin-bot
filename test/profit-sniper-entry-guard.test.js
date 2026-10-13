const test = require("node:test");
const assert = require("node:assert/strict");
const { createSniperEntryGuard, hasCatastrophicLoss, evaluatePoolReport } = require("../profitSniperEntryGuard");

const start = 1_800_000_000_000;
const candidate = {
  chainId: "solana", tokenAddress: "mint-A", pairAddress: "pool-A", symbol: "A", signal: "BUY",
  pairCreatedAt: start - 5 * 60_000, priceUsd: 1, liquidityUsd: 25_000,
  volume24h: 30_000, volume5m: 2_000, priceChange5m: 2, buys5m: 8, sells5m: 4,
  reasons: []
};
const pair = {
  chainId: "solana", pairAddress: "pool-A", baseToken: { address: "mint-A" },
  pairCreatedAt: candidate.pairCreatedAt, priceUsd: "1", liquidity: { usd: 25_000 },
  volume: { m5: 2_000, h24: 30_000 }, priceChange: { m5: 2 },
  txns: { m5: { buys: 8, sells: 4 } }
};
const report = {
  mint: "mint-A", rugged: false, risks: [],
  markets: [{ pubkey: "pool-A", lp: { baseUSD: 12_500, quoteUSD: 12_500,
    lpLockedPct: 100, lpLockedUSD: 25_000 } }]
};

function rig({ freshPair = pair, freshReport = report } = {}) {
  let now = start;
  const guard = createSniperEntryGuard({ clock: () => now,
    fetchPair: async () => [freshPair], fetchReport: async () => freshReport });
  return { guard, advance: ms => { now += ms; }, portfolio: { history: [] } };
}

test("requires three observations over time and resets after liquidity falls", () => {
  const { guard, advance } = rig();
  assert.equal(guard.observe(candidate).ready, false);
  advance(30_000);
  assert.equal(guard.observe(candidate).ready, false);
  advance(30_000);
  assert.equal(guard.observe(candidate).ready, true);
  advance(30_000);
  assert.equal(guard.observe({ ...candidate, liquidityUsd: 20_000 }).ready, false);
});

test("fresh exact-pool quote and pool-specific reserve are required immediately before buying", async () => {
  const { guard, advance, portfolio } = rig();
  guard.observe(candidate);
  advance(30_000); guard.observe(candidate);
  advance(30_000); guard.observe(candidate);
  const valid = await guard.validate(candidate, { portfolio });
  assert.equal(valid.allowed, true);
  assert.equal(valid.coin.pairAddress, "pool-A");
  assert.equal(valid.coin.tokenAddress, "mint-A");

  const drained = rig({ freshPair: { ...pair, liquidity: { usd: 0.50 } } });
  drained.guard.observe(candidate); drained.advance(30_000); drained.guard.observe(candidate);
  drained.advance(30_000); drained.guard.observe(candidate);
  assert.equal((await drained.guard.validate(candidate, { portfolio })).allowed, false);

  const wrongMint = rig({ freshPair: { ...pair, baseToken: { address: "mint-B" } } });
  wrongMint.guard.observe(candidate); wrongMint.advance(30_000); wrongMint.guard.observe(candidate);
  wrongMint.advance(30_000); wrongMint.guard.observe(candidate);
  assert.match((await wrongMint.guard.validate(candidate, { portfolio })).reason, /exact pool and mint/);
});

test("rejects an unrelated RugCheck market, low reserve, and concentrated ownership", () => {
  assert.match(evaluatePoolReport({ ...report, markets: [{ ...report.markets[0], pubkey: "pool-B" }] }, candidate, 25_000), /exact pool/);
  assert.match(evaluatePoolReport({ ...report, markets: [{ pubkey: "pool-A", lp: { baseUSD: 0.25, quoteUSD: 0.25, lpLockedPct: 100, lpLockedUSD: 0.5 } }] }, candidate, 25_000), /reserve/);
  assert.match(evaluatePoolReport({ ...report, risks: [{ name: "Single holder ownership" }] }, candidate, 25_000), /ownership/);
});

test("blocks repeat entries after a write-off or price collapse", () => {
  assert.equal(hasCatastrophicLoss([{ type: "SELL", tokenAddress: "mint-A", reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" }], "mint-A"), true);
  assert.equal(hasCatastrophicLoss([{ type: "SELL", tokenAddress: "mint-A", entryPrice: 1, exitPrice: 0.2 }], "mint-A"), true);
  assert.equal(hasCatastrophicLoss([{ type: "SELL", tokenAddress: "mint-B", entryPrice: 1, exitPrice: 0.2 }], "mint-A"), false);
});

test("bot waits for the last entry recheck and uses its fresh quote", async () => {
  const { createBot } = require("../bot");
  const buys = [];
  const trader = {
    buy: coin => { buys.push(coin); return { success: true, trade: { type: "BUY" } }; },
    sell: () => ({ success: false }), updateHigh: () => true,
    positionKey: position => position.id,
    getPortfolio: () => ({ cashBalance: 100, positions: [], history: [] })
  };
  const bot = createBot({ trader, discoverCandidates: async () => [candidate],
    validateEntry: async () => ({ allowed: false, reason: "pool drained" }),
    requireLiquidityLock: false, acceptedSignals: ["BUY"],
    minimumLiquidityUsd: 15_000, minimumVolume24hUsd: 5_000,
    timers: { setInterval: () => 1, clearInterval: () => {} },
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} },
    reentryStateFile: null });
  bot.startBot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buys.length, 0);
  bot.stopBot();

  const approved = createBot({ trader, discoverCandidates: async () => [candidate],
    validateEntry: async coin => ({ allowed: true, coin: { ...coin, priceUsd: 1.01 } }),
    requireLiquidityLock: false, acceptedSignals: ["BUY"],
    minimumLiquidityUsd: 15_000, minimumVolume24hUsd: 5_000,
    timers: { setInterval: () => 1, clearInterval: () => {} },
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} },
    reentryStateFile: null });
  approved.startBot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buys.length, 1);
  assert.equal(buys[0].priceUsd, 1.01);
  approved.stopBot();
});
