const test=require("node:test"),assert=require("node:assert/strict");
const {createMomentumTracker}=require("../profitSniperMomentum");
const {getMomentumFailureReasons}=require("../profitSniperStrategy");
const base={chainId:"solana",tokenAddress:"active-mint",pairAddress:"active-pool",liquidityUsd:20000,
  priceChange5m:3,volume5m:10000,buys5m:70,sells5m:30};
function sequence(prices,extra={}) {
  const tracker=createMomentumTracker(); let last;
  prices.forEach((price,index)=>{last=tracker.observe({...base,...extra,priceUsd:price},index*30000);});
  return last;
}
test("small continuation enters without a 30% pump or any pullback",()=>{
  const result=sequence([1,1.01,1.02]);
  assert.equal(result.ready,true); assert.equal(result.entryRoute,"activity_continuation");
  assert.equal(result.pullbackObserved,false);
});
test("one confirmed uptick over the full window is enough for continuation at 52% buy share",()=>{
  const result=sequence([1,1,1.01],{buys5m:55,sells5m:45});
  assert.equal(result.ready,true);
  assert.equal(result.entryRoute,"activity_continuation");
  assert.equal(result.risingSteps,1);
  assert.equal(result.currentBuyShare,0.55);
});
test("high steady volume and unchanged rolling counters remain eligible",()=>{
  const result=sequence([1,1.01,1.02]);
  assert.equal(result.volumeIncreasing,false);assert.equal(result.highVolume,true);
  assert.equal(result.flowBuys,null);assert.equal(result.flowSells,null);assert.equal(result.ready,true);
});
test("modest but growing activity can qualify without reaching the high-volume threshold",()=>{
  const tracker=createMomentumTracker(); let result;
  [1500,1800,2000].forEach((volume5m,i)=>{result=tracker.observe({...base,volume5m,buys5m:20,sells5m:10,
    priceUsd:1+i/100},i*30000);});
  assert.equal(result.ready,true);assert.equal(result.highVolume,false);
});
test("low flat activity, falling prices, flat prices and one-bounce falling knives fail",()=>{
  assert.equal(sequence([1,1.01,1.02],{volume5m:2000}).ready,false);
  assert.equal(sequence([1,0.99,0.98]).ready,false);
  assert.equal(sequence([1,1,1]).ready,false);
  assert.equal(sequence([1,0.5,0.51]).ready,false);
});
test("a deep historical decline does not permanently block a new rising window",()=>{
  const tracker=createMomentumTracker();let result;
  [1,0.4,0.41,0.42].forEach((priceUsd,i)=>{result=tracker.observe({...base,priceUsd},i*30000);});
  assert.equal(result.ready,true);assert.ok(result.retracePercent>45);
});
test("a verified local recovery can enter before reclaiming the start of the whole window",()=>{
  const tracker=createMomentumTracker();let result;
  [1,0.8,0.81,0.82].forEach((priceUsd,i)=>{result=tracker.observe({...base,priceUsd},i*20000);});
  assert.equal(result.ready,true);assert.equal(result.entryRoute,"local_recovery");
});
test("weak buying, insufficient liquidity and stale signals still fail",()=>{
  assert.equal(sequence([1,1.01,1.02],{buys5m:40,sells5m:60}).ready,false);
  assert.equal(sequence([1,1.01,1.02],{liquidityUsd:100}).ready,false);
  const coin={...base,priceUsd:1,pairCreatedAt:0,momentumPattern:{ready:true,observedAt:1000}};
  assert.ok(getMomentumFailureReasons(coin,100000).includes("staleMomentumConfirmation"));
});


test("strong activity permits a single upward step across a full flat-cache window",()=>{
  assert.equal(sequence([1,1,1.01]).ready,true);
  assert.equal(sequence([1,1,1.01]).strongActivityContinuation,true);
  assert.equal(sequence([1,1,1.01],{buys5m:51,sells5m:49}).ready,false);
  assert.equal(sequence([1,1,1.01],{volume5m:4999}).ready,false);
  assert.equal(sequence([1,1,1.01],{buys5m:29,sells5m:20}).ready,false);
  assert.equal(sequence([1,0.5,0.51]).ready,false);
  assert.equal(sequence([1,1.01,1.005]).ready,false);
  assert.equal(sequence([1,1,1]).ready,false);
  const tracker=createMomentumTracker();
  tracker.observe({...base,priceUsd:1},0);
  tracker.observe({...base,priceUsd:1},20000);
  assert.equal(tracker.observe({...base,priceUsd:1.01},40000).ready,false);
  assert.equal(tracker.observe({...base,priceUsd:1.02},120000).ready,false);
});
