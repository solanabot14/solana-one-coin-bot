const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const localRequire=createRequire(path.join(__dirname,'../profitSniper.js'));
const {createSniperEntryGuard}=require('../profitSniperEntryGuard');
function setup(history=[]){
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
     if(name==='./paperTrader')return {createPaperTrader:()=>({getPortfolio:()=>({cashBalance:200,positions:[],history})})};
     if(name==='./profitSniperReconcile')return {reconcileProfitSniperAccount:()=>({reason:'no-account'})};
     if(name==='./bot')return {createBot:o=>{options=o;return {};}};
     if(name==='./profitSniperPrebuy')return {createEntryGuard:()=>({})};
     if(name==='./profitSniperEntryGuard')return {createSniperEntryGuard:()=>createSniperEntryGuard({clock:()=>now})};
     return localRequire(name);
   }};
 vm.runInNewContext(source,context);
 return {options,scan:async(at,overrides={})=>{now=at;coin={...coin,...overrides};return options.discoverCandidates();}};
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


test('Sniper reentry uses its own fresh gates without the conflicting inherited V3.1 cap',async()=>{
 const start=1800000000000;
 const history=[{type:'BUY',tokenAddress:'mint-parallel'},{type:'SELL',tokenAddress:'mint-parallel',reason:'TRAILING STOP -12% FROM HIGH'}];
 const f=setup(history);
 assert.equal(f.options.useReentryGuards,false);
 assert.equal(f.options.useSimpleCooldown,false);
 await f.scan(start,{priceChange5m:-3});await f.scan(start+30000,{priceUsd:1.01,priceChange5m:-3});
 const ready=await f.scan(start+60000,{priceUsd:1.02,priceChange5m:-3});
 assert.equal(ready.length,1); // local recovery can qualify while the rolling 5m change is negative
 assert.equal(ready[0].signal,'ORDER FLOW BUY');
});
test('removing inherited reentry still blocks a mint after its hard stop',async()=>{
 const start=1800000000000;
 const history=[{type:'BUY',tokenAddress:'mint-parallel'},
  {type:'SELL',tokenAddress:'mint-parallel',reason:'HARD STOP -8%'}];
 const f=setup(history);await f.scan(start);await f.scan(start+30000,{priceUsd:1.01});
 assert.equal((await f.scan(start+60000,{priceUsd:1.02})).length,0);
});

test('actual scanner buys a verified Sniper reentry that the inherited filter incorrectly blocks',async()=>{
 const {createBot}=require('../bot');
 const history=[{type:'BUY',id:'old',positionId:'old',tokenAddress:'mint-parallel'},
  {type:'SELL',positionId:'old',tokenAddress:'mint-parallel',percentSold:100,pnl:1,exitTime:new Date().toISOString(),reason:'TRAILING STOP -12% FROM HIGH'}];
 const config=setup(history).options;
 const coin={chainId:'solana',tokenAddress:'mint-parallel',pairAddress:'pool-parallel',symbol:'TEST',
  pairCreatedAt:Date.now()-3600000,priceUsd:1,liquidityUsd:25000,volume5m:10000,
  buys5m:100,sells5m:30,priceChange5m:-3,signal:'ORDER FLOW BUY',momentumPattern:{ready:true}};
 for(const inherited of [true,false]) {
  let fills=0;
  const bot=createBot({...config,useReentryGuards:inherited,reentryStateFile:null,
   discoverCandidates:async()=>[coin],checkLiquidityLock:async()=>({allowed:true,lockedPercent:100}),
   validateEntry:async c=>({allowed:true,coin:c}),
   trader:{getPortfolio:()=>({cashBalance:200,positions:[],history}),
    buy:()=>{fills++;return {success:true,trade:{type:'BUY'}};},positionKey:p=>p.id},
   timers:{setInterval:()=>1,clearInterval(){}},notifier:{notifyTrade:async()=>{},notifyCritical:async()=>{}}});
  try{bot.startBot();await new Promise(r=>setImmediate(r));assert.equal(fills,inherited?0:1);}
  finally{bot.stopBot();}
 }
});
