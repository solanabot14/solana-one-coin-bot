const test=require("node:test");
const assert=require("node:assert/strict");
const {createDexDiscovery}=require("../profitSniperDexDiscovery");
const now=1800000000000;
function pair(overrides={}) {return {chainId:"solana",dexId:"pumpswap",pairAddress:"pool-A",
  baseToken:{address:"mint-A",symbol:"A"},pairCreatedAt:now-600000,priceUsd:"1",
  liquidity:{usd:25000},volume:{m5:10000,h24:20000},txns:{m5:{buys:50,sells:20}},
  priceChange:{m5:5},...overrides};}
test("Sniper uses only DexScreener endpoints, caches feeds and refreshes exact quotes each scan",async()=>{
  const urls=[];
  const discovery=createDexDiscovery({clock:()=>now,httpGet:async url=>{
    urls.push(url);assert.match(url,/^https:\/\/api.dexscreener.com\//);
    if(url.includes("/tokens/v1/"))return {data:[pair()]};
    if(url.includes("/latest/dex/pairs/"))return {data:{pairs:[pair()]}};
    return {data:[{chainId:"solana",tokenAddress:"mint-A"}]};
  }});
  const first=await discovery.discoverCandidates();
  assert.equal(first.length,1);assert.equal(first[0].tokenAddress,"mint-A");
  assert.equal(first[0].discoverySource,"DEXSCREENER_PUBLIC_FEEDS");
  await discovery.discoverCandidates();
  assert.equal(urls.filter(url=>url.includes("/token-boosts/top/v1")).length,1);
  assert.equal(urls.filter(url=>url.includes("/latest/dex/pairs/")).length,2);
  assert.equal(discovery.getScanDiagnostics().exactTrending5mRanking,false);
  assert.equal(discovery.getScanDiagnostics().exactTrending1hRanking,false);
  assert.match(discovery.getScanDiagnostics().ranking,/1h/);
});
test("one discovery feed outage does not prevent other DexScreener feeds from supplying candidates",async()=>{
  const discovery=createDexDiscovery({clock:()=>now,httpGet:async url=>{
    if(url.includes("/token-boosts/top/v1"))throw new Error("unavailable");
    if(url.includes("/tokens/v1/"))return {data:[pair()]};
    if(url.includes("/latest/dex/pairs/"))return {data:{pairs:[pair()]}};
    return {data:[{chainId:"solana",tokenAddress:"mint-A"}]};
  }});
  assert.equal((await discovery.discoverCandidates()).length,1);
  assert.equal(discovery.getScanDiagnostics().sourceErrors.length,1);
});
test("wrong-chain, expired pools and mismatched exact-pair mint cannot enter",async()=>{
  const discovery=createDexDiscovery({clock:()=>now,httpGet:async url=>{
    if(url.includes("/tokens/v1/"))return {data:[pair(),pair({pairAddress:"old",pairCreatedAt:now-25*3600000}),
      pair({chainId:"ethereum",pairAddress:"wrong-chain"})]};
    if(url.includes("/latest/dex/pairs/"))return {data:{pairs:[pair({baseToken:{address:"wrong-mint"}})]}};
    return {data:[{chainId:"solana",tokenAddress:"mint-A"}]};
  }});
  assert.equal((await discovery.discoverCandidates()).length,0);
  assert.equal(discovery.getScanDiagnostics().poolsTracked,1);
});
test("failed fresh quote requests never fall back to old discovery prices",async()=>{
  const discovery=createDexDiscovery({clock:()=>now,httpGet:async url=>{
    if(url.includes("/tokens/v1/"))return {data:[pair()]};
    if(url.includes("/latest/dex/pairs/"))throw new Error("quotes unavailable");
    return {data:[{chainId:"solana",tokenAddress:"mint-A"}]};
  }});
  assert.deepEqual(await discovery.discoverCandidates(),[]);
  assert.match(discovery.getScanDiagnostics().error,/quotes unavailable/);
});
