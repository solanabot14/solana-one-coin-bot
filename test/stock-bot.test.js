const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStockBot,assess,sessionOpen}=require('../stockBot');
const MINUTE=60000,initialTime=Date.parse('2026-10-14T14:00:00Z');
test('60 stock watchlist includes Ford and is unique',()=>{
  const {SYMBOLS}=require('../stockBot');
  assert.equal(SYMBOLS.length,60);assert.equal(new Set(SYMBOLS).size,60);
  assert.ok(SYMBOLS.includes('F'));assert.ok(SYMBOLS.includes('GM'));
});
test('completed candles remain current between boundaries; stale quotes and missing candles still block',()=>{
  const f=fixture();try{
    const bars=f.bars();
    for(const offset of [0,2,3,4.9,6.9]){
      const time=initialTime+offset*MINUTE,snapshot={latestQuote:{bp:100.51,ap:100.52,t:new Date(time).toISOString()}};
      assert.equal(assess(snapshot,bars,time).accepted,true,'offset '+offset);
    }
    const time=initialTime+7.1*MINUTE;
    assert.match(assess({latestQuote:{bp:100.51,ap:100.52,t:new Date(time).toISOString()}},bars,time).reason,/Stale/);
    assert.match(assess(f.snapshots().SPY,bars,initialTime+3*MINUTE).reason,/Fresh bid/);
    assert.match(assess(f.snapshots().SPY,bars.filter((_,i)=>i!==3),initialTime).reason,/missing/);
  }finally{f.cleanup();}
});
test('spread and IEX value thresholds admit moderate cost setups and reject wider or thin ones',()=>{
  const f=fixture();try{
    const bars=f.bars(),s=f.snapshots().SPY;
    s.latestQuote.ap=s.latestQuote.bp*1.002;
    bars.forEach((b,i)=>b.v=i===5?500:250);
    assert.equal(assess(s,bars,initialTime).accepted,true);
    s.latestQuote.ap=s.latestQuote.bp*1.0026;
    assert.match(assess(s,bars,initialTime).reason,/Spread/);
    s.latestQuote.ap=s.latestQuote.bp+0.01;
    bars.forEach((b,i)=>b.v=i===5?200:100);
    assert.match(assess(s,bars,initialTime).reason,/25k/);
  }finally{f.cleanup();}
});
test('scan diagnostics include all stock symbols and disclose qualified account-limit skips',async()=>{
  const f=fixture();try{
    f.bot.start();await f.settle();
    let d=f.bot.getDashboardData().scanDiagnostics;
    assert.equal(d.scanned,60);assert.equal(d.qualified,3);assert.equal(d.entered,3);assert.ok(d.watchlist.includes('F'));
    f.setTime(initialTime+MINUTE);await f.bot.tick();
    d=f.bot.getDashboardData().scanDiagnostics;
    assert.equal(d.qualified,3);assert.equal(d.entered,0);
    assert.equal(d.skippedByReason['Setup qualified; position, cash, cooldown or daily entry limit'],3);
  }finally{f.cleanup();}
});
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
test('partial exits allocate costs once, compound only on completion and use winner cooldown',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();const original=f.bot.getState().openPositions[0];f.setBid(102);await f.bot.tick();let state=f.bot.getState();assert.equal(state.openPositions.length,3);assert.equal(state.nextEntryUsd,10);assert.equal(f.bot.getDashboardData().completedTrades.length,0);assert.equal(state.history.filter(r=>r.partial).length,3);assert.ok(Math.abs(state.openPositions[0].quantity-original.quantity/2)<1e-10);assert.ok(Math.abs(state.openPositions[0].costBasisUsd-original.costBasisUsd/2)<1e-10);await f.bot.tick();assert.equal(f.bot.getState().history.filter(r=>r.partial).length,3);f.setBid(101);await f.bot.tick();state=f.bot.getState();assert.equal(state.openPositions.length,0);assert.equal(state.nextEntryUsd,13.31);const trades=f.bot.getDashboardData().completedTrades;assert.equal(trades.length,3);assert.ok(trades.every(r=>Math.abs(r.amountInvested-10.001)<1e-8));assert.ok(Math.abs(state.cashUsd-100-trades.reduce((sum,r)=>sum+r.pnl,0))<1e-8);f.setTime(initialTime+MINUTE);f.setBid(100.51);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,0);f.setTime(initialTime+6*MINUTE);await f.bot.tick();assert.equal(f.bot.getState().openPositions.length,3);assert.ok(f.bot.getState().openPositions.every(r=>r.notionalUsd===13.31));}finally{f.cleanup();}
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
test('premarket ranks delayed movers without treating prices as executable quotes',()=>{
  const {rankPremarket}=require('../stockBot'),time=Date.parse('2026-10-14T10:00:00Z'),start=Date.parse('2026-10-14T08:00:00Z'),end=time-16*MINUTE;
  const bars={NVDA:[{t:'2026-10-14T09:35:00Z',o:103,h:104,l:102,c:104,v:2000,vw:103}],SPY:[{t:'2026-10-14T09:35:00Z',o:100,h:101,l:99,c:100,v:1000,vw:100}]};
  const rows=rankPremarket(bars,{NVDA:100,SPY:101},time,start,end);assert.equal(rows[0].symbol,'NVDA');assert.ok(Math.abs(rows[0].gapPercent-4)<1e-8);assert.equal(rows[0].dataAgeMinutes,20);assert.equal(rows[0].longWatchCandidate,true);
  bars.NVDA[0].t='2026-10-14T09:50:00Z';assert.equal(rankPremarket(bars,{NVDA:100},time,start,end).some(r=>r.symbol==='NVDA'),false);
});
test('premarket analysis refreshes at most once a minute, never buys, skips holidays',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-pre-'));let time=Date.parse('2026-10-14T10:00:00Z'),nextOpen='2026-10-14T09:30:00-04:00',calls=[];
  const fetchImpl=async(url)=>{calls.push(url);return {ok:true,json:async()=>url.includes('/clock')?{is_open:false,timestamp:new Date(time).toISOString(),next_open:nextOpen,next_close:'2026-10-14T16:00:00-04:00'}:new URL(url).searchParams.get('timeframe')==='1Day'?{bars:{NVDA:[{t:'2026-10-13T04:00:00Z',c:100}]}}:{bars:{NVDA:[{t:'2026-10-14T09:35:00Z',o:103,h:104,l:102,c:104,v:2000,vw:103}]}}};};
  const bot=createStockBot({file:path.join(dir,'state.json'),env:{ALPACA_PAPER_API_KEY:'test',ALPACA_PAPER_SECRET_KEY:'test'},fetchImpl,now:()=>time,timers:{setInterval:()=>1,clearInterval:()=>{}}});
  try{bot.start();for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));assert.equal(bot.getStatus().sessionMode,'PREMARKET_ANALYSIS');assert.equal(bot.getState().history.length,0);assert.equal(bot.getDashboardData().equity,100);assert.equal(bot.getDashboardData().premarketAnalysis.rankings[0].symbol,'NVDA');assert.equal(calls.filter(u=>u.includes('/bars?')).length,2);await bot.tick();assert.equal(calls.filter(u=>u.includes('/bars?')).length,2);time+=MINUTE;await bot.tick();assert.equal(calls.filter(u=>u.includes('/bars?')).length,3);assert.ok(calls.filter(u=>u.includes('/bars?')).every(u=>new URL(u).searchParams.get('feed')==='sip'));nextOpen='2026-10-15T09:30:00-04:00';time+=MINUTE;await bot.tick();assert.equal(bot.getStatus().sessionMode,'MARKET_CLOSED');assert.equal(calls.filter(u=>u.includes('/bars?')).length,3);}finally{bot.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('size growth caps at $20 and net losing completed trades reset to $10',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();for(let i=0;i<3;i++){f.setBid(102);await f.bot.tick();f.setBid(101);await f.bot.tick();if(i<2){f.setTime(initialTime+(i+1)*6*MINUTE);f.setBid(100.51);await f.bot.tick();}}assert.equal(f.bot.getState().nextEntryUsd,20);f.setTime(initialTime+18*MINUTE);f.setBid(100.51);await f.bot.tick();assert.ok(f.bot.getState().openPositions.every(p=>p.notionalUsd===20));f.setBid(98);await f.bot.tick();assert.equal(f.bot.getState().nextEntryUsd,10);f.bot.stop();assert.equal(createStockBot({file:f.file}).getDashboardData().nextTradeSizeUsd,10);}finally{f.cleanup();}
});
test('six entries per symbol per session cap and loss cooldown remains longer',async()=>{
  const f=fixture();try{f.bot.start();await f.settle();for(let i=0;i<6;i++){f.setBid(102);await f.bot.tick();f.setBid(101);await f.bot.tick();f.setTime(initialTime+(i+1)*6*MINUTE);f.setBid(100.51);await f.bot.tick();}assert.equal(f.bot.getState().openPositions.length,0);assert.equal(f.bot.getState().history.filter(r=>r.type==='BUY').length,18);}finally{f.cleanup();}
  const g=fixture();try{g.bot.start();await g.settle();g.setBid(99.5);await g.bot.tick();g.setTime(initialTime+6*MINUTE);g.setBid(100.51);await g.bot.tick();assert.equal(g.bot.getState().openPositions.length,0);g.setTime(initialTime+16*MINUTE);await g.bot.tick();assert.equal(g.bot.getState().openPositions.length,3);}finally{g.cleanup();}
});
test('three-bar opening signals qualify; partial plus losing runner counts total position result',async()=>{
  const f=fixture();try{assert.equal(assess(f.snapshots().SPY,f.bars().slice(-3),initialTime).accepted,true);f.bot.start();await f.settle();f.setBid(102);await f.bot.tick();f.setBid(97);await f.bot.tick();assert.equal(f.bot.getState().nextEntryUsd,10);assert.ok(f.bot.getDashboardData().completedTrades.every(r=>r.pnl<0));assert.equal(f.bot.getDashboardData().completedTrades.length,3);}finally{f.cleanup();}
});
