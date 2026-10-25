const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createGeminiTrader } = require("../geminiTrader");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.endsWith("geminiBot.js")) {
    if (request === "./geminiSources") return {};
    if (request === "./geminiHttp") return {};
    if (request === "./geminiFilter") return {};
    if (request === "./profitSniperExecutionQuote") return { createExecutionVerifier: () => async () => ({ allowed: true }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { createGeminiBot } = require("../geminiBot");
Module._load = originalLoad;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-strategy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({startingBalanceUsd:200,cashUsd:200,position:null,history:[],rejections:[]}));
  return { file, trader: createGeminiTrader(file) };
}
const candidate = {tokenAddress:"mint",pairAddress:"pair",priceUsd:1,symbol:"TEST"};
test("cash sizing alternates 10, 12.5, 10 and survives restart", t => {
  const {file,trader} = fixture(t);
  assert.equal(trader.buy({...candidate,priceUsd:0}).success,false);
  assert.equal(trader.getSizing().percent,10);
  assert.equal(trader.buy(candidate).position.originalCostUsd,20);
  assert.equal(trader.buy(candidate).success,false);
  trader.sell(1.2,100,"TP +20% FULL EXIT");
  const restored = createGeminiTrader(file);
  assert.equal(restored.getState().cashUsd,204);
  assert.equal(restored.getSizing().percent,12.5);
  assert.equal(restored.buy(candidate).position.originalCostUsd,25.5);
  restored.sell(1,100,"TEST");
  assert.equal(createGeminiTrader(file).getSizing().percent,10);
});
test("monitor holds below 15 percent and exits all at 15 percent", async t => {
  const {trader} = fixture(t);
  trader.buy(candidate);
  let price = 1.149;
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>({priceUsd:price})});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(trader.getState().position);
  price = 1.15;
  await bot.monitor();
  assert.equal(trader.getState().position,null);
  const sale = trader.getState().history[0];
  assert.equal(sale.reason,"TP +15% FULL EXIT");
  assert.equal(sale.percentOfOriginalSold,100);
  assert.equal(trader.getState().cashUsd,203);
});
test("new full exit closes remainder of an existing partial position", async t => {
  const {trader} = fixture(t);
  trader.buy(candidate); trader.sell(1.5,50,"TP1 +50%");
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>({priceUsd:1.2})});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(trader.getState().position,null);
  assert.equal(trader.getState().history[0].quantity,10);
});

test("monitor holds above -8 percent and closes all at -8 percent", async t => {
  const {trader} = fixture(t);
  trader.buy(candidate);
  let price = 0.921;
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>({priceUsd:price})});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(trader.getState().position);
  price = 0.92;
  await bot.monitor();
  assert.equal(trader.getState().position,null);
  assert.equal(trader.getState().history[0].reason,"HARD STOP -8%");
  assert.equal(trader.getState().history[0].percentOfOriginalSold,100);
  assert.ok(Math.abs(trader.getState().cashUsd - 198.4) < 1e-9);
});

test("monitor exits before a position can be trapped by a liquidity collapse", async t => {
  const {trader} = fixture(t);
  trader.buy({...candidate, geminiDetails:{liquidityUsd:10000}});
  let pair = {priceUsd:1,liquidity:{usd:10000}};
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>pair});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(trader.getState().position);
  pair = {priceUsd:0.99,liquidity:{usd:2999}};
  await bot.monitor();
  assert.equal(trader.getState().position,null);
  assert.equal(trader.getState().history[0].reason,"LIQUIDITY COLLAPSE EXIT");
  assert.equal(trader.getState().history[0].percentOfOriginalSold,100);
});
