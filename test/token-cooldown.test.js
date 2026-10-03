const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBot } = require("../bot");

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  let next = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(fn, ms) { callbacks.set(++next, { fn, ms }); return next; },
    clearInterval(id) { callbacks.delete(id); }
  };
}

function strongBuy(tokenAddress, changes = {}) {
  return {
    tokenAddress,
    symbol: tokenAddress,
    name: tokenAddress,
    priceUsd: 1,
    signal: "STRONG BUY",
    score: 10,
    priceChange5m: 1,
    priceChange1h: 5,
    liquidityUsd: 60000,
    volume24h: 160000,
    buys5m: 18,
    sells5m: 12,
    ...changes
  };
}

function rig(candidates, checkLiquidityLock = async () => ({ allowed: true, lockedPercent: 95 })) {
  const state = { startingBalance: 100, cashBalance: 100, positions: [], history: [] };
  let nextPosition = 0;
  const trader = {
    buy(coin) {
      const position = {
        id: `new-${++nextPosition}`,
        tokenAddress: coin.tokenAddress,
        symbol: coin.symbol
      };
      state.positions.push(position);
      const trade = { type: "BUY", positionId: position.id, ...position };
      state.history.push(trade);
      return { success: true, trade };
    },
    sell() { throw new Error("Unexpected sale in entry test."); },
    updateHigh() { return true; },
    positionKey(position) { return position.id; },
    getPortfolio() { return structuredClone(state); }
  };
  const timers = fakeTimers();
  const notifier = { notifyTrade: async () => {}, notifyCritical: async () => {} };
  const bot = createBot({
    trader,
    timers,
    discoverCandidates: async () => candidates,
    getTokenData: async () => null,
    notifier,
    checkLiquidityLock
  });
  return { bot, state };
}

test("opens two original-sized slots in one scan, only for LP-locked candidates", async t => {
  const lockChecks = [];
  const candidates = [
    strongBuy("unlocked", { score: 12 }),
    strongBuy("locked-1", { score: 11 }),
    strongBuy("locked-2", { score: 9 }),
    strongBuy("third-locked", { score: 8 })
  ];
  const { bot, state } = rig(candidates, async address => {
    lockChecks.push(address);
    return address === "unlocked"
      ? { allowed: false, lockedPercent: 0, reason: "LP not locked" }
      : { allowed: true, lockedPercent: 95 };
  });
  t.after(() => bot.stopBot());

  bot.startBot();
  await settle();

  assert.deepEqual(state.positions.map(position => position.tokenAddress), ["locked-1", "locked-2"]);
  assert.deepEqual(lockChecks, ["unlocked", "locked-1", "locked-2"]);
});

test("never exceeds two concurrent entries", async t => {
  const { bot, state } = rig([strongBuy("one"), strongBuy("two"), strongBuy("three")]);
  t.after(() => bot.stopBot());

  bot.startBot();
  await settle();

  assert.equal(state.positions.length, 2);
});


test("activates a +4% protective floor after a +10% peak gain", async t => {
  const position = {
    id: "existing-lock-position",
    tokenAddress: "lock-token",
    symbol: "LOCK",
    entryPrice: 100,
    highestPrice: 100,
    firstTakeProfitDone: false,
    secondTakeProfitDone: false
  };
  const state = { startingBalance: 100, cashBalance: 90, positions: [position], history: [] };
  const sellCalls = [];
  let currentPrice = 109;

  const trader = {
    buy() { throw new Error("Unexpected buy in exit test."); },
    sell(price, percent, options) {
      sellCalls.push({ price, percent, options });
      state.positions = [];
      return { success: true, trade: { type: "SELL", reason: options.reason } };
    },
    getPortfolio() { return structuredClone(state); },
    updateHigh(key, price) {
      const current = state.positions.find(item => item.id === key);
      if (current) current.highestPrice = Math.max(current.highestPrice, price);
      return true;
    },
    positionKey(item) { return item.id; }
  };
  const timers = fakeTimers();
  const bot = createBot({
    trader,
    timers,
    discoverCandidates: async () => [],
    getTokenData: async () => ({ priceUsd: currentPrice, priceChange5m: 0, buys5m: 0, sells5m: 0 }),
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} }
  });
  t.after(() => bot.stopBot());

  bot.startBot();
  await settle();

  const monitor = [...timers.callbacks.values()].find(item => item.ms === 2000)?.fn;
  assert.equal(typeof monitor, "function");

  currentPrice = 103;
  await monitor();
  assert.equal(sellCalls.length, 0, "a sub-10% peak should not arm the lock");

  currentPrice = 110;
  await monitor();
  assert.equal(sellCalls.length, 0, "reaching +10% arms the lock but does not sell by itself");

  currentPrice = 104;
  await monitor();
  assert.equal(sellCalls.length, 1);
  assert.equal(sellCalls[0].options.reason, "PROFIT LOCK");
  assert.equal(sellCalls[0].price, 104);
});
