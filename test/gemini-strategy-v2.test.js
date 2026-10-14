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
  trader.sell(1.3,100,"TP +30% FULL EXIT");
  const restored = createGeminiTrader(file);
  assert.equal(restored.getState().cashUsd,206);
  assert.equal(restored.getSizing().percent,12.5);
  assert.equal(restored.buy(candidate).position.originalCostUsd,25.75);
  restored.sell(1,100,"TEST");
  assert.equal(createGeminiTrader(file).getSizing().percent,10);
});
test("monitor holds below 30 percent and exits all at 30 percent", async t => {
  const {trader} = fixture(t);
  trader.buy(candidate);
  let price = 1.299;
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>({priceUsd:price})});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(trader.getState().position);
  price = 1.3;
  await bot.monitor();
  assert.equal(trader.getState().position,null);
  const sale = trader.getState().history[0];
  assert.equal(sale.reason,"TP +30% FULL EXIT");
  assert.equal(sale.percentOfOriginalSold,100);
  assert.equal(trader.getState().cashUsd,206);
});
test("new full exit closes remainder of an existing partial position", async t => {
  const {trader} = fixture(t);
  trader.buy(candidate); trader.sell(1.5,50,"TP1 +50%");
  const bot = createGeminiBot({trader,timers:{setInterval:()=>1,clearInterval:()=>{}},
    poolFetcher:async()=>[],pairDetails:async()=>({priceUsd:1.3})});
  bot.start(); t.after(()=>bot.stop());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(trader.getState().position,null);
  assert.equal(trader.getState().history[0].quantity,10);
});
