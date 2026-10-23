const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJanMvpTrader, getConfig } = require("../janMvpTrader");
const { createJanMvpBot } = require("../janMvpBot");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-reentry-"));
  const trader = createJanMvpTrader({
    dataFile: path.join(dir, "swarm.json"),
    config: getConfig({ SWARM_STARTING_CAPITAL: "10", SWARM_GENESIS_COUNT: "5" })
  });
  const bot = createJanMvpBot({
    trader,
    getTokenData: async () => null,
    discoverCandidates: async () => [],
    checkLiquidityLock: async () => ({ allowed: true, lockedPercent: 100 }),
    timers: { setInterval() { return 0; }, clearInterval() {} },
    notifier: { notifyTrade() {}, sendTelegramMessage() {}, notifyCritical() {} }
  });
  return { dir, trader, bot, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function coin(priceUsd, tokenAddress = "MINT_A") {
  return { tokenAddress, symbol: "A", priceUsd, signal: "STRONG BUY", buys5m: 0, sells5m: 0 };
}

test("a full loss exit blocks re-entry of the same token only", () => {
  const f = fixture();
  try {
    assert.equal(f.trader.buy(1, coin(1)).success, true);
    assert.equal(f.trader.sell(1, 0.8, 100, { reason: "HARD STOP" }).success, true);
    assert.equal(f.bot.isReentryBlocked("MINT_A"), true);
    assert.equal(f.bot.isReentryBlocked("MINT_B"), false);
  } finally { f.close(); }
});

test("a full profitable exit does not block re-entry", () => {
  const f = fixture();
  try {
    assert.equal(f.trader.buy(1, coin(1)).success, true);
    assert.equal(f.trader.sell(1, 2, 100, { reason: "TRAILING STOP" }).success, true);
    assert.equal(f.bot.isReentryBlocked("MINT_A"), false);
  } finally { f.close(); }
});

test("a partial loss exit does not block re-entry", () => {
  const f = fixture();
  try {
    assert.equal(f.trader.buy(1, coin(1)).success, true);
    assert.equal(f.trader.sell(1, 0.8, 50, { reason: "TEST" }).success, true);
    assert.equal(f.bot.isReentryBlocked("MINT_A"), false);
  } finally { f.close(); }
});
