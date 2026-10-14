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
  return {productId,symbol:productId.split("-")[0],priceUsd,dayChangePercent:5,hourChangePercent:1,fiveMinChangePercent:0.5,volumeUsd:10_000_000,score:20};
}
test("Outcome Bot only accepts liquid, confirmed positive momentum",()=>{
  const {bot,dir}=fixture();
  try {
    const candles=Array.from({length:13},(_,i)=>{const close=108+i*0.15,open=i===12?close-0.25:close-0.05;return [i,open-0.1,close+0.2,open,close,1000];});
    const good=bot.assessCandidate("SOL-USD",{last:"110",open:"100",volume:"100000"},candles);
    assert.equal(good.accepted,true);
    const falling=bot.assessCandidate("SOL-USD",{last:"99",open:"100",volume:"100000"},candles);
    assert.equal(falling.accepted,false);
    assert.ok(falling.reasons.length>0);
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
    assert.equal(bot.closePosition(first.id,first.entryPrice*1.06,"TAKE PROFIT +5%").success,true);
    assert.equal(bot.getState().nextEntryUsd,11);
    const second=bot.getState().openPositions[0];
    assert.equal(bot.closePosition(second.id,second.entryPrice*0.95,"HARD STOP -3%").success,true);
    assert.equal(bot.getState().nextEntryUsd,10);
  } finally { bot.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});
test("stopping preserves open paper positions",()=>{
  const {bot,dir}=fixture();
  try { bot.start(); bot.buy(candidate()); bot.stop(); assert.equal(bot.getState().running,false); assert.equal(bot.getState().openPositions.length,1); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
