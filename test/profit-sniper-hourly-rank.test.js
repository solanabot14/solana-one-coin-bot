const test=require("node:test");
const assert=require("node:assert/strict");
const {hourlyRank,compareHourly}=require("../profitSniperHourlyRank");
const base={volume1h:100000,buys1h:700,sells1h:300,priceChange1h:10,volume5m:1000};
test("hourly volume, transactions, buy share and movement independently raise priority",()=>{
  for(const improved of [
    {...base,volume1h:1000000}, {...base,buys1h:1400,sells1h:600},
    {...base,buys1h:900,sells1h:100}, {...base,priceChange1h:30}
  ]) assert.ok(hourlyRank(improved).score>hourlyRank(base).score);
});
test("one-hour activity takes priority over a short five-minute spike",()=>{
  const sustained={...base,volume1h:1000000,volume5m:5000};
  const spike={...base,volume1h:10000,volume5m:100000};
  assert.equal([spike,sustained].sort(compareHourly)[0],sustained);
});
test("missing hourly metrics stay explicitly unverified rather than fabricated",()=>{
  assert.equal(hourlyRank({...base,volume1h:null}).verified,false);
  assert.equal(hourlyRank({...base,buys1h:undefined}).verified,false);
  assert.equal(hourlyRank({...base,sells1h:-1}).verified,false);
  assert.equal(hourlyRank({...base,volume1h:0,buys1h:0,sells1h:0}).verified,true);
});
test("large hourly price spikes are capped and cannot dominate the ranking",()=>{
  assert.equal(hourlyRank({...base,priceChange1h:10000}).score,
    hourlyRank({...base,priceChange1h:50}).score);
  assert.ok(hourlyRank({...base,priceChange1h:-50}).score<hourlyRank(base).score);
});
test("strong hourly activity cannot override failed five-minute or security entry gates",()=>{
  const {getMomentumFailureReasons}=require("../profitSniperStrategy");
  const coin={...base,volume1h:1000000,chainId:"solana",tokenAddress:"hour-mint",
    pairAddress:"hour-pool",pairCreatedAt:Date.now()-600000,priceUsd:1,liquidityUsd:25000,
    volume5m:100,buys5m:40,sells5m:10,priceChange5m:2,priceChange1h:10,momentumPattern:{ready:true}};
  assert.equal(hourlyRank(coin).verified,true);
  assert.ok(getMomentumFailureReasons(coin).includes("volume5m"));
});
