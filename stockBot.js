"use strict";
// Local paper ledger only. No broker order endpoint exists in this module.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SYMBOLS = ['SPY','QQQ','IWM','DIA','AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA','AMD','AVGO','MU','INTC','PLTR','COIN','HOOD','UBER','NFLX','SHOP','SOFI','PYPL','CRM','ORCL','JPM','BAC','XOM','WMT','DIS'];
const STRATEGY = 'Premarket research from 4am ET (delayed consolidated data); intraday opportunity: scan 30 stocks/ETFs for volume-confirmed breakouts or pullback recoveries above session VWAP; $10 entries, 3 slots; +1.5% target, -0.8% stop trigger, 0.5% trail after +0.75%; max hold 90 min; close 10 min before market close. Local paper simulation only.';
const SLIPPAGE = 0.0005, FEE = 0.0001;
const MINUTE=60000, BAR_MS=5*MINUTE;
const dateKey = t => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const valid = n => Number.isFinite(n) && n > 0;
function quote(snapshot, now) {
  const q = snapshot?.latestQuote;
  const age = now - Date.parse(q?.t);
  if (!valid(q?.bp) || !valid(q?.ap) || q.ap < q.bp || !Number.isFinite(age) || age < -5000 || age > 120000) return null;
  return {bid:q.bp, ask:q.ap, mid:(q.bp+q.ap)/2, spreadPercent:(q.ap/q.bp-1)*100, time:q.t};
}
function sessionOpen(nextClose) {
  const close=Date.parse(nextClose);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date(close));
  const hour=Number(parts.find(p=>p.type==='hour').value),minute=Number(parts.find(p=>p.type==='minute').value);
  return close-((hour*60+minute)-(9*60+30))*MINUTE;
}
function assess(snapshot, bars, now, openAt=0) {
  const q = quote(snapshot, now);
  if (!q) return {accepted:false, reason:'Fresh bid/ask unavailable'};
  if (q.spreadPercent > 0.15) return {accepted:false,reason:'Spread exceeds 0.15%'};
  const session=(bars||[]).filter(b=>Date.parse(b.t)>=openAt && Date.parse(b.t)+BAR_MS<=now && dateKey(Date.parse(b.t))===dateKey(now)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  if(session.length<6)return {accepted:false,reason:'Waiting for six completed 5-minute session bars'};
  const recent=session.slice(-6),last=recent.at(-1),prev=recent.at(-2);
  if(session.some(b=>![b.o,b.h,b.l,b.c,b.v].every(valid)))return {accepted:false,reason:'Invalid intraday bars'};
  if(now-Date.parse(last.t)-BAR_MS>2*MINUTE||recent.some((b,i)=>i&&Date.parse(b.t)-Date.parse(recent[i-1].t)!==BAR_MS))return {accepted:false,reason:'Stale or missing 5-minute bars'};
  const volume=session.reduce((s,b)=>s+b.v,0),vwap=session.reduce((s,b)=>s+(valid(b.vw)?b.vw:(b.h+b.l+b.c)/3)*b.v,0)/volume;
  const move=(q.mid/session[0].o-1)*100,extension=(q.mid/vwap-1)*100;
  const average=recent.slice(0,-1).reduce((s,b)=>s+b.v,0)/5,relativeVolume=last.v/average;
  const peak=Math.max(...recent.slice(0,-2).map(b=>b.h)),dip=(peak/prev.l-1)*100;
  const breakout=last.c>Math.max(...recent.slice(0,-1).map(b=>b.h));
  const reclaim=prev.c<recent.at(-3).c && dip>=0.2 && dip<=2 && last.c>prev.h;
  const accepted=move>=0.3 && move<=8 && extension>=0 && extension<=3 && relativeVolume>=1.2 && last.v*last.c>=100000 && last.c>last.o && (last.c/last.o-1)*100<=2 && q.mid>=last.c*0.999 && (breakout||reclaim);
  const signal=breakout?'BREAKOUT':'PULLBACK RECOVERY';
  return {accepted,reason:accepted?signal+' above session VWAP with rising volume':'Waiting for fresh breakout/recovery, VWAP trend and 1.2x volume',signal,quote:q,score:relativeVolume*2+move,metrics:{vwap,movePercent:move,relativeVolume,extensionPercent:extension}};
}
function rankPremarket(barsBySymbol,reference,now,start,end) {
  const rows=[];
  for(const symbol of SYMBOLS){
    const bars=(barsBySymbol[symbol]||[]).filter(b=>Date.parse(b.t)>=start&&Date.parse(b.t)+BAR_MS<=end&&[b.o,b.h,b.l,b.c,b.v].every(valid)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
    if(!bars.length)continue;
    const last=bars.at(-1),volume=bars.reduce((s,b)=>s+b.v,0),dollarVolume=bars.reduce((s,b)=>s+b.v*b.c,0),vwap=bars.reduce((s,b)=>s+(valid(b.vw)?b.vw:(b.h+b.l+b.c)/3)*b.v,0)/volume;
    const prev=reference[symbol],gap=valid(prev)?(last.c/prev-1)*100:null,move=(last.c/bars[0].o-1)*100,high=Math.max(...bars.map(b=>b.h)),low=Math.min(...bars.map(b=>b.l));
    const asOf=Date.parse(last.t)+BAR_MS,ageMinutes=(now-asOf)/MINUTE;
    rows.push({symbol,lastPrice:last.c,previousClose:prev||null,gapPercent:gap,premarketMovePercent:move,volume,dollarVolume,vwap,high,low,aboveVwap:last.c>=vwap,dataAsOf:new Date(asOf).toISOString(),dataAgeMinutes:Math.round(ageMinutes),stale:ageMinutes>30,longWatchCandidate:gap!==null&&gap>0&&last.c>=vwap&&dollarVolume>=100000&&ageMinutes<=30,score:Math.abs(gap??move)*2+Math.log10(Math.max(dollarVolume,1))});
  }
  return rows.sort((a,b)=>b.score-a.score);
}
function createStockBot({file=path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname,'stock-paper-state.json'), env=process.env, io=fs, fetchImpl=globalThis.fetch, now=()=>Date.now(), timers=globalThis}={}) {
  let state={schemaVersion:1,startingBalanceUsd:100,cashUsd:100,openPositions:[],history:[],running:false,lastScanAt:null,lastError:null,rejections:[],closedDates:{},peakEquityUsd:100,maxDrawdownPercent:0};
  if (io.existsSync(file)) state=JSON.parse(io.readFileSync(file,'utf8'));
  state.lastExitAt ||= {};
  function validate(s) {
    if (s.schemaVersion!==1 || s.startingBalanceUsd!==100 || !Number.isFinite(s.cashUsd) || s.cashUsd < -1e-8 || !Array.isArray(s.openPositions) || s.openPositions.length>3 || !Array.isArray(s.history) || !Array.isArray(s.rejections) || !s.closedDates || new Set(s.openPositions.map(p=>p.symbol)).size!==s.openPositions.length || s.openPositions.some(p=>!valid(p.quantity)||!valid(p.costBasisUsd)||!valid(p.markPriceUsd))) throw Error('Invalid Stock Bot state; refusing to reset saved account');
  }
  validate(state);
  let timer=null,busy=false,generation=0,marketOpen=null,nextOpen=null,nextClose=null,connection='WAITING_FOR_ALPACA',barsCache={},lastBarsAt=-Infinity,sessionMode='WAITING',dailyPnlUsd=0,lastResearchAt=-Infinity,referenceDate=null,referenceCloses={};
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
  async function refreshBars(openAt) {
    if(now()-lastBarsAt<MINUTE)return;
    let page=null, all={};
    do {
      const p=new URLSearchParams({symbols:SYMBOLS.join(','),timeframe:'5Min',start:new Date(openAt).toISOString(),end:new Date(now()-1000).toISOString(),limit:'10000',feed:'iex',adjustment:'raw',sort:'asc'});
      if(page)p.set('page_token',page);
      const r=await request('https://data.alpaca.markets/v2/stocks/bars?'+p);
      for(const [sym,rows] of Object.entries(r.bars||{}))all[sym]=(all[sym]||[]).concat(rows);
      page=r.next_page_token;
    }while(page);
    barsCache=all;lastBarsAt=now();
  }
  async function collectBars(params) {
    let page=null,all={};
    do{const p=new URLSearchParams(params);if(page)p.set('page_token',page);const r=await request('https://data.alpaca.markets/v2/stocks/bars?'+p);for(const [sym,rows]of Object.entries(r.bars||{}))all[sym]=(all[sym]||[]).concat(rows);page=r.next_page_token;}while(page);
    return all;
  }
  async function researchPremarket(openAt,gen) {
    if(now()-lastResearchAt<MINUTE)return;
    lastResearchAt=now();const start=openAt-330*MINUTE,end=now()-16*MINUTE,today=dateKey(now());
    if(end<=start){const s=structuredClone(state);s.premarketAnalysis={sessionDate:today,lastUpdatedAt:new Date(now()).toISOString(),source:'Consolidated SIP historical data',minimumDelayMinutes:16,rankings:[],status:'Waiting for delayed premarket bars'};commit(s);return;}
    try{
      if(referenceDate!==today){
        const data=await collectBars({symbols:SYMBOLS.join(','),timeframe:'1Day',start:new Date(openAt-14*86400000).toISOString(),end:new Date(start-1000).toISOString(),limit:'10000',feed:'sip',adjustment:'split',sort:'asc'});
        const refs={};for(const [sym,rows]of Object.entries(data)){const last=rows.filter(b=>dateKey(Date.parse(b.t))<today&&valid(b.c)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)).at(-1);if(last)refs[sym]=last.c;}referenceCloses=refs;referenceDate=today;
      }
      const bars=await collectBars({symbols:SYMBOLS.join(','),timeframe:'5Min',start:new Date(start).toISOString(),end:new Date(end).toISOString(),limit:'10000',feed:'sip',adjustment:'raw',sort:'asc'});
      if(gen!==generation||!state.running)return;
      const rankings=rankPremarket(bars,referenceCloses,now(),start,end),benchmark=rankings.find(r=>r.symbol==='SPY');
      const s=structuredClone(state);s.premarketAnalysis={sessionDate:today,lastUpdatedAt:new Date(now()).toISOString(),source:'Consolidated SIP historical data',minimumDelayMinutes:16,rankings,status:rankings.length?'Premarket watchlist ranked; research only':'No delayed premarket bars available yet',benchmarkGapPercent:benchmark?.gapPercent??null};if(!s.openPositions.length)s.lastError=null;commit(s);
    }catch(e){if(gen!==generation)return;const s=structuredClone(state);s.premarketAnalysis={...(s.premarketAnalysis||{}),sessionDate:today,lastAttemptAt:new Date(now()).toISOString(),status:'Premarket data unavailable',error:e.message,minimumDelayMinutes:16};commit(s);}
  }
  function buy(symbol,q,signal) {
    const entriesToday=state.history.filter(r=>r.type==='BUY'&&r.symbol===symbol&&dateKey(Date.parse(r.time))===dateKey(now())).length;
    if(!state.running||state.openPositions.length>=3||state.openPositions.some(p=>p.symbol===symbol)||now()-Number(state.lastExitAt[symbol]||0)<15*MINUTE||entriesToday>=2||state.cashUsd<10*(1+FEE))return false;
    const s=structuredClone(state), entryPrice=q.ask*(1+SLIPPAGE), quantity=10/entryPrice;
    const p={id:randomUUID(),symbol,tokenAddress:symbol,entryPrice,quantity,notionalUsd:10,costBasisUsd:10*(1+FEE),entryFeeUsd:10*FEE,highestPrice:q.bid,markPriceUsd:q.bid,entryTime:new Date(now()).toISOString(),strategy:STRATEGY,entryReason:signal};
    s.cashUsd-=p.costBasisUsd;s.openPositions.push(p);
    s.history.unshift({...p,type:'BUY',positionId:p.id,amountUsd:10,amountInvested:p.costBasisUsd,time:p.entryTime,mode:'PAPER'});commit(s);return true;
  }
  function sell(id,q,reason) {
    const s=structuredClone(state),i=s.openPositions.findIndex(p=>p.id===id);if(i<0)return;
    const p=s.openPositions[i],exitPrice=q.bid*(1-SLIPPAGE),gross=p.quantity*exitPrice,fee=gross*FEE,proceeds=gross-fee,pnl=proceeds-p.costBasisUsd,time=new Date(now()).toISOString();
    s.cashUsd+=proceeds;s.openPositions.splice(i,1);s.closedDates[p.symbol]=dateKey(now());s.lastExitAt[p.symbol]=now();
    s.history.unshift({...p,type:'SELL',positionId:p.id,exitPrice,exitTime:time,time,amountInvested:p.costBasisUsd,investedUsd:p.costBasisUsd,saleValueUsd:proceeds,amountUsd:proceeds,pnl,pnlUsd:pnl,pnlPercent:pnl/p.costBasisUsd*100,returnPercent:pnl/p.costBasisUsd*100,estimatedFeesUsd:p.entryFeeUsd+fee,exitReason:reason,reason,holdTimeMs:now()-Date.parse(p.entryTime),mode:'PAPER'});commit(s);
  }
  function updatePositions(snapshots,flatten=false) {
    for(const p of structuredClone(state.openPositions)) {
      const q=quote(snapshots[p.symbol],now());if(!q)continue;
      const s=structuredClone(state),current=s.openPositions.find(x=>x.id===p.id);
      current.markPriceUsd=q.bid;current.highestPrice=Math.max(current.highestPrice,q.bid);commit(s);
      const change=(q.bid/p.entryPrice-1)*100, peak=(current.highestPrice/p.entryPrice-1)*100;
      if(flatten || dateKey(Date.parse(p.entryTime))!==dateKey(now()))sell(p.id,q,flatten?'SESSION CLOSE 10 MIN BEFORE BELL':'RECOVERY EXIT FROM PREVIOUS SESSION');
      else if(change<=-0.8)sell(p.id,q,'STOP TRIGGER -0.8%');
      else if(change>=1.5)sell(p.id,q,'TAKE PROFIT +1.5%');
      else if(peak>=0.75 && q.bid<=current.highestPrice*0.995)sell(p.id,q,'TRAIL 0.5% AFTER +0.75%');
      else if(now()-Date.parse(p.entryTime)>=90*MINUTE)sell(p.id,q,'TIME EXIT 90 MIN');
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
      marketOpen=clock.is_open;nextOpen=clock.next_open;nextClose=clock.next_close;connection='CONNECTED';
      if(!marketOpen){
        const opening=Date.parse(nextOpen),premarket=Number.isFinite(opening)&&dateKey(opening)===dateKey(now())&&now()>=opening-330*MINUTE&&now()<opening;
        sessionMode=state.openPositions.length?'EXIT_PENDING_MARKET_CLOSED':premarket?'PREMARKET_ANALYSIS':'MARKET_CLOSED';
        const s=structuredClone(state);s.lastError=state.openPositions.length?'Session exit pending: no fresh regular-session quotes; will retry next open':null;commit(s);
        if(premarket)await researchPremarket(opening,gen);return;
      }
      const closeAt=Date.parse(nextClose);if(!Number.isFinite(closeAt)||closeAt<=now())throw Error('Invalid market closing time');
      const openAt=sessionOpen(nextClose),flatten=closeAt-now()<=10*MINUTE;
      const snapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:SYMBOLS.join(','),feed:'iex'}));
      if(gen!==generation||!state.running)return;
      updatePositions(snapshots,flatten);
      const marked=structuredClone(state),equity=marked.cashUsd+marked.openPositions.reduce((s,p)=>s+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0);
      marked.peakEquityUsd=Math.max(marked.peakEquityUsd,equity);marked.maxDrawdownPercent=Math.max(marked.maxDrawdownPercent,(1-equity/marked.peakEquityUsd)*100);commit(marked);
      dailyPnlUsd=state.history.filter(r=>r.type==='SELL'&&dateKey(Date.parse(r.time))===dateKey(now())).reduce((s,r)=>s+r.pnlUsd,0)+state.openPositions.reduce((s,p)=>s+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE)-p.costBasisUsd,0);
      sessionMode=flatten?'CLOSING_SESSION':closeAt-now()<=30*MINUTE?'NO_NEW_ENTRIES':dailyPnlUsd<=-3?'DAILY_LOSS_PAUSE':'SCANNING';
      if(sessionMode!=='SCANNING'){
        const s=structuredClone(state);s.lastError=flatten&&s.openPositions.length?'Waiting for fresh quotes to complete session exits':null;commit(s);return;
      }
      if(now()-lastBarsAt<MINUTE)return;
      await refreshBars(openAt);if(gen!==generation||!state.running)return;
      const currentClock=await request('https://paper-api.alpaca.markets/v2/clock');
      if(gen!==generation||!state.running)return;
      const checkedTimestamp=Date.parse(currentClock.timestamp),checkedClose=Date.parse(currentClock.next_close);
      if(currentClock.is_open!==true||!Number.isFinite(checkedTimestamp)||Math.abs(now()-checkedTimestamp)>120000||!Number.isFinite(checkedClose)||checkedClose-now()<=30*MINUTE)return;
      const ranked=[],rejections=[];
      const freshSnapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:SYMBOLS.join(','),feed:'iex'}));
      if(gen!==generation||!state.running)return;
      if(checkedClose-now()<=30*MINUTE)return;
      for(const symbol of SYMBOLS){const a=assess(freshSnapshots[symbol],barsCache[symbol],now(),openAt);if(a.accepted){const research=state.premarketAnalysis?.sessionDate===dateKey(now())?state.premarketAnalysis.rankings?.find(r=>r.symbol===symbol&&r.longWatchCandidate):null;ranked.push({symbol,...a,score:a.score+Math.min(3,(research?.score||0)*0.1)});}else rejections.push({symbol,reason:a.reason,time:new Date(now()).toISOString()});}
      ranked.sort((a,b)=>b.score-a.score);for(const c of ranked)buy(c.symbol,c.quote,c.signal);
      const s=structuredClone(state);s.lastScanAt=new Date(now()).toISOString();s.lastError=null;s.rejections=rejections;
      const eq=s.cashUsd+s.openPositions.reduce((v,p)=>v+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0);
      s.peakEquityUsd=Math.max(s.peakEquityUsd,eq);s.maxDrawdownPercent=Math.max(s.maxDrawdownPercent,(1-eq/s.peakEquityUsd)*100);commit(s);
    }catch(e){if(gen===generation){connection='CONNECTION_ERROR';const s=structuredClone(state);s.lastError=e.message;commit(s);}}
    finally{busy=false;}
  }
  function start(){if(timer)return;const s=structuredClone(state);s.running=true;commit(s);timer=timers.setInterval(()=>void tick(),15000);void tick();}
  function stop(){generation++;if(timer)timers.clearInterval(timer);timer=null;const s=structuredClone(state);s.running=false;commit(s);}
  async function closeAll(){
    if(busy)return {success:false,results:[{success:false,error:'Stock monitor busy; retry shortly'}]};
    if(!state.openPositions.length)return {success:true,results:[]};
    if(!configured())return {success:false,results:[{success:false,error:'Alpaca connection required to close stocks at current prices'}]};
    busy=true;const results=[];
    try{
      const clock=await request('https://paper-api.alpaca.markets/v2/clock');
      if(clock.is_open!==true||!Number.isFinite(Date.parse(clock.timestamp))||Math.abs(now()-Date.parse(clock.timestamp))>120000)throw Error('Stock market closed or market clock stale');
      const snapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:state.openPositions.map(p=>p.symbol).join(','),feed:'iex'}));
      for(const p of structuredClone(state.openPositions)){const q=quote(snapshots[p.symbol],now());if(q){sell(p.id,q,'MANUAL PAPER CLOSE');results.push({success:true,symbol:p.symbol});}else results.push({success:false,symbol:p.symbol,error:'Fresh exit bid unavailable'});}
    }catch(e){results.push({success:false,error:e.message});}finally{busy=false;}
    return {success:results.every(r=>r.success),results};
  }
  function getStatus(){return {running:state.running&&configured()&&connection==='CONNECTED',enabled:state.running,mode:'PAPER',tradingStyle:'INTRADAY_OPPORTUNITY',watchlistSize:SYMBOLS.length,sessionMode,dailyPnlUsd,connection:configured()?connection:'WAITING_FOR_ALPACA',marketOpen,nextOpen,nextClose,lastScanAt:state.lastScanAt,lastError:state.lastError,premarketLastUpdatedAt:state.premarketAnalysis?.lastUpdatedAt||null,premarketDataDelayMinutes:16,statusMessage:!configured()?'Waiting for Alpaca paper API connection':!state.running?'Stopped':state.lastError||(sessionMode==='PREMARKET_ANALYSIS'?'Analyzing premarket movers; consolidated data delayed at least 16 min; no premarket orders':!marketOpen?'Market closed; next research window starts 4am ET':sessionMode==='CLOSING_SESSION'?'Closing positions before market close':sessionMode==='NO_NEW_ENTRIES'?'Last 30 minutes: exits only':sessionMode==='DAILY_LOSS_PAUSE'?'Daily $3 loss limit: exits only':'Scanning intraday breakouts and pullback recoveries'),openPositions:state.openPositions.length,maxOpenPositions:3};}
  function getDashboardData(){
    const livePositions=state.openPositions.map(p=>{const value=p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),pnl=value-p.costBasisUsd;return {position:p,live:{priceUsd:p.markPriceUsd,currentValue:value,pnl,pnlPercent:pnl/p.costBasisUsd*100,holdTimeMs:now()-Date.parse(p.entryTime)},pnl};});
    const equity=state.cashUsd+livePositions.reduce((s,p)=>s+p.live.currentValue,0),totalPnl=equity-100;
    return {label:'Stock Bot',mode:'PAPER',paperOnly:true,simulation:'Local paper ledger; no broker orders',exchange:'Alpaca IEX market data',strategy:STRATEGY,premarketAnalysis:state.premarketAnalysis||null,startingBalance:100,startingBalanceUsd:100,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:totalPnl,livePositions,completedTrades:state.history.filter(r=>r.type==='SELL'),history:state.history,rejections:state.rejections,lastScanAt:state.lastScanAt,lastError:state.lastError,maxDrawdownPercent:state.maxDrawdownPercent,estimatedFeePercentPerSide:FEE*100,estimatedSlippagePercentPerSide:SLIPPAGE*100,nextTradeSizeUsd:10,maxOpenPositions:3,...getStatus(),openPositions:livePositions};
  }
  return {start,stop,tick,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state)};
}
let singleton;
const instance=()=>singleton||(singleton=createStockBot());
module.exports={createStockBot,assess,quote,sessionOpen,rankPremarket,SYMBOLS,STRATEGY,start:()=>instance().start(),stop:()=>instance().stop(),closeAll:()=>instance().closeAll(),getStatus:()=>instance().getStatus(),getDashboardData:()=>instance().getDashboardData()};
