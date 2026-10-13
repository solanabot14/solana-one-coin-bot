const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBot } = require("../bot");
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t, prepareEntry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-prebuy-"));
  const trades = [], callbacks = [];
  const coin = { symbol: "TEST", name: "Test", tokenAddress: "mint-A", pairAddress: "pool-A",
    signal: "BUY", score: 10, priceUsd: 1 };
  const bot = createBot({
    validateEntry: prepareEntry, requireLiquidityLock: false, acceptedSignals: ["BUY"],
    reentryStateFile: path.join(dir, "guards.json"),
    discoverCandidates: async () => [coin],
    trader: { buy: c => { trades.push(c); return { success: true, trade: c }; },
      getPortfolio: () => ({ cashBalance: 200, positions: [], history: [] }),
      positionKey: p => p.id },
    timers: { setInterval: fn => { callbacks.push(fn); return callbacks.length; }, clearInterval() {} },
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} }
  });
  t.after(() => { bot.stopBot(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { bot, trades, coin, callbacks };
}
test("verified purchase uses refreshed data and a rejected candidate never reaches buy", async t => {
  const accepted = setup(t, async coin => ({ allowed: true, coin: { ...coin, priceUsd: 1.05 } }));
  accepted.bot.startBot(); await settle();
  assert.equal(accepted.trades.length, 1);
  assert.equal(accepted.trades[0].priceUsd, 1.05);
  accepted.bot.stopBot();
  const rejected = setup(t, async () => ({ allowed: false, reason: "EMPTY_POOL" }));
  rejected.bot.startBot(); await settle();
  assert.equal(rejected.trades.length, 0);
  assert.equal(rejected.bot.getBotStatus(), true);
});
test("stop while pre-buy is pending prevents a late fill", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const x = setup(t, async coin => { await pending; return { allowed: true, coin }; });
  x.bot.startBot(); await settle();
  x.bot.stopBot(); release(); await settle();
  assert.equal(x.trades.length, 0);
});
test("bots without the optional verifier retain their entry behavior", async t => {
  const x = setup(t, null);
  x.bot.startBot(); await settle();
  assert.equal(x.trades.length, 1);
  assert.equal(x.trades[0].priceUsd, 1);
});
