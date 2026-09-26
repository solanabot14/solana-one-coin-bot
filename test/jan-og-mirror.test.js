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

test("Jan MVP mirrors the exact OG coin once without changing OG state", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jan-og-mirror-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const trader = createJanMvpTrader({
    dataFile:path.join(dir, "janMvpData.json"),
    config:{ slotCount:5, startingSlotValue:2, targets:[10,50,100,150] }
  });

  const ogState = {
    startingBalance:100,
    cashBalance:90,
    position:{
      id:"og-position-1",
      symbol:"ARENA",
      name:"Arena",
      tokenAddress:"arena-token",
      pairAddress:"arena-pair",
      entryPrice:0.000419,
      entryTime:"2026-09-26T20:00:00Z",
      entryScore:10,
      entrySignal:"STRONG BUY",
      entryPriceChange5m:1.2,
      entryPriceChange1h:9,
      entryPriceChange24h:25,
      entryLiquidityUsd:150000,
      entryVolume24h:700000,
      entryBuys5m:60,
      entrySells5m:40
    },
    history:[]
  };
  const before = JSON.stringify(ogState);
  const timers = fakeTimers();
  const bot = createJanMvpBot({
    trader,
    timers,
    getOgPortfolio:() => ogState,
    getTokenData:async () => null,
    notifier:{ sendTelegramMessage:async () => ({ sent:true }) }
  });

  bot.start();
  await new Promise(resolve => setImmediate(resolve));

  let state = trader.getState();
  assert.equal(JSON.stringify(ogState), before);
  assert.equal(state.slots[0].position.symbol, "ARENA");
  assert.equal(state.slots[0].position.entryPrice, 0.000419);
  assert.equal(state.slots[0].position.source, "OG_MIRROR");
  assert.equal(state.slots[0].position.sourceOgPositionId, "og-position-1");
  assert.equal(state.slots[0].position.originalAmountInvested, 2);

  const follow = [...timers.callbacks.values()].find(x => x.ms === 2000);
  assert.ok(follow);
  await follow.fn();
  state = trader.getState();
  assert.equal(state.executions.filter(x => x.type === "BUY").length, 1);

  bot.stop();
});

test("Jan MVP distributes later OG entries to another available slot", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jan-og-rotate-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const trader = createJanMvpTrader({
    dataFile:path.join(dir, "janMvpData.json"),
    config:{ slotCount:5, startingSlotValue:2, targets:[10,50,100,150] }
  });
  let og = { position:{
    id:"og-1", symbol:"A", name:"A", tokenAddress:"a", entryPrice:1, entryTime:"2026-09-26T20:00:00Z"
  }};
  const timers = fakeTimers();
  const bot = createJanMvpBot({
    trader,
    timers,
    getOgPortfolio:() => og,
    getTokenData:async () => null,
    notifier:{ sendTelegramMessage:async () => ({ sent:true }) }
  });

  bot.start();
  await new Promise(resolve => setImmediate(resolve));
  og = { position:{
    id:"og-2", symbol:"B", name:"B", tokenAddress:"b", entryPrice:2, entryTime:"2026-09-26T20:01:00Z"
  }};
  const follow = [...timers.callbacks.values()].find(x => x.ms === 2000);
  await follow.fn();

  const state = trader.getState();
  assert.equal(state.slots[0].position.symbol, "A");
  assert.equal(state.slots[1].position.symbol, "B");
  bot.stop();
});
