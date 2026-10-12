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
