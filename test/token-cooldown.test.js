const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

function temporaryStateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v31-reentry-"));
  return path.join(directory, "reentry.json");
}

function rig(candidates, checkLiquidityLock = async () => ({ allowed: true, lockedPercent: 95 }), options = {}) {
  const state = options.state || { startingBalance: 100, cashBalance: 100, positions: [], history: [] };
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
    checkLiquidityLock,
    acceptedSignals:["BUY","STRONG BUY"],
    useReentryGuards:true,
    reentryStateFile: options.reentryStateFile || temporaryStateFile()
  });
  return { bot, state };
}

test("opens BUY and STRONG BUY signals within the same LP-lock and slot limits", async t => {
  const lockChecks = [];
  const candidates = [
    strongBuy("unlocked", { signal: "BUY", score: 7 }),
    strongBuy("locked-1", { signal: "BUY", score: 7 }),
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


test("default bot has no obsolete +4% profit floor and still exits at its hard stop", async t => {
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
  assert.equal(sellCalls.length, 0);
  currentPrice=89;
  await monitor();
  assert.equal(sellCalls.length,1);
  assert.equal(sellCalls[0].options.reason,"HARD STOP");
  assert.equal(sellCalls[0].price,89);
});


test("keeps a full-exit token blocked across restart until two strong activity checks", async t => {
  const tokenAddress = "persistent-reentry-token";
  const state = {
    startingBalance: 100,
    cashBalance: 100,
    positions: [],
    history: [
      { type: "BUY", tokenAddress, positionId: "old-position", entryTime: "2026-10-04T20:00:00.000Z" },
      { type: "SELL", tokenAddress, positionId: "old-position", percentSold: 100, exitTime: "2026-10-04T21:00:00.000Z", symbol: "REENTRY" }
    ]
  };
  const stateFile = temporaryStateFile();
  const firstCandidate = strongBuy(tokenAddress, {
    volume5m: 4000,
    liquidityUsd: 60000,
    buys5m: 12,
    sells5m: 8,
    priceChange5m: 1
  });
  const first = rig([firstCandidate], async () => ({ allowed: true, lockedPercent: 95 }), { state, reentryStateFile: stateFile });
  t.after(() => first.bot.stopBot());
  first.bot.startBot();
  await settle();
  assert.equal(state.positions.length, 0, "one observation is not enough to reenter");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).guards[tokenAddress].observations, 1);
  first.bot.stopBot();

  const secondCandidate = strongBuy(tokenAddress, {
    volume5m: 5200,
    liquidityUsd: 58000,
    buys5m: 12,
    sells5m: 8,
    priceChange5m: 1
  });
  const second = rig([secondCandidate], async () => ({ allowed: true, lockedPercent: 95 }), { state, reentryStateFile: stateFile });
  t.after(() => second.bot.stopBot());
  second.bot.startBot();
  await settle();
  assert.equal(state.positions.length, 1, "a second valid scan with >=25% volume growth releases the reentry lock");
  assert.equal(state.positions[0].tokenAddress, tokenAddress);
});

