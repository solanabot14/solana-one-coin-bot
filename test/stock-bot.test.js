const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStockBot,SYMBOLS,assess}=require('../stockBot');
const time=Date.parse('2026-10-14T15:00:00Z');
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-bot-')),file=path.join(dir,'state.json');let bid=104,open=true,calls=[];
  const bars=Array.from({length:20},(_,i)=>({t:new Date(time-(21-i)*86400000).toISOString(),c:i===19?103:100,h:i>=15?105:101}));
  const snapshots=()=>Object.fromEntries(SYMBOLS.map(symbol=>[symbol,{latestQuote:{bp:bid,ap:bid+0.01,t:new Date(time).toISOString()},minuteBar:{o:103.9,c:104,t:new Date(time-60000).toISOString()}}]));
  const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('/clock')?{is_open:open,timestamp:new Date(time).toISOString(),next_open:'2026-10-15T13:30:00Z'}:url.includes('/snapshots')?snapshots():{bars:Object.fromEntries(SYMBOLS.map(s=>[s,bars])),next_page_token:null}};};
  const bot=createStockBot({file,env:{ALPACA_PAPER_API_KEY:'test',ALPACA_PAPER_SECRET_KEY:'test'},fetchImpl,now:()=>time,timers:{setInterval:()=>1,clearInterval:()=>{}}});
  async function settle(){for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));}
  return {bot,file,calls,bars,snapshots,settle,setBid:n=>bid=n,setOpen:b=>open=b,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('missing credentials: $100 visible and no network activity',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-missing-'));let calls=0;
  const bot=createStockBot({file:path.join(dir,'state.json'),env:{},fetchImpl:()=>{calls++;throw Error('unexpected');},timers:{setInterval:()=>1,clearInterval:()=>{}}});
  bot.start();await bot.tick();assert.equal(calls,0);assert.equal(bot.getStatus().connection,'WAITING_FOR_ALPACA');assert.equal(bot.getStatus().running,false);assert.equal(bot.getDashboardData().equity,100);bot.stop();fs.rmSync(dir,{recursive:true,force:true});
});
test('three fractional slots, no duplicates, persisted accounting and stop gap execution',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();assert.equal(f.bot.getState().openPositions.length,3);assert.ok(f.bot.getState().cashUsd<70);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);f.setBid(99);await f.bot.tick();const s=f.bot.getState();assert.equal(s.openPositions.length,0);assert.equal(s.history.filter(r=>r.type==='SELL').length,3);const pnl=s.history.filter(r=>r.type==='SELL').reduce((sum,r)=>sum+r.pnl,0);assert.ok(Math.abs(s.cashUsd-100-pnl)<1e-9);assert.ok(s.history.find(r=>r.type==='SELL').pnlPercent<-2);assert.equal(f.calls.some(c=>c.options.method!=='GET'||c.url.includes('/orders')),false);f.bot.stop();const restored=createStockBot({file:f.file});assert.equal(restored.getDashboardData().cashBalance,s.cashUsd);}finally{f.cleanup();}
});
test('trailing activation stays armed when price falls below activation gain',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();f.setBid(106.5);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);f.setBid(104.8);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);assert.ok(f.bot.getState().history.filter(r=>r.type==='SELL').every(r=>r.reason.includes('TRAIL')));}finally{f.cleanup();}
});
test('closed market and stale quotes cannot create trades',async()=>{
  const f=fixture();try{f.setOpen(false);f.bot.start();await f.settle();assert.equal(f.bot.getState().history.length,0);assert.equal(f.calls.length,1);const s=f.snapshots().SPY;s.latestQuote.t=new Date(time-300000).toISOString();assert.equal(assess(s,f.bars,time).accepted,false);}finally{f.cleanup();}
});
