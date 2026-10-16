"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {createOutcomeBot}=require("../outcomeBot");

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cb-v2-"));
  const timers={setInterval:()=>({unref(){}}),clearInterval:()=>{}};
  const bot=createOutcomeBot({file:path.join(dir,"state.json"),timers,fetchImpl:()=>new Promise(()=>{})});
  return {bot,dir};
}
function candidate(productId="SOL-USD",priceUsd=100){
  return {productId,symbol:productId.split("-")[0],priceUsd,dayChangePercent:25,hourChangePercent:3,fiveMinChangePercent:1,volumeUsd:5_000_000,pullbackPercent:3,volumeRatio:1.5,entrySetup:"PULLBACK_RECLAIM",score:100};
}
function candles(at){
  const end=Math.floor(at/300_000)*300;
  const first=end-288*300;
  const rows=[];
  for(let i=0;i<288;i++){
    let close=90+i*(20/287)+Math.sin(i*0.9)*0.18;
    if(i>=276&&i<280) close=112.5-(i-276)*0.7;
    if(i>=280&&i<287) close=109.7+(i-280)*0.10;
    if(i===286) close=110.0;
    if(i===287) close=110.5;
    const open= i===287 ? 110.1 : close-0.08;
    const high= i===276 ? 113 : (i===286 ? 110.35 : (i===287 ? 110.7 : close+0.12));
    const low= i===278 ? 109.1 : close-0.14;
    rows.push({time:first+i*300,open,high,low,close,volume:i>=285&&i<287?5000:1000});
  }
  return rows;
}

test("accepts a strong top-gainer pullback reclaim",()=>{
  const {bot,dir}=fixture();
  try{
    const at=1_800_000_000_000;
    const r=bot.assessCandidate("SOL-USD",{last:"110.5",open:"90",volume:"50000"},candles(at),at);
    assert.equal(r.accepted,true);
    assert.equal(r.candidate.entrySetup,"PULLBACK_RECLAIM");
    assert.ok(r.candidate.dayChangePercent>=8);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("rejects movers beyond the 25% chase cap",()=>{
  const {bot,dir}=fixture();
  try{
    const at=1_800_000_000_000,first=Math.floor(at/300_000)*300-13*300;
    const c=Array.from({length:13},(_,i)=>({time:first+i*300,open:i===12?100.2:100,low:99.9,high:i===12?102.2:100.2,close:i===12?102:100.05,volume:i===12?1800:1000}));
    const r=bot.assessCandidate("HOT-USD",{last:"102",open:"55",volume:"50000"},c,at);
    assert.equal(r.accepted,false);
    assert.ok(r.reasons.some(reason=>reason.includes("24h gain above +25%")));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("new positions use 40-30-30 exits and a fee-cushioned 1.75% runner trail",async()=>{
  const {bot,dir}=fixture();
  try{
    bot.start();
    assert.equal(bot.buy(candidate()).success,true);
    let p=bot.getState().openPositions[0];
    assert.equal(p.hardStopPercent,2.0);
    const prices=[p.entryPrice*1.05,p.entryPrice*1.08];
    bot.stop();
    const saved=bot.getState(); saved.running=true; fs.writeFileSync(path.join(dir,"state.json"),JSON.stringify(saved));
    let ix=0;
    const b=createOutcomeBot({file:path.join(dir,"state.json"),fetchImpl:async()=>({ok:true,status:200,json:async()=>({price:String(prices[ix++]),bid:"100",ask:"100.1"})})});
    await b.monitorOnce();
    p=b.getState().openPositions[0];
    assert.equal(p.tp1Done,true);
    assert.ok(Math.abs(p.quantity/p.originalQuantity-0.6)<1e-8);
    await b.monitorOnce();
    p=b.getState().openPositions[0];
    assert.equal(p.tp2Done,true);
    assert.equal(p.runnerTrailActive,true);
    assert.ok(Math.abs(p.quantity/p.originalQuantity-0.3)<1e-8);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("winner compounds only after the whole trade closes",()=>{
  const {bot,dir}=fixture();
  try{
    bot.start(); bot.buy(candidate());
    const p=bot.getState().openPositions[0];
    assert.equal(bot.closePosition(p.id,p.entryPrice*1.2,"MANUAL TEST").success,true);
    assert.equal(bot.getState().nextEntryUsd,11);
  }finally{bot.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test("old Coinbase positions keep their previous exit rules",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cb-legacy-"));
  try{
    const at=1_800_000_000_000,entryTime=new Date(at-60_000).toISOString();
    const legacy={id:"legacy-position",productId:"SOL-USD",symbol:"SOL",entryPrice:100,marketEntryPrice:100,highestPrice:100,quantity:0.1,notionalUsd:10,costBasisUsd:10.06,entryFeeUsd:0.06,entryTime,markPriceUsd:100};
    const file=path.join(dir,"state.json");
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,startingBalanceUsd:200,cashUsd:189.94,openPositions:[legacy],history:[],rejections:[],lastScanAt:null,lastError:null,running:true,nextEntryUsd:10,dailyPnlUsd:0,dailyPnlDate:new Date(at).toISOString().slice(0,10),pausedForDailyLoss:false}));
    const bot=createOutcomeBot({file,now:()=>at,fetchImpl:async()=>({ok:true,status:200,json:async()=>({price:"106"})})});
    await bot.monitorOnce();
    assert.equal(bot.getState().openPositions.length,0);
    assert.match(bot.getState().history[0].reason,/LEGACY TAKE PROFIT \+5%/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
