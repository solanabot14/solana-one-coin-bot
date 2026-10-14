"use strict";
// Local paper ledger only. No broker order endpoint exists in this module.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SYMBOLS = ['SPY','QQQ','AAPL','MSFT','AMZN','GOOGL','META','NVDA'];
const STRATEGY = 'Daily uptrend + pullback recovery; $10 entries, 3 slots; +4% target, -2% stop trigger, 1.5% trail after +2%; 5 calendar day time exit. Local paper simulation only.';
const DAY = 86400000, SLIPPAGE = 0.0005, FEE = 0.0001;
const dateKey = t => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const valid = n => Number.isFinite(n) && n > 0;
function quote(snapshot, now) {
  const q = snapshot?.latestQuote;
  const age = now - Date.parse(q?.t);
  if (!valid(q?.bp) || !valid(q?.ap) || q.ap < q.bp || !Number.isFinite(age) || age < -5000 || age > 120000) return null;
  return {bid:q.bp, ask:q.ap, mid:(q.bp+q.ap)/2, spreadPercent:(q.ap/q.bp-1)*100, time:q.t};
}
function assess(snapshot, bars, now) {
  const q = quote(snapshot, now);
  if (!q) return {accepted:false, reason:'Fresh bid/ask unavailable'};
  if (q.spreadPercent > 0.2) return {accepted:false,reason:'Spread exceeds 0.2%'};
  const daily = (bars || []).filter(b => dateKey(Date.parse(b.t)) < dateKey(now)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)).slice(-20);
  if (daily.length < 20 || daily.some(b=>!valid(b.c)||!valid(b.h))) return {accepted:false,reason:'Need 20 completed daily bars'};
  const sma = daily.reduce((s,b)=>s+b.c,0)/20;
  const prev = daily.at(-1), high = Math.max(...daily.slice(-5).map(b=>b.h));
  const pullback = (high/q.mid-1)*100;
  const minute = snapshot?.minuteBar;
  const minuteAge = now-Date.parse(minute?.t);
  const recovering = valid(minute?.c) && valid(minute?.o) && minute.c > minute.o && Number.isFinite(minuteAge) && minuteAge >= 0 && minuteAge <= 180000;
  const accepted = prev.c > sma && q.mid > sma && pullback >= 0.5 && pullback <= 5 && q.mid > prev.c && recovering;
  return {accepted, reason:accepted?'Daily uptrend and pullback recovery confirmed':'Waiting for uptrend, 0.5–5% pullback and recovery above previous close', quote:q, score:pullback};
}
function createStockBot({file=path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname,'stock-paper-state.json'), env=process.env, io=fs, fetchImpl=globalThis.fetch, now=()=>Date.now(), timers=globalThis}={}) {
  let state={schemaVersion:1,startingBalanceUsd:100,cashUsd:100,openPositions:[],history:[],running:false,lastScanAt:null,lastError:null,rejections:[],closedDates:{},peakEquityUsd:100,maxDrawdownPercent:0};
  if (io.existsSync(file)) state=JSON.parse(io.readFileSync(file,'utf8'));
  function validate(s) {
    if (s.schemaVersion!==1 || s.startingBalanceUsd!==100 || !Number.isFinite(s.cashUsd) || s.cashUsd < -1e-8 || !Array.isArray(s.openPositions) || s.openPositions.length>3 || !Array.isArray(s.history) || !Array.isArray(s.rejections) || !s.closedDates || new Set(s.openPositions.map(p=>p.symbol)).size!==s.openPositions.length || s.openPositions.some(p=>!valid(p.quantity)||!valid(p.costBasisUsd)||!valid(p.markPriceUsd))) throw Error('Invalid Stock Bot state; refusing to reset saved account');
  }
  validate(state);
  let timer=null,busy=false,generation=0,marketOpen=null,nextOpen=null,connection='WAITING_FOR_ALPACA',barsCache={},barsDate=null;
  const configured = () => !!(env.ALPACA_PAPER_API_KEY && env.ALPACA_PAPER_SECRET_KEY);
  function commit(s) {
    validate(s); io.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';
    try {io.writeFileSync(tmp,JSON.stringify(s,null,2),{flag:'wx',flush:true});io.renameSync(tmp,file);} finally {if(io.existsSync(tmp))io.unlinkSync(tmp);}
    state=s;
  }
  async function request(url) {
    const u = new URL(url);
    if (!['data.alpaca.markets','paper-api.alpaca.markets'].includes(u.hostname)) throw Error('Unexpected market data host');
    const r=await fetchImpl(url,{method:'GET',signal:AbortSignal.timeout(10000),headers:{'APCA-API-KEY-ID':env.ALPACA_PAPER_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_PAPER_SECRET_KEY}});
    if (!r.ok) throw Error('Alpaca connection HTTP '+r.status);
    return r.json();
  }
  async function refreshBars() {
    if(barsDate===dateKey(now()))return;
    let page=null, all={};
    do {
      const p=new URLSearchParams({symbols:SYMBOLS.join(','),timeframe:'1Day',start:new Date(now()-70*DAY).toISOString(),end:new Date(now()-16*60000).toISOString(),limit:'10000',feed:'iex',adjustment:'all',sort:'asc'});
      if(page)p.set('page_token',page);
      const r=await request('https://data.alpaca.markets/v2/stocks/bars?'+p);
      for(const [sym,rows] of Object.entries(r.bars||{}))all[sym]=(all[sym]||[]).concat(rows);
      page=r.next_page_token;
    }while(page);
    barsCache=all;barsDate=dateKey(now());
  }
  function buy(symbol,q) {
    if(!state.running||state.openPositions.length>=3||state.openPositions.some(p=>p.symbol===symbol)||state.closedDates[symbol]===dateKey(now())||state.cashUsd<10*(1+FEE))return false;
    const s=structuredClone(state), entryPrice=q.ask*(1+SLIPPAGE), quantity=10/entryPrice;
    const p={id:randomUUID(),symbol,tokenAddress:symbol,entryPrice,quantity,notionalUsd:10,costBasisUsd:10*(1+FEE),entryFeeUsd:10*FEE,highestPrice:q.bid,markPriceUsd:q.bid,entryTime:new Date(now()).toISOString(),strategy:STRATEGY};
    s.cashUsd-=p.costBasisUsd;s.openPositions.push(p);
    s.history.unshift({...p,type:'BUY',positionId:p.id,amountUsd:10,amountInvested:p.costBasisUsd,time:p.entryTime,entryReason:'Daily uptrend and pullback recovery',mode:'PAPER'});commit(s);return true;
  }
  function sell(id,q,reason) {
    const s=structuredClone(state),i=s.openPositions.findIndex(p=>p.id===id);if(i<0)return;
    const p=s.openPositions[i],exitPrice=q.bid*(1-SLIPPAGE),gross=p.quantity*exitPrice,fee=gross*FEE,proceeds=gross-fee,pnl=proceeds-p.costBasisUsd,time=new Date(now()).toISOString();
    s.cashUsd+=proceeds;s.openPositions.splice(i,1);s.closedDates[p.symbol]=dateKey(now());
    s.history.unshift({...p,type:'SELL',positionId:p.id,exitPrice,exitTime:time,time,amountInvested:p.costBasisUsd,investedUsd:p.costBasisUsd,saleValueUsd:proceeds,amountUsd:proceeds,pnl,pnlUsd:pnl,pnlPercent:pnl/p.costBasisUsd*100,returnPercent:pnl/p.costBasisUsd*100,estimatedFeesUsd:p.entryFeeUsd+fee,exitReason:reason,reason,holdTimeMs:now()-Date.parse(p.entryTime),mode:'PAPER'});commit(s);
  }
  function updatePositions(snapshots) {
    for(const p of structuredClone(state.openPositions)) {
      const q=quote(snapshots[p.symbol],now());if(!q)continue;
      const s=structuredClone(state),current=s.openPositions.find(x=>x.id===p.id);
      current.markPriceUsd=q.bid;current.highestPrice=Math.max(current.highestPrice,q.bid);commit(s);
      const change=(q.bid/p.entryPrice-1)*100, peak=(current.highestPrice/p.entryPrice-1)*100;
      if(change<=-2)sell(p.id,q,'STOP TRIGGER -2%');
      else if(change>=4)sell(p.id,q,'TAKE PROFIT +4%');
      else if(peak>=2 && q.bid<=current.highestPrice*0.985)sell(p.id,q,'TRAIL 1.5% AFTER +2%');
      else if(now()-Date.parse(p.entryTime)>=5*DAY)sell(p.id,q,'TIME EXIT 5 CALENDAR DAYS');
    }
  }
  async function tick() {
    if(!state.running||busy)return;
    if(!configured()){connection='WAITING_FOR_ALPACA';return;}
    busy=true;const gen=generation;
    try {
      const clock=await request('https://paper-api.alpaca.markets/v2/clock');
      if(gen!==generation||!state.running)return;
      const age=now()-Date.parse(clock.timestamp);
      if(!Number.isFinite(age)||Math.abs(age)>120000||typeof clock.is_open!=='boolean')throw Error('Invalid or stale market clock');
      marketOpen=clock.is_open;nextOpen=clock.next_open;connection='CONNECTED';
      if(!marketOpen){const s=structuredClone(state);s.lastError=null;commit(s);return;}
      const snapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:SYMBOLS.join(','),feed:'iex'}));
      if(gen!==generation||!state.running)return;
      updatePositions(snapshots);
      await refreshBars();if(gen!==generation||!state.running)return;
      const ranked=[],rejections=[];
      for(const symbol of SYMBOLS){const a=assess(snapshots[symbol],barsCache[symbol],now());if(a.accepted)ranked.push({symbol,...a});else rejections.push({symbol,reason:a.reason,time:new Date(now()).toISOString()});}
      ranked.sort((a,b)=>b.score-a.score);for(const c of ranked)buy(c.symbol,c.quote);
      const s=structuredClone(state);s.lastScanAt=new Date(now()).toISOString();s.lastError=null;s.rejections=rejections;
      const eq=s.cashUsd+s.openPositions.reduce((v,p)=>v+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0);
      s.peakEquityUsd=Math.max(s.peakEquityUsd,eq);s.maxDrawdownPercent=Math.max(s.maxDrawdownPercent,(1-eq/s.peakEquityUsd)*100);commit(s);
    }catch(e){if(gen===generation){connection='CONNECTION_ERROR';const s=structuredClone(state);s.lastError=e.message;commit(s);}}
    finally{busy=false;}
  }
  function start(){if(timer)return;const s=structuredClone(state);s.running=true;commit(s);timer=timers.setInterval(()=>void tick(),60000);void tick();}
  function stop(){generation++;if(timer)timers.clearInterval(timer);timer=null;const s=structuredClone(state);s.running=false;commit(s);}
  async function closeAll(){
    if(busy)return {success:false,results:[{success:false,error:'Stock monitor busy; retry shortly'}]};
    if(!state.openPositions.length)return {success:true,results:[]};
    if(!configured())return {success:false,results:[{success:false,error:'Alpaca connection required to close stocks at current prices'}]};
    busy=true;const results=[];
    try{
      const clock=await request('https://paper-api.alpaca.markets/v2/clock');
      if(!clock.is_open||Math.abs(now()-Date.parse(clock.timestamp))>120000)throw Error('Stock market closed or market clock stale');
      const snapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:state.openPositions.map(p=>p.symbol).join(','),feed:'iex'}));
      for(const p of structuredClone(state.openPositions)){const q=quote(snapshots[p.symbol],now());if(q){sell(p.id,q,'MANUAL PAPER CLOSE');results.push({success:true,symbol:p.symbol});}else results.push({success:false,symbol:p.symbol,error:'Fresh exit bid unavailable'});}
    }catch(e){results.push({success:false,error:e.message});}finally{busy=false;}
    return {success:results.every(r=>r.success),results};
  }
  function getStatus(){return {running:state.running&&configured()&&connection==='CONNECTED',enabled:state.running,mode:'PAPER',connection:configured()?connection:'WAITING_FOR_ALPACA',marketOpen,nextOpen,lastScanAt:state.lastScanAt,lastError:state.lastError,statusMessage:!configured()?'Waiting for Alpaca paper API connection':!state.running?'Stopped':state.lastError||(!marketOpen?'Market closed; waiting for next session':'Monitoring stocks'),openPositions:state.openPositions.length,maxOpenPositions:3};}
  function getDashboardData(){
    const livePositions=state.openPositions.map(p=>{const value=p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),pnl=value-p.costBasisUsd;return {position:p,live:{priceUsd:p.markPriceUsd,currentValue:value,pnl,pnlPercent:pnl/p.costBasisUsd*100,holdTimeMs:now()-Date.parse(p.entryTime)},pnl};});
    const equity=state.cashUsd+livePositions.reduce((s,p)=>s+p.live.currentValue,0),totalPnl=equity-100;
    return {label:'Stock Bot',mode:'PAPER',paperOnly:true,simulation:'Local paper ledger; no broker orders',exchange:'Alpaca IEX market data',strategy:STRATEGY,startingBalance:100,startingBalanceUsd:100,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:totalPnl,livePositions,openPositions:livePositions,completedTrades:state.history.filter(r=>r.type==='SELL'),history:state.history,rejections:state.rejections,lastScanAt:state.lastScanAt,lastError:state.lastError,maxDrawdownPercent:state.maxDrawdownPercent,estimatedFeePercentPerSide:FEE*100,estimatedSlippagePercentPerSide:SLIPPAGE*100,nextTradeSizeUsd:10,maxOpenPositions:3,...getStatus(),openPositions:livePositions};
  }
  return {start,stop,tick,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state)};
}
let singleton;
const instance=()=>singleton||(singleton=createStockBot());
module.exports={createStockBot,assess,quote,SYMBOLS,STRATEGY,start:()=>instance().start(),stop:()=>instance().stop(),closeAll:()=>instance().closeAll(),getStatus:()=>instance().getStatus(),getDashboardData:()=>instance().getDashboardData()};
