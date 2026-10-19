const test = require("node:test");
const assert = require("node:assert/strict");
const { createEntryGuard, poolLock } = require("../profitSniperPrebuy");
const coin = { tokenAddress: "mint-A", pairAddress: "pool-A", symbol: "TEST", priceUsd: 0.5,
  pairCreatedAt: 1800000000000 - 15 * 60 * 1000, liquidityUsd: 25000,
  volume5m: 2000, buys5m: 40, sells5m: 10, priceChange5m: 2,
  momentumPattern: { ready: true } };
const now = 1800000000000;
function report({ pair = "pool-A", mint = "mint-A", liquidity = 30000, lock = 100, burned = false } = {}) {
  return { mint: "mint-A", rugged: false, risks: [],
    token: { mintAuthority: null, freezeAuthority: null },
    topHolders: Array.from({ length: 10 }, (_, i) => ({ address: "holder-" + i, pct: 2 })),
    markets: [{ pubkey: pair, mintA: mint, mintB: "SOL",
      lp: { lpLockedPct: lock, lpLockedUSD: liquidity * lock / 100,
        lpBurned: burned, baseUSD: liquidity / 2, quoteUSD: liquidity / 2 } }] };
}
function pair({ liquidity = 30000, price = 1, token = "mint-A", pool = "pool-A", momentum = 2 } = {}) {
  return { chainId: "solana", pairAddress: pool, baseToken: { address: token },
    priceUsd: price, liquidity: { usd: liquidity }, pairCreatedAt: coin.pairCreatedAt,
    volume: { h24: 0, m5: 2000 }, txns: { m5: { buys: 40, sells: 10 } },
    priceChange: { m5: momentum, h1: 5, h24: 5 } };
}
function fixture({ first = pair(), final = pair({ price: 1.02 }), lockReport = report(), headers = {}, onWait, fail = false,
  verifyExecution = async () => ({allowed:true,lossPercent:0.5}) } = {}) {
  let time = now, quotes = 0;
  const urls = [];
  const guard = createEntryGuard({ clock: () => time,
    securityProvider: "rugcheck",
    verifyExecution,
    wait: async ms => { time += ms; if (onWait) onWait(); },
    httpGet: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers["Cache-Control"], "no-cache");
      if (fail) throw new Error("HTTP_429");
      return { headers:url.includes("rugcheck")?{}:headers, data: url.includes("rugcheck") ? lockReport : { pairs: [quotes++ ? final : first] } };
    }
  });
  return { guard, urls };
}
test("healthy exact pool passes and uses the final price instead of discovery price", async () => {
  const { guard, urls } = fixture();
  const result = await guard.prepareEntry(coin);
  assert.equal(result.allowed, true);
  assert.equal(result.coin.priceUsd, 1.02);
  assert.equal(urls.length, 3);
  assert.equal(guard.getStatus().counters.passed, 1);
});
test("LP with insufficient reserves is rejected even if locked", () => {
  const result = poolLock(report({ liquidity: 0.00000034 }), coin);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "EXACT_POOL_RESERVES_TOO_LOW");
});
test("another pool's lock and another mint's quote cannot authorize a purchase", async () => {
  assert.equal(poolLock(report({ pair: "other-pool" }), coin).allowed, false);
  assert.equal(poolLock(report({ mint: "other-mint" }), coin).allowed, false);
  assert.equal((await fixture({ final: pair({ token: "other-mint" }) }).guard.prepareEntry(coin)).allowed, false);
});
test("liquidity collapse, missing data, disagreement, and stale responses fail closed", async () => {
  const cases = [
    { first: pair({ liquidity: 30000 }), final: pair({ liquidity: 21000 }), lockReport: report({ liquidity: 21000 }) },
    { final: pair({ liquidity: 7999 }) },
    { final: pair({ liquidity: null }) },
    { final: pair({ price: null }) },
    { lockReport: report({ liquidity: 40000 }) },
    { headers: { age: "40" } },
    { fail: true }
  ];
  for (const options of cases) assert.equal((await fixture(options).guard.prepareEntry(coin)).allowed, false);
});
test("exact 20% liquidity drop remains eligible", async () => {
  const { guard } = fixture({ first: pair({ liquidity: 25000 }), final: pair({ liquidity: 20000 }), lockReport: report({ liquidity: 20000 }) });
  assert.equal((await guard.prepareEntry(coin)).allowed, true);
});
test("high five-minute movement is informational; confirmed activity and fresh safety checks still required", async () => {
  assert.equal((await fixture({ final: pair({ momentum: 36 }) }).guard.prepareEntry(coin)).allowed, true);
  const confirmed = { ...coin, momentumPattern: { ready: true, pullbackObserved: true,
    entryRoute: "confirmed_pullback_recovery" } };
  assert.equal((await fixture({ first: pair({ momentum: 80 }), final: pair({ momentum: 80 }) })
    .guard.prepareEntry(confirmed)).allowed, true);
  assert.equal((await fixture({ final: pair({ momentum: 30 }) }).guard.prepareEntry(coin)).allowed, true);
});
test("missing and insufficient exact-pool lock are rejected below the 30% floor", () => {
  for (const lock of [null, undefined, "", 0, 29, 101]) {
    const r = report(); r.markets[0].lp.lpLockedPct = lock;
    assert.equal(poolLock(r, coin).allowed, false);
  }
  assert.equal(poolLock(report({ lock: 30 }), coin).allowed, true);
  assert.equal(poolLock(report({ lock: 70 }), coin).allowed, true);
});
test("burned LP can pass without a lock only when RugCheck explicitly marks it burned", () => {
  assert.equal(poolLock(report({ burned: true, lock: 0 }), coin).allowed, true);
});
test("GoPlus exact-pool burn percentage counts toward the existing 30% secured-liquidity floor", () => {
  const goplus = { mint: coin.tokenAddress, provider: "goplus", rugged: false,
    token: { mintAuthority: null, freezeAuthority: null },
    topHolders: Array.from({ length: 10 }, (_, i) => ({ address: "h" + i, pct: 2 })),
    markets: [{ provider: "goplus", pubkey: coin.pairAddress, mintA: coin.tokenAddress,
      lp: { providerTvlUSD: 30000, lpBurnedPct: 35, lpLockedPct: 35,
        lpLockedUSD: 10500, lpBurned: false } }] };
  assert.equal(poolLock(goplus, coin).allowed, true);
  assert.equal(poolLock({ ...goplus, markets: [{ ...goplus.markets[0], pubkey: "other-pool" }] }, coin).allowed, false);
  assert.equal(poolLock({ ...goplus, markets: [{ ...goplus.markets[0], lp: { ...goplus.markets[0].lp,
    lpBurnedPct: 29, lpLockedPct: 29, lpLockedUSD: 8700 } }] }, coin).allowed, false);
  assert.equal(poolLock({ ...goplus, markets: [{ ...goplus.markets[0], lp: { ...goplus.markets[0].lp,
    lpBurnedPct: null, lpLockedPct: null, lpLockedUSD: null } }] }, coin).allowed, false);
});
test("stopping during confirmation cancels the candidate", async () => {
  const controller = new AbortController();
  const { guard } = fixture({ onWait: () => controller.abort() });
  assert.equal((await guard.prepareEntry(coin, { signal: controller.signal })).allowed, false);
});

test("missing execution routes and final price falling both prevent entry", async () => {
  const missing=fixture({verifyExecution:async()=>({allowed:false,reason:"NO_SELL_ROUTE"})});
  assert.equal((await missing.guard.prepareEntry(coin)).reason,"NO_SELL_ROUTE");
  const falling=fixture({first:pair({price:1}),final:pair({price:0.99})});
  assert.equal((await falling.guard.prepareEntry(coin)).reason,"PRICE_FALLING_BEFORE_PURCHASE");
});



test("stale pair cache retries official token endpoint and still requires exact fresh pool", async () => {
  let time=now; const urls=[];
  const guard=createEntryGuard({clock:()=>time,securityProvider:"rugcheck",wait:async ms=>{time+=ms;},
    verifyExecution:async()=>({allowed:true,lossPercent:1}),
    httpGet:async url=>{
      urls.push(url);
      if(url.includes('rugcheck'))return {data:report(),headers:{}};
      if(url.includes('/latest/dex/pairs/'))return {data:{pairs:[pair()]},headers:{age:'40'}};
      return {data:[pair({price:1.02})],headers:{age:'1'}};
    }});
  assert.equal((await guard.prepareEntry(coin)).allowed,true);
  assert.equal(urls.filter(url=>url.includes('/tokens/v1/solana/')).length,2);
});
test("cost rejection retains actual quote values for diagnosis",async()=>{
  const execution={allowed:false,reason:'ROUND_TRIP_COST_TOO_HIGH',lossPercent:3.37,
    amountUsd:20,quotedSellValueUsd:19.546,slippageBufferPercent:1,maximumLossPercent:3};
  const {guard}=fixture({verifyExecution:async()=>execution});
  assert.equal((await guard.prepareEntry(coin)).allowed,false);
  assert.deepEqual(guard.getStatus().lastCheck.executionQuote,execution);
});

test("27-second market cache is accepted, labeled honestly, with fresh execution last",async()=>{
  const order=[];
  let time=now;
  const guard=createEntryGuard({clock:()=>time,securityProvider:"rugcheck",wait:async ms=>{time+=ms;},
    httpGet:async url=>{order.push(url.includes('rugcheck')?'report':'market');return url.includes('rugcheck')
      ?{data:report(),headers:{}}:{data:{pairs:[pair()]},headers:{age:'27','cache-control':'public, max-age=30'}};},
    verifyExecution:async()=>{order.push('execution');return {allowed:true,lossPercent:3.6,quotedCostPercent:2.6};}});
  assert.equal((await guard.prepareEntry(coin)).allowed,true);
  assert.equal(order.at(-1),'execution');
  assert.equal(guard.getStatus().lastCheck.marketDataAgeMs,27000);
  assert.equal(guard.getStatus().maximumMarketDataAgeMs,35000);
});
test("market cache age plus latency cannot bypass the 35-second bound",async()=>{
  let time=now;
  const guard=createEntryGuard({clock:()=>time,wait:async()=>{},httpGet:async()=>{time+=9000;
    return {data:{pairs:[pair()]},headers:{age:'27'}};}});
  assert.equal((await guard.prepareEntry(coin)).allowed,false);
});


test("mature-holder exception is reevaluated on the final market snapshot",async()=>{
  let time=now,quotes=0;
  const mature={...coin,pairCreatedAt:now-3600000,liquidityUsd:30000,volume5m:6000,buys5m:60,sells5m:40};
  const concentrated=report();concentrated.topHolders=Array.from({length:10},(_,i)=>({address:'h-'+i,pct:4.5}));
  let executionCalls=0;
  const guard=createEntryGuard({clock:()=>time,wait:async ms=>{time+=ms;},
    verifyExecution:async()=>{executionCalls++;return {allowed:true,lossPercent:1};},
    httpGet:async url=>{
      if(url.includes('rugcheck')) return {data:concentrated,headers:{}};
      const p=pair();p.pairCreatedAt=mature.pairCreatedAt;p.volume.m5=6000;p.txns.m5={buys:60,sells:40};
      if(quotes++)p.volume.m5=4900;
      return {data:{pairs:[p]},headers:{}};
    }});
  const result=await guard.prepareEntry(mature);
  assert.equal(result.allowed,false);assert.match(result.reason,/40%/);
  assert.equal(executionCalls,0);
  assert.equal(guard.getStatus().lastCheck.holderSecurity.top10Percent,45);
  assert.equal(guard.getStatus().lastCheck.holderSecurity.policy,'standard');
});
