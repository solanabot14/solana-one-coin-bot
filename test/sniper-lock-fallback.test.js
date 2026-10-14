const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-lock-fallback-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = root;
const { createBot } = require("../bot");
const { createPaperTrader } = require("../paperTrader");

function fakeTimers() {
  let id = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(fn, ms) { callbacks.set(++id, { fn, ms }); return id; },
    clearInterval(key) { callbacks.delete(key); },
    async run(ms) {
      await Promise.all([...callbacks.values()].filter(item => item.ms === ms).map(item => item.fn()));
    }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function simulateEntry(signal, lock, tokenAddress) {
  const trader = createPaperTrader(path.join(root, tokenAddress + ".json"), fs, {
    strategyVersion: "SNIPER-LOCK-FALLBACK-TEST",
    maxOpenPositions: 2
  });
  const timers = fakeTimers();
  const candidate = {
    tokenAddress, pairAddress: tokenAddress + "-pool", symbol: "TEST",
    name: "Test", priceUsd: 1, liquidityUsd: 60000, volume24h: 80000,
    volume5m: 2000, buys5m: 6, sells5m: 2, priceChange5m: 1.5,
    signal, score: 10, reasons: []
  };
  const bot = createBot({
    trader, timers, discoverCandidates: async () => [candidate],
    checkLiquidityLock: async () => lock,
    reentryStateFile: path.join(root, tokenAddress + ".reentry.json")
  });
  bot.startBot();
  await settle();
  await timers.run(120000);
  await settle();
  bot.stopBot();
  return trader.getPortfolio().history.filter(item => item.type === "BUY").length;
}

test("unknown LP lock allows only twice-confirmed WAIT; rejects low lock and direct BUY", async t => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(await simulateEntry("WAIT",
    { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" }, "unknown-wait"), 1);
  assert.equal(await simulateEntry("WAIT",
    { allowed: false, lockedPercent: 45, reason: "LIQUIDITY_NOT_LOCKED_ENOUGH" }, "low-lock-wait"), 0);
  assert.equal(await simulateEntry("STRONG BUY",
    { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" }, "unknown-strong-buy"), 1);
});
