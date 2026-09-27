const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJanMvpTrader } = require("../janMvpTrader");
const { createJanMvpBot } = require("../janMvpBot");

function fakeTimers() {
  let next = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(fn, ms) { callbacks.set(++next, { fn, ms }); return next; },
    clearInterval(id) { callbacks.delete(id); }
  };
}

function strongCoin(i) {
  return {
    tokenAddress: "token-" + i,
    symbol: "COIN" + i,
    name: "Coin " + i,
    pairAddress: "pair-" + i,
    priceUsd: 1 + i / 100,
    signal: "STRONG BUY",
    score: 10,
    priceChange5m: 1,
    priceChange1h: 5,
    priceChange24h: 10,
    liquidityUsd: 150000,
    volume24h: 500000,
    buys5m: 60,
    sells5m: 40
  };
}

test("one OG cache snapshot can fill all free Swarm slots without a discovery call", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));

  const trader = createJanMvpTrader({
    dataFile:path.join(dir, "janMvpData.json"),
    config:{ slotCount:5, startingSlotValue:2, targets:[10,50,100,150] }
  });
  const timers = fakeTimers();
  let cacheReads = 0;

  const bot = createJanMvpBot({
    trader,
    timers,
    getOgPortfolio:() => ({ position:null }),
    getCachedCandidates:() => {
      cacheReads++;
      return {
        updatedAt:new Date().toISOString(),
        candidates:[1,2,3,4,5].map(strongCoin)
      };
    },
    getTokenData:async () => null,
    notifier:{ sendTelegramMessage:async () => ({ sent:true }) }
  });

  bot.start();
  await new Promise(resolve => setImmediate(resolve));

  const state = trader.getState();
  assert.equal(cacheReads, 1);
  assert.equal(state.slots.filter(slot => slot.position).length, 5);
  assert.equal(new Set(state.slots.map(slot => slot.position.tokenAddress)).size, 5);
  assert.deepEqual(state.slots.map(slot => slot.position.symbol), ["COIN1","COIN2","COIN3","COIN4","COIN5"]);
  bot.stop();
});

test("Swarm can mirror OG into one slot and use other coins in remaining slots", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-og-plus-market-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));

  const trader = createJanMvpTrader({
    dataFile:path.join(dir, "janMvpData.json"),
    config:{ slotCount:5, startingSlotValue:2, targets:[10,50,100,150] }
  });
  const timers = fakeTimers();

  const ogPosition = {
    id:"og-1",
    tokenAddress:"og-token",
    symbol:"OG",
    name:"OG Coin",
    pairAddress:"og-pair",
    entryPrice:1,
    entryTime:"2026-09-26T20:00:00Z",
    entryScore:10,
    entrySignal:"STRONG BUY",
    entryPriceChange5m:1,
    entryPriceChange1h:5,
    entryPriceChange24h:10,
    entryLiquidityUsd:150000,
    entryVolume24h:500000,
    entryBuys5m:60,
    entrySells5m:40
  };

  const bot = createJanMvpBot({
    trader,
    timers,
    getOgPortfolio:() => ({ position:ogPosition }),
    getCachedCandidates:() => ({
      updatedAt:new Date().toISOString(),
      candidates:[strongCoin(1), strongCoin(2), strongCoin(3), strongCoin(4)]
    }),
    getTokenData:async () => null,
    notifier:{ sendTelegramMessage:async () => ({ sent:true }) }
  });

  bot.start();
  await new Promise(resolve => setImmediate(resolve));

  const state = trader.getState();
  const open = state.slots.map(slot => slot.position).filter(Boolean);
  assert.equal(open.length, 5);
  assert.equal(open.filter(position => position.source === "OG_MIRROR").length, 1);
  assert.equal(open.filter(position => position.source === "SWARM_CACHE").length, 4);
  assert.equal(new Set(open.map(position => position.tokenAddress)).size, 5);
  bot.stop();
});
