const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const localRequire=createRequire(path.join(__dirname,'../profitSniper.js'));
const {createSniperEntryGuard}=require('../profitSniperEntryGuard');
function setup(){
 let now=1800000000000,options;
 let coin={chainId:'solana',tokenAddress:'mint-parallel',pairAddress:'pool-parallel',symbol:'TEST',
   pairCreatedAt:now-15*60000,priceUsd:1,liquidityUsd:25000,volume5m:10000,volume24h:100000,
   buys5m:100,sells5m:30,priceChange5m:2};
 const source=fs.readFileSync(path.join(__dirname,'../profitSniper.js'),'utf8');
 const context={module:{exports:{}},__dirname:path.join(__dirname,'..'),process:{env:{}},
   Date:class extends Date{static now(){return now;}},console:{log(){},warn(){},error(){}},
   require(name){
     if(name==='node:fs')return {existsSync:()=>false,readFileSync(){throw Error('no saved state');},writeFileSync(){},renameSync(){}};
     if(name==='./profitSniperDexDiscovery')return {discoverCandidates:async()=>[coin],getScanDiagnostics:()=>({})};
     if(name==='./paperTrader')return {createPaperTrader:()=>({getPortfolio:()=>({cashBalance:200,positions:[],history:[]})})};
     if(name==='./profitSniperReconcile')return {reconcileProfitSniperAccount:()=>({reason:'no-account'})};
     if(name==='./bot')return {createBot:o=>{options=o;return {};}};
     if(name==='./profitSniperPrebuy')return {createEntryGuard:()=>({})};
     if(name==='./profitSniperEntryGuard')return {createSniperEntryGuard:()=>createSniperEntryGuard({clock:()=>now})};
     return localRequire(name);
   }};
 vm.runInNewContext(source,context);
 return {scan:async(at,overrides={})=>{now=at;coin={...coin,...overrides};return options.discoverCandidates();}};
}
test('pool stability accumulates during momentum warmup; entry can qualify at 60 seconds',async()=>{
 const f=setup(),start=1800000000000;
 assert.equal((await f.scan(start)).length,0);
 assert.equal((await f.scan(start+30000,{priceUsd:1.01})).length,0);
 const ready=await f.scan(start+60000,{priceUsd:1.02});
 assert.equal(ready.length,1);
 assert.equal(ready[0].momentumPattern.ready,true);
 assert.equal(ready[0].signal,'ORDER FLOW BUY');
});
test('a pool collapse still resets stability even when the price pattern qualifies',async()=>{
 const f=setup(),start=1800000000000;
 await f.scan(start);await f.scan(start+30000,{priceUsd:1.01});
 assert.equal((await f.scan(start+60000,{priceUsd:1.02,liquidityUsd:12000})).length,0);
});
