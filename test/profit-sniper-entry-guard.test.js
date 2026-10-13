const test = require("node:test");
const assert = require("node:assert/strict");
const { createSniperEntryGuard, hasCatastrophicLoss, evaluatePoolReport } = require("../profitSniperEntryGuard");
const { getMomentumFailureReasons } = require("../profitSniperStrategy");

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

test("observations collected before the two-minute age gate can be used at the gate", async () => {
  const young = { ...candidate, pairCreatedAt: start - 30_000 };
  const { guard, advance, portfolio } = rig({ freshPair: { ...pair, pairCreatedAt: young.pairCreatedAt } });
  assert.deepEqual(getMomentumFailureReasons(young, start), ["age"]);
  guard.observe(young);
  advance(30_000); guard.observe(young);
  advance(30_000);
  assert.equal(guard.observe(young).ready, true);
  assert.deepEqual(getMomentumFailureReasons(young, start + 60_000), ["age"]);
  advance(30_000);
  assert.deepEqual(getMomentumFailureReasons(young, start + 90_000), []);
  assert.equal((await guard.validate(young, { portfolio })).allowed, true);
});

test("a liquidity dip below the entry floor clears earlier observations", async () => {
  const { guard, advance, portfolio } = rig();
  guard.observe(candidate);
  advance(30_000); guard.observe(candidate);
  advance(30_000); assert.equal(guard.observe(candidate).ready, true);
  advance(30_000); assert.equal(guard.observe({ ...candidate, liquidityUsd: 100 }).ready, false);
  advance(30_000); assert.equal(guard.observe(candidate).ready, false);
  assert.equal((await guard.validate(candidate, { portfolio })).allowed, false);
});

test("fresh pair and full pool report checks start together", async () => {
  let resolvePair;
  let reportStarted = false;
  let now = start;
  const guard = createSniperEntryGuard({ clock: () => now,
    fetchPair: () => new Promise(resolve => { resolvePair = resolve; }),
    fetchReport: async () => { reportStarted = true; return report; } });
  guard.observe(candidate);
  now += 30_000; guard.observe(candidate);
  now += 30_000; guard.observe(candidate);
  const validation = guard.validate(candidate, { portfolio: { history: [] } });
  assert.equal(reportStarted, true);
  resolvePair([pair]);
  assert.equal((await validation).allowed, true);
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

test("full Profit Sniper slots keep discovery observations warm without buying", async () => {
  const { createBot } = require("../bot");
  let scans = 0;
  let buys = 0;
  const positions = Array.from({ length: 3 }, (_, index) =>
    ({ id: index + 1, tokenAddress: "mint-" + index }));
  const trader = {
    buy: () => { buys++; return { success: true }; },
    sell: () => ({ success: false }), updateHigh: () => true,
    positionKey: position => position.id,
    getPortfolio: () => ({ cashBalance: 100, positions, history: [] })
  };
  const bot = createBot({ trader, scanWhenFull: true,
    maxOpenPositions: 3,
    discoverCandidates: async () => { scans++; return [candidate]; },
    getTokenData: async () => null,
    requireLiquidityLock: false, acceptedSignals: ["BUY"],
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} },
    timers: { setInterval: () => 1, clearInterval: () => {} },
    reentryStateFile: null });
  bot.startBot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 1);
  assert.equal(buys, 0);
  bot.stopBot();
});
