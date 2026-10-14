"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOutcomeBot } = require("../outcomeBot");

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"outcome-bot-"));
  const timers={ setInterval:()=>({unref(){}}), clearInterval:()=>{} };
  const bot=createOutcomeBot({file:path.join(dir,"state.json"),timers,fetchImpl:()=>new Promise(()=>{})});
  return {bot,dir};
}
function candidate(productId="SOL-USD",priceUsd=100) {
  return {productId,symbol:productId.split("-")[0],priceUsd,dayChangePercent:5,hourChangePercent:1,fiveMinChangePercent:0.5,volumeUsd:10_000_000,pullbackLow:priceUsd*0.98,riskPercent:2,score:20};
}
test("Coinbase Bot accepts liquid daily movers only after a 5m pullback reclaim",()=>{
  const {bot,dir}=fixture();
  try {
    const at=1_800_000_000_000, first=Math.floor(at/300_000)*300-13*300;
    const closes=[106,107,108,109,110,111,110.2,109.7,109.2,109.5,109.7,109.6,110.2];
    const candles=closes.map((close,i)=>({time:first+i*300,open:i===12?109.9:close-0.2,low:i===8?108.2:close-0.4,high:i<6?close+0.3:i===11?109.8:close+0.1,close,volume:i===12?1500:1000}));
    const good=bot.assessCandidate("SOL-USD",{last:"110.2",open:"90",volume:"100000"},candles,at);
    assert.equal(good.accepted,true);
    assert.ok(good.candidate.dayChangePercent>15);
    const falling=bot.assessCandidate("SOL-USD",{last:"89",open:"90",volume:"100000"},candles,at);
    assert.equal(falling.accepted,false);
    assert.ok(falling.reasons.length>0);
    const noReclaim=candles.map((c,i)=>i===12?{...c,close:109.7,open:109.8,high:109.9}:c);
    assert.equal(bot.assessCandidate("SOL-USD",{last:"110.2",open:"90",volume:"100000"},noReclaim,at).accepted,false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test("six $10 positions respect cash, reject duplicates, and compound only a winning exit",()=>{
  const {bot,dir}=fixture();
  try {
    bot.start();
    for(let i=0;i<6;i++) assert.equal(bot.buy(candidate("COIN"+i+"-USD")).success,true);
    assert.equal(bot.getState().openPositions.length,6);
    assert.equal(bot.buy(candidate("LAST-USD")).success,false);
    assert.equal(bot.buy(candidate("COIN0-USD")).success,false);
    const first=bot.getState().openPositions[0];
    assert.equal(first.initialStopPriceUsd<first.entryPrice,true);
    assert.equal(bot.closePosition(first.id,first.entryPrice*1.06,"TRAIL EXIT").success,true);
    assert.equal(bot.getState().nextEntryUsd,11);
    const second=bot.getState().openPositions[0];
    assert.equal(bot.closePosition(second.id,second.entryPrice*0.95,"PULLBACK HARD STOP").success,true);
    assert.equal(bot.getState().nextEntryUsd,10);
  } finally { bot.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});
test("stopping preserves open paper positions",()=>{
  const {bot,dir}=fixture();
  try { bot.start(); bot.buy(candidate()); bot.stop(); assert.equal(bot.getState().running,false); assert.equal(bot.getState().openPositions.length,1); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("mover scan discovers active Coinbase USD pairs and blocks a matching risk headline",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"coinbase-movers-"));
  try {
    const at=1_800_000_000_000,first=Math.floor(at/300_000)*300-13*300;
    const closes=[106,107,108,109,110,111,110.2,109.7,109.2,109.5,109.7,109.6,110.2];
    const candleRows=closes.map((close,i)=>[first+i*300,i===8?108.2:close-0.4,i<6?close+0.3:i===11?109.8:close+0.1,i===12?109.9:close-0.2,close,i===12?1500:1000]);
    const products=[{id:"SOL-USD",base_currency:"SOL",quote_currency:"USD",status:"online"},
      {id:"SOL-USDC",base_currency:"SOL",quote_currency:"USDC",status:"online"},
      {id:"USDC-USD",base_currency:"USDC",quote_currency:"USD",status:"online",fx_stablecoin:true}];
    const volumeSummary=[[{id:"SOL-USD",quote_currency:"USD",market_types:["spot"],spot_volume_24hour:"1000000"}]];
    const fetchImpl=async url=>({ok:true,status:200,json:async()=>url.endsWith("/products")?products:url.endsWith("/volume-summary")?volumeSummary:url.includes("/stats")?{last:"110.2",open:"90",volume:"100000"}:candleRows});
    const baseState={schemaVersion:1,startingBalanceUsd:200,cashUsd:200,openPositions:[],history:[],rejections:[],lastScanAt:null,lastError:null,
      running:true,nextEntryUsd:10,dailyPnlUsd:0,dailyPnlDate:new Date(at).toISOString().slice(0,10),pausedForDailyLoss:false};
    const create=flagged=>{
      const file=path.join(dir,flagged?"flagged.json":"clean.json");fs.writeFileSync(file,JSON.stringify(baseState));
      return createOutcomeBot({file,fetchImpl,now:()=>at,timers:{setInterval:()=>({unref(){}}),clearInterval:()=>{}},newsProvider:{
        refresh:async()=>({status:"FRESH"}),getState:()=>({status:"FRESH",items:[]}),
        riskForProduct:()=>flagged?{title:"Solana exploit reported",term:"exploit",source:"CoinDesk",publishedAt:new Date(at).toISOString()}:null
      }});
    };
    const clean=create(false);await clean.scanOnce();
    assert.equal(clean.getState().openPositions.length,1);
    assert.equal(clean.getState().openPositions[0].productId,"SOL-USD");
    assert.ok(clean.getState().openPositions[0].entryMetrics.dayChangePercent>15);
    const flagged=create(true);await flagged.scanOnce();
    assert.equal(flagged.getState().openPositions.length,0);
    assert.match(flagged.getState().rejections[0].reason,/News risk flag/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("open positions from the previous rules keep their original paper exits",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"coinbase-legacy-"));
  try {
    const at=1_800_000_000_000,entryTime=new Date(at-60_000).toISOString();
    const legacy={id:"legacy-position",productId:"SOL-USD",tokenAddress:"SOL-USD",symbol:"SOL",entryPrice:100,marketEntryPrice:100,
      highestPrice:100,quantity:0.1,notionalUsd:10,costBasisUsd:10.06,entryFeeUsd:0.06,entryTime,markPriceUsd:100};
    const file=path.join(dir,"state.json");
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,startingBalanceUsd:200,cashUsd:189.94,openPositions:[legacy],history:[],rejections:[],
      lastScanAt:null,lastError:null,running:true,nextEntryUsd:10,dailyPnlUsd:0,dailyPnlDate:new Date(at).toISOString().slice(0,10),pausedForDailyLoss:false}));
    const bot=createOutcomeBot({file,now:()=>at,fetchImpl:async()=>({ok:true,status:200,json:async()=>({price:"106"})})});
    await bot.monitorOnce();
    assert.equal(bot.getState().openPositions.length,0);
    assert.match(bot.getState().history[0].reason,/LEGACY TAKE PROFIT \+5%/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
