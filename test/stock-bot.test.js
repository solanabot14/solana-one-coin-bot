const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStockBot,assess,sessionOpen}=require('../stockBot');
const MINUTE=60000,initialTime=Date.parse('2026-10-14T14:00:00Z');
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-bot-')),file=path.join(dir,'state.json');
  let time=initialTime,bid=100.51,open=true,close='2026-10-14T16:00:00-04:00',stale=false,calls=[];
  const symbols=['SPY','QQQ','AAPL'];
  const bars=()=>Array.from({length:6},(_,i)=>({t:new Date(time-(6-i)*5*MINUTE).toISOString(),o:i===5?100.1:100,h:i===5?100.6:100.2,l:99.9,c:i===5?100.5:100.1,v:i===5?2000:1000,vw:i===5?100.3:100.05}));
  const snapshots=()=>Object.fromEntries(symbols.map(symbol=>[symbol,{latestQuote:{bp:bid,ap:bid+0.01,t:new Date(time-(stale?300000:0)).toISOString()}}]));
  const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('/clock')?{is_open:open,timestamp:new Date(time).toISOString(),next_open:'2026-10-15T13:30:00Z',next_close:close}:url.includes('/snapshots')?snapshots():{bars:Object.fromEntries(symbols.map(s=>[s,bars()])),next_page_token:null}};};
  const timers={setInterval:()=>1,clearInterval:()=>{}};
  const bot=createStockBot({file,env:{ALPACA_PAPER_API_KEY:'test',ALPACA_PAPER_SECRET_KEY:'test'},fetchImpl,now:()=>time,timers});
  async function settle(){for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));}
  return {bot,file,calls,bars,snapshots,settle,setBid:n=>bid=n,setOpen:b=>open=b,setTime:t=>time=t,setClose:t=>close=t,setStale:b=>stale=b,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('missing credentials: $100 visible, no requests or orders',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-missing-'));let calls=0;
  const bot=createStockBot({file:path.join(dir,'state.json'),env:{},fetchImpl:()=>{calls++;throw Error('unexpected');},timers:{setInterval:()=>1,clearInterval:()=>{}}});
  bot.start();await bot.tick();assert.equal(calls,0);assert.equal(bot.getStatus().connection,'WAITING_FOR_ALPACA');assert.equal(bot.getStatus().running,false);assert.equal(bot.getDashboardData().equity,100);bot.stop();fs.rmSync(dir,{recursive:true,force:true});
});
test('breakout, fractional sizing, three slots, duplicate prevention, gap accounting and restore',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();assert.equal(f.bot.getState().openPositions.length,3);assert.ok(f.bot.getState().cashUsd<70);assert.equal(f.bot.getState().openPositions[0].entryReason,'BREAKOUT');await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);f.setBid(98);await f.bot.tick();const s=f.bot.getState();assert.equal(s.openPositions.length,0);assert.equal(s.history.filter(r=>r.type==='SELL').length,3);const pnl=s.history.filter(r=>r.type==='SELL').reduce((sum,r)=>sum+r.pnl,0);assert.ok(Math.abs(s.cashUsd-100-pnl)<1e-9);assert.ok(s.history.find(r=>r.type==='SELL').pnlPercent<-0.8);assert.equal(f.calls.some(c=>c.options.method!=='GET'||c.url.includes('/orders')),false);assert.ok(f.calls.find(c=>c.url.includes('/bars?')).url.includes('timeframe=5Min'));f.bot.stop();assert.equal(createStockBot({file:f.file}).getDashboardData().cashBalance,s.cashUsd);}finally{f.cleanup();}
});
test('trailing stays armed below activation and cooldown blocks immediate reentry',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();f.setBid(101.4);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);f.setBid(100.8);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);assert.ok(f.bot.getState().history.filter(r=>r.type==='SELL').every(r=>r.reason.includes('TRAIL')));f.setTime(initialTime+MINUTE);f.setBid(100.51);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);f.setTime(initialTime+16*MINUTE);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);f.setBid(102.2);await f.bot.tick();f.setTime(initialTime+32*MINUTE);f.setBid(100.51);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);assert.equal(f.bot.getState().history.filter(r=>r.type==='BUY').length,6);}finally{f.cleanup();}
});
test('end-of-day flatten and no entries in last 30 minutes',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();f.setTime(Date.parse('2026-10-14T19:51:00Z'));await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);assert.ok(f.bot.getState().history.filter(r=>r.type==='SELL').every(r=>r.reason.includes('SESSION CLOSE')));assert.equal(f.bot.getStatus().sessionMode,'CLOSING_SESSION');}finally{f.cleanup();}
  const g=fixture();try{g.setTime(Date.parse('2026-10-14T19:35:00Z'));g.bot.start();await g.settle();assert.equal(g.bot.getState().history.length,0);assert.equal(g.bot.getStatus().sessionMode,'NO_NEW_ENTRIES');}finally{g.cleanup();}
});
test('shortened session flatten and DST-aware session opening',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();f.setClose('2026-10-14T13:00:00-04:00');f.setTime(Date.parse('2026-10-14T16:51:00Z'));await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);}finally{f.cleanup();}
  assert.equal(sessionOpen('2026-10-14T13:00:00-04:00'),Date.parse('2026-10-14T13:30:00Z'));
  assert.equal(sessionOpen('2026-12-14T16:00:00-05:00'),Date.parse('2026-12-14T14:30:00Z'));
});
test('closed market and stale data block fills; unresolved session exit stays visible',async()=>{
  const f=fixture();try{f.setOpen(false);f.bot.start();await f.settle();assert.equal(f.bot.getState().history.length,0);assert.equal(f.calls.length,1);const s=f.snapshots().SPY;s.latestQuote.t=new Date(initialTime-300000).toISOString();assert.equal(assess(s,f.bars(),initialTime).accepted,false);}finally{f.cleanup();}
  const g=fixture();try{g.bot.start();await g.settle();g.setTime(Date.parse('2026-10-14T19:51:00Z'));g.setStale(true);await g.bot.tick();assert.equal(g.bot.getState().openPositions.length,3);assert.match(g.bot.getStatus().lastError,/fresh quotes/);g.setOpen(false);await g.bot.tick();assert.equal(g.bot.getStatus().sessionMode,'EXIT_PENDING_MARKET_CLOSED');g.setTime(Date.parse('2026-10-15T13:31:00Z'));g.setClose('2026-10-15T16:00:00-04:00');g.setOpen(true);g.setStale(false);await g.bot.tick();assert.equal(g.bot.getState().openPositions.length,0);}finally{g.cleanup();}
});
test('daily loss pause preserves monitoring and blocks new buys',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();f.setBid(89);await f.bot.tick();assert.equal(f.bot.getStatus().sessionMode,'DAILY_LOSS_PAUSE');f.setTime(initialTime+16*MINUTE);f.setBid(100.51);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);}finally{f.cleanup();}
});
test('recovery entry requires rising volume; partial and stale bars are rejected',()=>{
  const f=fixture();try{const bars=f.bars();bars[3]={...bars[3],h:100.8,c:100.6};bars[4]={...bars[4],h:100.35,l:100.1,c:100.2};assert.equal(assess(f.snapshots().SPY,bars,initialTime).signal,'PULLBACK RECOVERY');assert.equal(assess(f.snapshots().SPY,bars,initialTime).accepted,true);bars[5].v=100;assert.equal(assess(f.snapshots().SPY,bars,initialTime).accepted,false);bars[5].t=new Date(initialTime-MINUTE).toISOString();assert.equal(assess(f.snapshots().SPY,bars,initialTime).accepted,false);}finally{f.cleanup();}
});
