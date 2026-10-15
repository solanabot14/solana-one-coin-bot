const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBot } = require("../bot");

test("refreshes every open position with one batched market-data request", async t => {
  const calls = [];
  const positions = [
    { id:"p1", tokenAddress:"token-1", entryPrice:100, highestPrice:100, amountInvested:10, quantity:0.1 },
    { id:"p2", tokenAddress:"token-2", entryPrice:100, highestPrice:100, amountInvested:10, quantity:0.1 }
  ];
  const trader = {
    getPortfolio: () => ({ positions, history:[], cashBalance:80 }),
    positionKey: position => position.id,
    updateHigh: () => true,
    sell: () => ({ success:true }),
    buy: () => ({ success:true })
  };
  const bot = createBot({
    trader,
    getTokenData: async () => { throw new Error("single-token fallback should not run"); },
    getTokensData: async addresses => {
      calls.push(addresses);
      return new Map(addresses.map(address => [address, {
        priceUsd:100, priceChange5m:0, buys5m:10, sells5m:5, liquidityUsd:20000
      }]));
    },
    batchPositionPrices:true,
    discoverCandidates:async () => [],
    timers:{setInterval(){return 1;},clearInterval(){}},
    notifier:{notifyTrade:async()=>{},notifyCritical:()=>{}},
    checkLiquidityLock:async()=>true,
    botLabel:"batch test",
    reentryStateFile:"/tmp/one-coin-batch-test-reentry-state.json",
    scannerIntervalMs:60000
  });
  t.after(() => bot.stopBot());
  bot.startBot();
  await new Promise(resolve => setImmediate(resolve));
  bot.stopBot();

  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],["token-1","token-2"]);
});


test("manual position close sells the full remaining paper position by ID", () => {
  const position = { id: "carlo-position", tokenAddress: "carlo-token", symbol: "CARLO" };
  const calls = [];
  const trader = {
    getPortfolio: () => ({ positions: [position], history: [], cashBalance: 0 }),
    positionKey: item => item.id,
    sell: (...args) => { calls.push(args); return { success: true, trade: { positionId: "carlo-position" } }; },
    buy: () => ({ success: true })
  };
  const bot = createBot({ trader, discoverCandidates: async () => [],
    timers: { setInterval() { return 1; }, clearInterval() {} },
    notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} },
    reentryStateFile: "/tmp/one-coin-manual-close-test.json" });
  const result = bot.closePosition("carlo-position", 0.0000446, 15000, "MANUAL EMERGENCY EXIT");
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 0.0000446);
  assert.equal(calls[0][1], 100);
  assert.deepEqual(calls[0][2], { expectedPosition: "carlo-position", reason: "MANUAL EMERGENCY EXIT", liquidityUsd: 15000 });
});

test("pair-locked monitor rejects another pool or another mint with the same symbol", async t => {
 for(const quote of [{tokenAddress:'mint',pairAddress:'other'},{tokenAddress:'clone',pairAddress:'pool'},{tokenAddress:'mint',pairAddress:'pool'}]) {
  const p={id:'id',tokenAddress:'mint',pairAddress:'pool',symbol:'SAME',entryPrice:100,highestPrice:100,quantity:1,amountInvested:100};
  let sells=0, options;
  const bot=createBot({trader:{getPortfolio:()=>({positions:[p],history:[],cashBalance:0}),positionKey:p=>p.id,updateHigh:()=>true,sell:()=>{sells++;return {success:true};},buy:()=>({success:false})},
   lockPositionPair:true,batchPositionPrices:true,getTokensData:async(a,o)=>{options=o;return new Map([['mint',{...quote,priceUsd:90,liquidityUsd:10000}]]);},
   discoverCandidates:async()=>[],timers:{setInterval(){return 1;},clearInterval(){}},notifier:{notifyTrade:async()=>{},notifyCritical:async()=>{}},reentryStateFile:null});
  bot.startBot();await new Promise(resolve=>setImmediate(resolve));bot.stopBot();
  assert.equal(options.pairAddresses.get('mint'),'pool');
  assert.equal(sells,quote.tokenAddress==='mint'&&quote.pairAddress==='pool'?1:0);
 }
});

test("Profit Sniper writes off a collapsed pool without crediting a quoted million-dollar paper sale", async () => {
  const { chooseExit } = require("../profitSniperStrategy");
  const position = { id: "collapsed", tokenAddress: "mint", pairAddress: "pool", symbol: "fishy",
    entryPrice: 0.00001021, highestPrice: 0.00001021, quantity: 1_957_000, amountInvested: 20 };
  let writes = 0;
  let sells = 0;
  const bot = createBot({ trader: {
    getPortfolio: () => ({ positions: writes ? [] : [position], history: [], cashBalance: 180 }),
    positionKey: p => p.id, updateHigh: () => true,
    writeOff: () => { writes++; return { success: true, trade: { saleValue: 0 } }; },
    sell: () => { sells++; return { success: true }; }, buy: () => ({ success: false })
  }, exitDecision: chooseExit, lockPositionPair: true, batchPositionPrices: true,
  getTokensData: async () => new Map([["mint", { tokenAddress: "mint", pairAddress: "pool",
    priceUsd: 0.6494, liquidityUsd: 0.5 }]]), discoverCandidates: async () => [],
  timers: { setInterval() { return 1; }, clearInterval() {} },
  notifier: { notifyTrade: async () => {}, notifyCritical: async () => {} },
  reentryStateFile: null });
  bot.startBot();
  await new Promise(resolve => setImmediate(resolve));
  bot.stopBot();
  assert.equal(writes, 1);
  assert.equal(sells, 0);
});
