// Discovery priority only: entry permission still comes from 5m and safety gates.
function hourlyRank(coin) {
  const volume=Number(coin?.volume1h), buys=Number(coin?.buys1h), sells=Number(coin?.sells1h);
  const change=Number(coin?.priceChange1h);
  const present=value=>value!==null && value!==undefined && value!=="";
  const verified=[coin?.volume1h,coin?.buys1h,coin?.sells1h,coin?.priceChange1h].every(present) &&
    [volume,buys,sells,change].every(Number.isFinite) && volume>=0 && buys>=0 && sells>=0;
  if(!verified)return {score:0,verified:false,volumeUsd:null,transactions:null,buyShare:null,priceChangePercent:null};
  const transactions=buys+sells;
  const buyShare=transactions>0 ? buys/transactions : 0;
  const score=40*Math.min(1,Math.log10(1+volume)/7) +
    30*Math.min(1,Math.log10(1+transactions)/5) + 20*buyShare +
    10*Math.max(0,Math.min(1,change/50));
  return {score:Number(score.toFixed(4)),verified:true,volumeUsd:volume,transactions,buyShare,priceChangePercent:change};
}
function compareHourly(a,b) {
  const left=hourlyRank(a),right=hourlyRank(b);
  return Number(right.verified)-Number(left.verified) || right.score-left.score ||
    (Number(b.volume5m)||0)-(Number(a.volume5m)||0);
}
module.exports={hourlyRank,compareHourly};
