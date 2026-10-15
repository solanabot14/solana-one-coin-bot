"use strict";
// Local paper ledger only. No broker order endpoint exists in this module.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const SYMBOLS = ['SPY','QQQ','IWM','DIA','AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA','AMD','AVGO','MU','INTC','PLTR','COIN','HOOD','UBER','NFLX','SHOP','SOFI','PYPL','CRM','ORCL','JPM','BAC','XOM','WMT','DIS','F','GM','RIVN','NIO','LCID','AAL','DAL','UAL','CCL','NCLH','RCL','SNAP','PINS','RBLX','DKNG','AFRM','XYZ','T','VZ','PFE','C','WFC','CVX','OXY','SLB','CAT','BA','GE','XLF','XLK'];
const STRATEGY = 'Active intraday opportunity: premarket research from 4am ET (delayed data); dynamic movers/most-active/news discovery up to 180 symbols including baseline stocks/ETFs; daily ATRP 2-6%, same-time historical IEX relative volume >=2x, average SIP daily traded value >=$20m, spread <=0.15%; confirmed breakouts and pullback recoveries; 3 slots; sell 50% at +1.5%, trail remainder 0.75% with cost-adjusted break-even protection; -1.2% initial stop; 60 min max hold; close 10 min before bell. Start $10, grow size 10% after a net winning completed trade, cap $20, reset $10 after loss. Daily loss limit 2.5% of opening equity: liquidate and halt until next trading day; at most one reentry per stock, none after a stop. No entry in first 15 minutes. Local paper only; Alpaca/Benzinga recent news every 5 min, deduplicated and timestamped; news is context, never an automatic buy. BLS/BEA/Fed calendars; pause new entries 5 min before/10 min after high-impact releases and 13:45-15:00 ET on FOMC decision days; BEA/Fed calendars must be fresh; expired BLS coverage limits total exposure to one $10 position and keeps known event pauses. Alpaca verifies active listed fractionable assets; warrants/units/preferred/leveraged products excluded. No sector entry restriction; up to 3 slots subject to existing account and macro risk limits; SPY relative strength; News-feed headlines do not establish price direction. Planned risk <=0.25% equity per trade before gaps. Sector/news research runs in background; exits remain active.';
const SCAN_FILTERS = Object.freeze({minAtrPercent:2,maxAtrPercent:6,minTimeRelativeVolume:2,maxSpreadPercent:0.15,minAverageDailyDollarVolume:20000000,minVolumeSessions:5,volumeLookbackSessions:10});
const SLIPPAGE = 0.0005, FEE = 0.0001;
const RISK_RULES=Object.freeze({dailyLossPercent:2.5,maxEntriesPerSymbolPerDay:2,noReentryAfterStop:true,entryDelayMinutes:15});
const MINUTE=60000, BAR_MS=5*MINUTE;
const dateFormatter=new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric',month:'2-digit',day:'2-digit'});
const minuteFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hourCycle:'h23'});
const dateKey = t => dateFormatter.format(new Date(t));
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
function minuteOfDay(t) {
  const parts=minuteFormatter.formatToParts(new Date(t));
  return Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
}
function buildBaselines(dailyBars, intradayBars, today, symbols=SYMBOLS) {
  const out={};
  for(const symbol of symbols){
    const days=(dailyBars[symbol]||[]).filter(b=>dateKey(Date.parse(b.t))<today&&[b.h,b.l,b.c,b.v].every(valid)&&b.h>=b.l).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
    // Wilder ATR(14), seeded with the first fourteen true ranges. Completed days only.
    const ranges=days.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-days[i].c),Math.abs(b.l-days[i].c)));
    let atr=null;
    if(ranges.length>=14){atr=ranges.slice(0,14).reduce((s,v)=>s+v,0)/14;for(const tr of ranges.slice(14))atr=(atr*13+tr)/14;}
    const groups={};
    for(const b of intradayBars[symbol]||[]){
      const t=Date.parse(b.t);if(!Number.isFinite(t))continue;
      const key=dateKey(t),minute=minuteOfDay(t);
      if(key>=today||minute<570||minute>=960||!valid(b.v))continue;
      (groups[key]||=new Map()).set(minute,b.v);
    }
    out[symbol]={atrUsd:atr,atrReferenceClose:days.at(-1)?.c??null,averageDailyDollarVolume:days.length>=14?days.slice(-14).reduce((s,b)=>s+b.c*b.v,0)/14:null,volumeSessions:Object.keys(groups).sort().slice(-SCAN_FILTERS.volumeLookbackSessions).map(key=>({date:key,bars:groups[key]}))};
  }
  return out;
}
function sameTimeVolume(baseline, session) {
  const slot=minuteOfDay(Date.parse(session.at(-1).t));
  const samples=(baseline?.volumeSessions||[]).filter(s=>s.bars.has(slot)).map(s=>[...s.bars].reduce((sum,[minute,v])=>sum+(minute<=slot?v:0),0)).filter(valid);
  const average=samples.length?samples.reduce((s,v)=>s+v,0)/samples.length:null;
  return {volumeReferenceSessions:samples.length,timeRelativeVolume:average?session.reduce((s,b)=>s+b.v,0)/average:null};
}
function assess(snapshot, bars, now, openAt=0, baseline=null) {
  if(openAt&&now<openAt+15*MINUTE)return {accepted:false,reason:'First 15 minutes: no entries'};
  const q = quote(snapshot, now);
  if (!q) return {accepted:false, reason:'Fresh bid/ask unavailable'};
  if (q.spreadPercent > SCAN_FILTERS.maxSpreadPercent) return {accepted:false,reason:'Spread exceeds 0.15%',metrics:{spreadPercent:q.spreadPercent}};
  const session=(bars||[]).filter(b=>Date.parse(b.t)>=openAt && Date.parse(b.t)+BAR_MS<=now && dateKey(Date.parse(b.t))===dateKey(now)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  if(session.length<3)return {accepted:false,reason:'Waiting for three completed 5-minute session bars'};
  const recent=session.slice(-6),last=recent.at(-1),prev=recent.at(-2);
  if(session.some(b=>![b.o,b.h,b.l,b.c,b.v].every(valid)))return {accepted:false,reason:'Invalid intraday bars'};
  // Completed candles stay current until the next close, plus two minutes
  // for publication and the one-minute cache refresh.
  if(now-Date.parse(last.t)-BAR_MS>BAR_MS+2*MINUTE||recent.some((b,i)=>i&&Date.parse(b.t)-Date.parse(recent[i-1].t)!==BAR_MS))return {accepted:false,reason:'Stale or missing 5-minute bars'};
  const volume=session.reduce((s,b)=>s+b.v,0),vwap=session.reduce((s,b)=>s+(valid(b.vw)?b.vw:(b.h+b.l+b.c)/3)*b.v,0)/volume;
  const move=(q.mid/session[0].o-1)*100,extension=(q.mid/vwap-1)*100;
  const average=recent.slice(0,-1).reduce((s,b)=>s+b.v,0)/(recent.length-1),relativeVolume=last.v/average;
  const atrPercent=valid(baseline?.atrUsd)&&valid(baseline?.atrReferenceClose)?baseline.atrUsd/baseline.atrReferenceClose*100:null;
  const historicalVolume=sameTimeVolume(baseline,session);
  const peak=Math.max(...recent.slice(0,-2).map(b=>b.h)),dip=(peak/prev.l-1)*100;
  const breakout=last.c>Math.max(...recent.slice(0,-1).map(b=>b.h));
  const reclaim=prev.c<recent.at(-3).c && dip>=0.2 && dip<=2 && last.c>prev.h;
  const confirmationLevel=breakout?Math.max(...recent.slice(0,-1).map(b=>b.h)):prev.h;
  const checks=[
    [atrPercent!==null,'Daily ATR history unavailable; waiting for 15 completed sessions'],
    [atrPercent>=SCAN_FILTERS.minAtrPercent&&atrPercent<=SCAN_FILTERS.maxAtrPercent,'Daily ATRP outside 2% to 6%'],
    [baseline?.averageDailyDollarVolume>=SCAN_FILTERS.minAverageDailyDollarVolume,'Average daily SIP traded value below $20m or unavailable'],
    [historicalVolume.volumeReferenceSessions>=SCAN_FILTERS.minVolumeSessions,'Insufficient same-time IEX volume history'],
    [historicalVolume.timeRelativeVolume>=SCAN_FILTERS.minTimeRelativeVolume,'Same-time IEX relative volume below 2x'],
    [move>=0.3 && move<=8,'Session move outside +0.3% to +8%'],
    [extension>=0 && extension<=3,'Price outside VWAP trend range'],
    [relativeVolume>=1.2,'Signal volume below 1.2x recent average'],
    [last.v*last.c>=25000,'Signal candle below $25k IEX traded value'],
    [last.c>last.o && (last.c/last.o-1)*100<=2,'Waiting for bullish candle without a spike'],
    [q.mid>=last.c*0.999,'Current price has fallen below signal close'],
    [breakout||reclaim,'Waiting for confirmed breakout or pullback recovery']
  ];
  const accepted=checks.every(([ok])=>ok);
  const signal=breakout?'BREAKOUT':'PULLBACK RECOVERY';
  return {accepted,reason:accepted?signal+' above VWAP with 2x historical volume and ATRP 2-6%':checks.find(([ok])=>!ok)[1],signal,quote:q,score:historicalVolume.timeRelativeVolume*2+relativeVolume+move,metrics:{confirmationLevel,confirmationClose:last.c,confirmationTime:new Date(Date.parse(last.t)+BAR_MS).toISOString(),confirmationVolume:last.v,confirmationAverageVolume:average,vwap,movePercent:move,relativeVolume,...historicalVolume,atrPercent,averageDailyDollarVolume:baseline?.averageDailyDollarVolume??null,extensionPercent:extension,spreadPercent:q.spreadPercent,signalDollarVolume:last.v*last.c}};
}
function exitCategory(reason='') {
  if(/DAILY.*LIMIT/i.test(reason))return 'DAILY_LIMIT';
  if(/STOP TRIGGER/i.test(reason))return 'STOP';
  if(/PARTIAL TP/i.test(reason))return 'TAKE_PROFIT';
  if(/TRAIL/i.test(reason))return 'TRAILING';
  if(/TIME EXIT/i.test(reason))return 'TIME';
  if(/SESSION CLOSE|PREVIOUS SESSION/i.test(reason))return 'END_OF_DAY';
  return 'MANUAL';
}
function weekKey(time) {
  const day=dateKey(time),d=new Date(day+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);
}
function tradeReports(history,completed,at) {
  const daily=new Map(),weekly=new Map();
  function bucket(map,key){if(!map.has(key))map.set(key,{periodStart:key,trades:0,wins:0,losses:0,breakeven:0,netPnlUsd:0,completedTradeNetPnlUsd:0,averageWinUsd:0,averageLossUsd:0,pnlByExitReason:{},pnlWithoutCostsUsd:0,costsUsd:0,costCoveredFills:0,legacyFillsWithoutCostBreakdown:0});return map.get(key);}
  for(const r of history){
    if(r.type!=='SELL'||!Number.isFinite(r.pnlUsd))continue;
    const time=Date.parse(r.time||r.exitTime);if(!Number.isFinite(time))continue;
    for(const b of [bucket(daily,dateKey(time)),bucket(weekly,weekKey(time))]){
      b.netPnlUsd+=r.pnlUsd;
      const category=r.exitCategory||exitCategory(r.exitReason||r.reason);
      const g=b.pnlByExitReason[category]||={fills:0,netPnlUsd:0,pnlWithoutCostsUsd:0,costCoveredFills:0};g.fills++;g.netPnlUsd+=r.pnlUsd;
      if(Number.isFinite(r.pnlWithoutCostsUsd)){b.pnlWithoutCostsUsd+=r.pnlWithoutCostsUsd;b.costsUsd+=r.pnlWithoutCostsUsd-r.pnlUsd;b.costCoveredFills++;g.pnlWithoutCostsUsd+=r.pnlWithoutCostsUsd;g.costCoveredFills++;}else b.legacyFillsWithoutCostBreakdown++;
    }
  }
  for(const r of completed){
    const t=Date.parse(r.exitTime||r.time);if(!Number.isFinite(t))continue;
    for(const b of [bucket(daily,dateKey(t)),bucket(weekly,weekKey(t))]){
      b.trades++;b.completedTradeNetPnlUsd+=r.pnlUsd;
      if(r.pnlUsd>0){b.wins++;b.averageWinUsd+=r.pnlUsd;}else if(r.pnlUsd<0){b.losses++;b.averageLossUsd+=r.pnlUsd;}else b.breakeven++;
    }
  }
  bucket(daily,dateKey(at));bucket(weekly,weekKey(at));
  function finish(map){return [...map.values()].map(b=>({...b,winRatePercent:b.trades?b.wins/b.trades*100:0,averageWinUsd:b.wins?b.averageWinUsd/b.wins:0,averageLossUsd:b.losses?b.averageLossUsd/b.losses:0,pnlWithoutCostsUsd:b.legacyFillsWithoutCostBreakdown?null:b.pnlWithoutCostsUsd,costsUsd:b.legacyFillsWithoutCostBreakdown?null:b.costsUsd,pnlByExitReason:Object.fromEntries(Object.entries(b.pnlByExitReason).map(([key,g])=>[key,{...g,pnlWithoutCostsUsd:g.costCoveredFills===g.fills?g.pnlWithoutCostsUsd:null}]))})).sort((a,b)=>b.periodStart.localeCompare(a.periodStart));}
  const days=finish(daily),weeks=finish(weekly);
  return {timezone:'America/New_York',weekStartsOn:'Monday',tradeCounting:'One completed position; partial exits are fills, not extra trades. Realized P&L is booked on each fill date; completed-trade statistics are booked on final exit date.',costComparison:'Same executed quantity at entry/exit quote midpoints, excluding spread, slippage and modeled commissions. Legacy records with missing midpoints show unavailable, not invented values.',daily:days,weekly:weeks,today:days.find(d=>d.periodStart===dateKey(at)),thisWeek:weeks.find(w=>w.periodStart===weekKey(at))};
}
function rankPremarket(barsBySymbol,reference,now,start,end,symbols=SYMBOLS) {
  const rows=[];
  for(const symbol of symbols){
    const bars=(barsBySymbol[symbol]||[]).filter(b=>Date.parse(b.t)>=start&&Date.parse(b.t)+BAR_MS<=end&&[b.o,b.h,b.l,b.c,b.v].every(valid)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
    if(!bars.length)continue;
    const last=bars.at(-1),volume=bars.reduce((s,b)=>s+b.v,0),dollarVolume=bars.reduce((s,b)=>s+b.v*b.c,0),vwap=bars.reduce((s,b)=>s+(valid(b.vw)?b.vw:(b.h+b.l+b.c)/3)*b.v,0)/volume;
    const prev=reference[symbol],gap=valid(prev)?(last.c/prev-1)*100:null,move=(last.c/bars[0].o-1)*100,high=Math.max(...bars.map(b=>b.h)),low=Math.min(...bars.map(b=>b.l));
    const asOf=Date.parse(last.t)+BAR_MS,ageMinutes=(now-asOf)/MINUTE;
    rows.push({symbol,lastPrice:last.c,previousClose:prev||null,gapPercent:gap,premarketMovePercent:move,volume,dollarVolume,vwap,high,low,aboveVwap:last.c>=vwap,dataAsOf:new Date(asOf).toISOString(),dataAgeMinutes:Math.round(ageMinutes),stale:ageMinutes>30,longWatchCandidate:gap!==null&&gap>0&&last.c>=vwap&&dollarVolume>=100000&&ageMinutes<=30,score:Math.abs(gap??move)*2+Math.log10(Math.max(dollarVolume,1))});
  }
  return rows.sort((a,b)=>b.score-a.score);
}
// Official public snapshots retrieved on the date below; bounded fallback, never a live-source claim.
const OFFICIAL_SNAPSHOT={"downloadedAt":"2026-10-15T03:46:44.000Z","blsCalendarGzip":"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"};
const readOfficialSnapshot=key=>require('node:zlib').gunzipSync(Buffer.from(OFFICIAL_SNAPSHOT[key],'base64')).toString('utf8');
const RESEARCH_SOURCES=Object.freeze({BLS:'https://www.bls.gov/schedule/news_release/bls.ics',BEA:'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics',FED:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'});
const SECTOR_BENCHMARKS=Object.freeze({TECHNOLOGY:'XLK',HEALTHCARE:'XLV',FINANCIALS:'XLF',ENERGY:'XLE',MATERIALS:'XLB',INDUSTRIALS:'XLI',CONSUMER_DISCRETIONARY:'XLY',CONSUMER_STAPLES:'XLP',UTILITIES:'XLU',REAL_ESTATE:'XLRE',COMMUNICATION:'XLC',BROAD_MARKET:'SPY'});
const BENCHMARK_SYMBOLS=[...new Set(Object.values(SECTOR_BENCHMARKS))];
function easternTimestamp(day,hour,minute=0){
  let value=Date.parse(day+'T'+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+':00Z');
  const target=value;
  for(let i=0;i<3;i++){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
    const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    const rendered=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    value+=target-rendered;
  }
  return value;
}
function parseEconomicCalendar(text,source){
  if(!text.includes('BEGIN:VCALENDAR'))throw Error(source+' invalid iCalendar response');
  const unfolded=text.replace(/\r?\n[ \t]/g,''),events=[];
  for(const match of unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)){
    const block=match[1],start=/^DTSTART([^:\r\n]*):([^\r\n]+)/m.exec(block),summary=/^SUMMARY:([^\r\n]+)/m.exec(block);
    if(!start||!summary)continue;
    const dt=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(start[2].trim());
    if(!dt||(!dt[7]&&!/TZID=(US-Eastern|America\/New_York)/.test(start[1])))continue;
    const day=`${dt[1]}-${dt[2]}-${dt[3]}`,t=dt[7]?Date.parse(`${day}T${dt[4]}:${dt[5]}:${dt[6]}Z`):easternTimestamp(day,Number(dt[4]),Number(dt[5]));
    const title=summary[1].replace(/\\n/g,' ').replace(/\\([,;\\])/g,'$1');
    const highImpact=/^(Consumer Price Index|Producer Price Index|Employment Situation|Job Openings and Labor Turnover|Employment Cost Index|Productivity and Costs)|Gross Domestic Product|\bGDP\b|Personal Income and Outlays/i.test(title)&&!/by (State|County)|Metropolitan/i.test(title);
    if(Number.isFinite(t))events.push({title,time:new Date(t).toISOString(),source,url:RESEARCH_SOURCES[source],highImpact});
  }
  if(!events.length)throw Error(source+' calendar contained no supported events');
  return events;
}
function parseFedCalendar(html){
  const events=[],months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const headers=[...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  for(let i=0;i<headers.length;i++){
    const year=Number(headers[i][1]),section=html.slice(headers[i].index,headers[i+1]?.index??html.length);
    const rx=/class="[^"]*fomc-meeting__month[^"]*"[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?class="[^"]*fomc-meeting__date[^"]*"[^>]*>([^<]+)/g;
    for(const row of section.matchAll(rx)){
      const month=months.indexOf(row[1].trim());if(month<0)continue;
      const days=row[2].replace(/&ndash;|&#8211;|–/g,'-').match(/\d+/g);if(!days?.length)continue;
      const day=`${year}-${String(month+1).padStart(2,'0')}-${String(Number(days.at(-1))).padStart(2,'0')}`;
      events.push({title:'FOMC decision-day precaution window',time:new Date(easternTimestamp(day,14)).toISOString(),source:'FED',url:RESEARCH_SOURCES.FED,highImpact:true,windowBeforeMinutes:15,windowAfterMinutes:60,timeBasis:'Bot precaution centered on customary 14:00 ET decision time; calendar confirms meeting date, not exact release time'});
    }
  }
  if(!events.length)throw Error('Federal Reserve meeting dates could not be parsed');
  return events;
}
function macroEntryGate(calendar,at){
  const sourceFresh=name=>{
    const s=calendar?.sources?.[name],t=Date.parse(s?.lastSuccessAt);
    return Number.isFinite(t)&&t<=at&&at-t<=(s.status==='CACHED_OFFICIAL_SNAPSHOT'?7*24:24)*60*MINUTE&&s.coverageThrough>=dateKey(at);
  };
  // BEA/Fed must be fresh. An unavailable BLS update reduces exposure rather
  // than silently disabling the bot indefinitely; known release windows still apply.
  if(!['BEA','FED'].every(sourceFresh))return {allowed:false,reason:'BEA/Fed economic calendars incomplete or stale; exits remain active'};
  const event=(calendar.events||[]).find(e=>e.highImpact&&at>=Date.parse(e.time)-(e.windowBeforeMinutes??5)*MINUTE&&at<=Date.parse(e.time)+(e.windowAfterMinutes??10)*MINUTE);
  if(event)return {allowed:false,reason:'Economic-event entry pause: '+event.title,event};
  const degraded=!sourceFresh('BLS');
  return {allowed:true,degraded,warnings:degraded?['BLS updates unavailable or expired: using known events only; maximum one total position and $10 notional until coverage recovers']:[]};
}
function assetEligibility(asset,asOf,at){
  const age=at-Date.parse(asOf);
  if(!Number.isFinite(age)||age<0||age>24*60*MINUTE)return {allowed:false,reason:'Fresh Alpaca asset identity unavailable'};
  if(!asset||asset.class!=='us_equity'||asset.status!=='active'||asset.tradable!==true||asset.fractionable!==true||!['NYSE','NASDAQ','AMEX','ARCA','NYSEARCA','BATS'].includes(asset.exchange))return {allowed:false,reason:'Asset is not active, exchange-listed, tradable and fractionable'};
  if(/\bwarrants?\b|\bright[s]?\b|\bunits?\b|\bpreferred\b|\bdepositary shares?\b|\b[23]x\b|\bleveraged\b|\binverse\b/i.test(asset.name||''))return {allowed:false,reason:'Warrant, unit, preferred or leveraged/inverse product excluded'};
  return {allowed:true};
}

function sessionStrength(bars,at,openAt){
  const rows=(bars||[]).filter(b=>Date.parse(b.t)>=openAt&&Date.parse(b.t)+BAR_MS<=at&&valid(b.o)&&valid(b.c)&&valid(b.v)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  if(!rows.length||at-Date.parse(rows.at(-1).t)-BAR_MS>BAR_MS+2*MINUTE)return null;
  const volume=rows.reduce((s,b)=>s+b.v,0),vwap=rows.reduce((s,b)=>s+(valid(b.vw)?b.vw:(b.h+b.l+b.c)/3)*b.v,0)/volume;
  return {returnPercent:(rows.at(-1).c/rows[0].o-1)*100,aboveVwap:rows.at(-1).c>=vwap};
}

function createStockBot({file=path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname,'stock-paper-state.json'), env=process.env, io=fs, fetchImpl=globalThis.fetch, now=()=>Date.now(), timers=globalThis}={}) {
  let symbols=[...new Set([...SYMBOLS,...BENCHMARK_SYMBOLS])],lastDiscoveryAt=-Infinity,discoveryDate=null,assetMaster={},assetMasterAsOf=null;
  let state={schemaVersion:1,startingBalanceUsd:100,cashUsd:100,openPositions:[],history:[],running:false,lastScanAt:null,lastError:null,rejections:[],closedDates:{},peakEquityUsd:100,maxDrawdownPercent:0};
  if (io.existsSync(file)) state=JSON.parse(io.readFileSync(file,'utf8'));
  delete state.secResearch; // Retired integration; preserve all trading history.
  state.lastExitAt ||= {};
  state.lastExitWon ||= {};
  state.nextEntryUsd ??= 10;
  for(const p of state.openPositions){
    p.originalQuantity ??= p.quantity;p.originalCostBasisUsd ??= p.costBasisUsd;p.realizedPnlUsd ??= 0;p.partialTaken ??= false;
    p.lowestPrice ??= p.markPriceUsd;p.maxDrawdownPercent ??= 0;p.maxRunUpPercent ??= Math.max(0,(p.highestPrice/p.entryPrice-1)*100);p.maxAdverseExcursionPercent ??= Math.min(0,(p.markPriceUsd/p.entryPrice-1)*100);
    p.excursionCoverage ??= 'Observed quotes from upgrade onward; earlier intratrade lows unavailable';
    if(p.partialTaken)p.runnerHighestPrice ??= p.highestPrice;
  }
  function validate(s) {
    if (s.schemaVersion!==1 || s.startingBalanceUsd!==100 || !Number.isFinite(s.cashUsd) || s.cashUsd < -1e-8 || !valid(s.nextEntryUsd) || s.nextEntryUsd<10 || s.nextEntryUsd>20 || !Array.isArray(s.openPositions) || s.openPositions.length>3 || !Array.isArray(s.history) || !Array.isArray(s.rejections) || !s.closedDates || new Set(s.openPositions.map(p=>p.symbol)).size!==s.openPositions.length || s.openPositions.some(p=>!valid(p.quantity)||!valid(p.costBasisUsd)||!valid(p.markPriceUsd))) throw Error('Invalid Stock Bot state; refusing to reset saved account');
  }
  validate(state);
  let timer=null,busy=false,generation=0,marketOpen=null,nextOpen=null,nextClose=null,connection='WAITING_FOR_ALPACA',barsCache={},lastBarsAt=-Infinity,sessionMode='WAITING',dailyPnlUsd=0,lastResearchAt=-Infinity,referenceDate=null,referenceCloses={};
  let baselineDate=null,baselines={},lastBaselineAttempt=-Infinity;
  const configured = () => !!(env.ALPACA_PAPER_API_KEY && env.ALPACA_PAPER_SECRET_KEY);
  function commit(s) {
    validate(s); io.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';
    try {io.writeFileSync(tmp,JSON.stringify(s,null,2),{flag:'wx',flush:true});io.renameSync(tmp,file);} finally {if(io.existsSync(tmp))io.unlinkSync(tmp);}
    state=s;
  }
  function equityOf(s=state){return s.cashUsd+s.openPositions.reduce((v,p)=>v+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0);}
  function ensureRiskSession(isTradingDay=false) {
    const day=dateKey(now());
    if(state.riskSession?.date===day||(!isTradingDay&&state.riskSession))return;
    const equity=equityOf();
    // Upgrade/restart mid-session: reconstruct today's opening capital without
    // resetting losses already incurred before this risk policy was installed.
    const realized=state.history.filter(r=>r.type==='SELL'&&dateKey(Date.parse(r.time))===day).reduce((s,r)=>s+(r.pnlUsd||0),0);
    const unrealized=state.openPositions.filter(p=>dateKey(Date.parse(p.entryTime))===day).reduce((v,p)=>v+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE)-p.costBasisUsd,0);
    const prior=state.riskSession;
    const carried=state.openPositions.some(p=>dateKey(Date.parse(p.entryTime))!==day);
    const openingEquity=carried?equity:equity-realized-unrealized;
    const s=structuredClone(state);
    s.riskSession={date:day,capitalUsd:Math.max(0,openingEquity),lossLimitUsd:Math.max(0,openingEquity)*RISK_RULES.dailyLossPercent/100,halted:false,triggeredAt:null,equityUsd:equity,pnlUsd:equity-openingEquity,capitalBasis:carried?'First observed equity with pending prior-session position':'Start-of-day equity reconstructed from ledger'};
    if(prior){s.riskSessions||={};s.riskSessions[prior.date]=prior;}
    commit(s);
  }
  function markPositions(snapshots) {
    const s=structuredClone(state);
    for(const p of s.openPositions){
      const q=quote(snapshots[p.symbol],now());if(!q)continue;
      p.markPriceUsd=q.bid;p.lastMarkAt=q.time;p.highestPrice=Math.max(p.highestPrice,q.bid);p.lowestPrice=Math.min(p.lowestPrice??q.bid,q.bid);
      p.maxRunUpPercent=Math.max(p.maxRunUpPercent||0,(q.bid/p.entryPrice-1)*100);
      p.maxAdverseExcursionPercent=Math.min(p.maxAdverseExcursionPercent||0,(q.bid/p.entryPrice-1)*100);
      p.maxDrawdownPercent=Math.max(p.maxDrawdownPercent||0,(1-q.bid/p.highestPrice)*100);
      if(p.partialTaken)p.runnerHighestPrice=Math.max(p.runnerHighestPrice??q.bid,q.bid);
    }
    const equity=equityOf(s);s.peakEquityUsd=Math.max(s.peakEquityUsd,equity);s.maxDrawdownPercent=Math.max(s.maxDrawdownPercent,(1-equity/s.peakEquityUsd)*100);commit(s);
  }
  function applyDailyRisk(snapshots) {
    ensureRiskSession(true);
    const s=structuredClone(state),r=s.riskSession;
    r.equityUsd=equityOf(s);r.pnlUsd=r.equityUsd-r.capitalUsd;
    if(r.pnlUsd<=-r.lossLimitUsd&&!r.halted){r.halted=true;r.triggeredAt=new Date(now()).toISOString();}
    if(r.halted)for(const p of s.openPositions)p.pendingExitReason='DAILY LOSS LIMIT 2.5%';
    commit(s);
    if(r.halted)for(const p of structuredClone(state.openPositions)){
      const q=quote(snapshots[p.symbol],now());if(q)sell(p.id,q,'DAILY LOSS LIMIT 2.5%');
    }
    if(r.halted){const settled=structuredClone(state);settled.riskSession.equityUsd=equityOf(settled);settled.riskSession.pnlUsd=settled.riskSession.equityUsd-settled.riskSession.capitalUsd;commit(settled);}
    return r.halted;
  }
  async function request(url) {
    const u = new URL(url);
    if (!['data.alpaca.markets','paper-api.alpaca.markets'].includes(u.hostname)) throw Error('Unexpected market data host');
    const r=await fetchImpl(url,{method:'GET',signal:AbortSignal.timeout(10000),headers:{'APCA-API-KEY-ID':env.ALPACA_PAPER_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_PAPER_SECRET_KEY}});
    if (!r.ok) throw Error('Alpaca connection HTTP '+r.status);
    return r.json();
  }
  let enrichmentBusy=false,lastEnrichmentAt=-Infinity,lastCalendarAttempt=-Infinity;
  async function publicResearch(url,json=false){
    const u=new URL(url);
    if(u.protocol!=='https:'||!['www.bls.gov','www.bea.gov','www.federalreserve.gov'].includes(u.hostname))throw Error('Unexpected public research host');
    const response=await fetchImpl(url,{method:'GET',signal:AbortSignal.timeout(10000),headers:{'User-Agent':'StockPaperResearch/1.0 (+https://github.com/solanabot14/solana-one-coin-bot)',Accept:json?'application/json':'text/calendar,text/html;q=0.9'}});
    if(!response.ok)throw Error('Public research HTTP '+response.status+' ('+u.hostname+')');
    return json?response.json():response.text();
  }
  async function enrichResearch(gen){
    if(enrichmentBusy||now()-lastEnrichmentAt<30000)return;
    enrichmentBusy=true;lastEnrichmentAt=now();
    try{
      if(now()-lastCalendarAttempt>=60*MINUTE){
        lastCalendarAttempt=now();
        const names=['BLS','BEA','FED'],outcomes=await Promise.allSettled(names.map(async name=>{
          let text,fallbackError=null;try{text=await publicResearch(RESEARCH_SOURCES[name]);}catch(error){if(name!=='BLS'||now()<Date.parse(OFFICIAL_SNAPSHOT.downloadedAt)||now()-Date.parse(OFFICIAL_SNAPSHOT.downloadedAt)>7*24*60*MINUTE)throw error;text=readOfficialSnapshot('blsCalendarGzip');fallbackError=error.message;}
          const events=name==='FED'?parseFedCalendar(text):parseEconomicCalendar(text,name);
          if(!events.some(e=>dateKey(Date.parse(e.time))>=dateKey(now())))throw Error(name+' has no current/future calendar coverage');
          return {events,fallbackError};
        }));
        if(gen!==generation||!state.running)return;
        const copy=structuredClone(state),calendar=copy.economicCalendar||{events:[],sources:{}};
        outcomes.forEach((r,i)=>{
          const name=names[i];
          if(r.status==='fulfilled'){
            const rows=r.value.events;calendar.events=calendar.events.filter(e=>e.source!==name).concat(rows.filter(e=>Date.parse(e.time)>=now()-24*60*MINUTE));
            calendar.sources[name]={status:r.value.fallbackError?'CACHED_OFFICIAL_SNAPSHOT':'AVAILABLE',fetchError:r.value.fallbackError,lastSuccessAt:r.value.fallbackError?OFFICIAL_SNAPSHOT.downloadedAt:new Date(now()).toISOString(),snapshotExpiresAt:r.value.fallbackError?new Date(Date.parse(OFFICIAL_SNAPSHOT.downloadedAt)+7*24*60*MINUTE).toISOString():null,coverageThrough:rows.reduce((last,e)=>dateKey(Date.parse(e.time))>last?dateKey(Date.parse(e.time)):last,''),url:RESEARCH_SOURCES[name]};
          }else calendar.sources[name]={...(calendar.sources[name]||{}),status:'UNAVAILABLE',lastAttemptAt:new Date(now()).toISOString(),error:r.reason.message,url:RESEARCH_SOURCES[name]};
        });
        calendar.events.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));calendar.checkedAt=new Date(now()).toISOString();calendar.timezone='America/New_York';copy.economicCalendar=calendar;commit(copy);
        console.info('Stock economic calendars: '+JSON.stringify({sources:calendar.sources,eventCount:calendar.events.length,gate:macroEntryGate(calendar,now())}));
      }
    }catch(error){
      if(gen===generation&&state.running){const copy=structuredClone(state);copy.economicCalendar||={events:[],sources:{}};copy.economicCalendar.lastError=error.message;console.warn('Stock calendar research unavailable: '+error.message);commit(copy);}
    }finally{enrichmentBusy=false;}
  }
  function researchGate(symbol,at=now()){
    const macro=macroEntryGate(state.economicCalendar,at);if(!macro.allowed)return macro;
    const asset=state.assetResearch?.assets?.[symbol],identity=assetEligibility(asset,state.assetResearch?.asOf,at);
    if(!identity.allowed)return identity;
    if(macro.degraded&&state.openPositions.length>=1)return {allowed:false,reason:'Reduced macro coverage: maximum one total position'};
    const sector=Object.keys(SECTOR_BENCHMARKS).find(key=>SECTOR_BENCHMARKS[key]===symbol)||'UNKNOWN';
    return {allowed:true,profile:{symbol,sector,sectorBasis:'Benchmark ETF mapping only; no sector entry restriction'},asset,macro};
  }

  async function discover(gen) {
    if(now()-lastDiscoveryAt<5*MINUTE)return;
    lastDiscoveryAt=now();
    const errors={},results=await Promise.allSettled([
      request('https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50'),
      request('https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?top=50&by=volume'),
      request('https://data.alpaca.markets/v1beta1/news?'+new URLSearchParams({start:new Date(now()-24*60*MINUTE).toISOString(),end:new Date(now()).toISOString(),limit:'50',sort:'desc',include_content:'false'})),
      assetMasterAsOf&&now()-Date.parse(assetMasterAsOf)<6*60*MINUTE?Promise.resolve(null):request('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity')
    ]);
    if(gen!==generation||!state.running)return;
    const names=['movers','mostActive','news','assets'];results.forEach((r,i)=>{if(r.status==='rejected')errors[names[i]]=r.reason.message;});
    if(results[3].status==='fulfilled'&&results[3].value!==null){
      if(Array.isArray(results[3].value)&&results[3].value.length){assetMaster=Object.fromEntries(results[3].value.filter(a=>typeof a?.symbol==='string').map(a=>[a.symbol,{symbol:a.symbol,name:a.name,class:a.class,status:a.status,exchange:a.exchange,tradable:a.tradable,fractionable:a.fractionable}]));assetMasterAsOf=new Date(now()).toISOString();}
      else errors.assets='Malformed or empty Alpaca asset master';
    }
    const movers=results[0].status==='fulfilled'?results[0].value:{},active=results[1].status==='fulfilled'?results[1].value:{};
    const seen=new Set(),news=(results[2].status==='fulfilled'?results[2].value.news||[]:[]).filter(n=>{
      const age=now()-Date.parse(n.created_at),key=String(n.headline||'').toLowerCase().trim();
      if(!key||seen.has(key)||!Number.isFinite(age)||age<0||age>24*60*MINUTE)return false;seen.add(key);return true;
    }).map(n=>({id:n.id,headline:n.headline,url:n.url,source:n.source,publishedAt:n.created_at,symbols:n.symbols||[],verification:'NEWS_FEED_ONLY'}));
    const discovered=[...(movers.gainers||[]).map(r=>r.symbol),...(active.most_actives||[]).map(r=>r.symbol),...news.flatMap(n=>n.symbols)].filter(v=>typeof v==='string'&&/^[A-Z][A-Z0-9.]{0,9}$/.test(v)&&(!assetMasterAsOf||assetEligibility(assetMaster[v],assetMasterAsOf,now()).allowed));
    const today=dateKey(now()),prior=discoveryDate===today?symbols:SYMBOLS;
    const next=[...new Set([...state.openPositions.map(p=>p.symbol),...BENCHMARK_SYMBOLS,...discovered,...prior])].slice(0,180);
    if(next.slice().sort().join(',')!==symbols.slice().sort().join(',')){symbols=next;referenceDate=null;lastBaselineAttempt=-Infinity;lastBarsAt=-Infinity;}
    discoveryDate=today;
    console.info('Stock research discovery: '+JSON.stringify({sources:Object.fromEntries(names.map((name,i)=>[name,results[i].status==='fulfilled'&&!errors[name]?'AVAILABLE':'UNAVAILABLE'])),symbols:symbols.length,news:news.length,errors}));
    const copy=structuredClone(state);
    if(assetMasterAsOf)copy.assetResearch={asOf:assetMasterAsOf,source:'Alpaca paper asset master',assets:Object.fromEntries(symbols.filter(s=>assetMaster[s]).map(s=>[s,assetMaster[s]])),error:errors.assets||null};
    else copy.assetResearch={...(copy.assetResearch||{}),error:errors.assets||'Asset master unavailable'};
    const eligible=symbols.filter(symbol=>assetEligibility(copy.assetResearch?.assets?.[symbol],copy.assetResearch?.asOf,now()).allowed);
    console.info('Stock operational universe: '+JSON.stringify({eligibleSymbols:eligible.length,sample:eligible.slice(0,10),assetSourceAsOf:copy.assetResearch?.asOf||null,assetError:copy.assetResearch.error,macroGate:macroEntryGate(copy.economicCalendar,now()),sectorPolicy:'No sector entry restriction'}));
    copy.marketResearch={updatedAt:new Date(now()).toISOString(),symbols,news,errors,sourceStatus:Object.fromEntries(names.map((name,i)=>[name,results[i].status==='fulfilled'&&!errors[name]?'AVAILABLE':'UNAVAILABLE'])),macroCalendarStatus:macroEntryGate(state.economicCalendar,now()).allowed?'AVAILABLE':'PAUSE_OR_INCOMPLETE',sectorExposureStatus:'NOT_USED',primarySourceVerificationStatus:'NEWS_FEED_ONLY',note:'Screeners may reflect previous session before open; price/volume confirmation remains required. IEX execution quotes and 16-minute delayed SIP premarket research.'};commit(copy);
  }
  async function refreshBars(openAt) {
    if(now()-lastBarsAt<MINUTE)return;
    let page=null, all={};
    do {
      const p=new URLSearchParams({symbols:symbols.join(','),timeframe:'5Min',start:new Date(openAt).toISOString(),end:new Date(now()-1000).toISOString(),limit:'10000',feed:'iex',adjustment:'raw',sort:'asc'});
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
  async function refreshBaselines(openAt,gen) {
    const today=dateKey(now());
    if(baselineDate!==today){baselines={};baselineDate=today;lastBaselineAttempt=-Infinity;}
    const missing=symbols.filter(symbol=>!baselines[symbol]).slice(0,12);if(!missing.length)return;
    if(now()-lastBaselineAttempt<MINUTE)return;
    lastBaselineAttempt=now();
    const shared={symbols:missing.join(','),end:new Date(openAt-330*MINUTE-1000).toISOString(),limit:'10000',sort:'asc'};
    try{
      const daily=await collectBars({...shared,timeframe:'1Day',start:new Date(openAt-45*86400000).toISOString(),feed:'sip',adjustment:'split'});
      const historical=await collectBars({...shared,timeframe:'5Min',start:new Date(openAt-21*86400000).toISOString(),feed:'iex',adjustment:'raw'});
      if(gen!==generation||!state.running)return;
      Object.assign(baselines,buildBaselines(daily,historical,today,missing));
    }catch(error){console.warn('Stock historical baseline warmup: '+error.message);}
  }

  async function researchPremarket(openAt,gen) {
    if(now()-lastResearchAt<MINUTE)return;
    lastResearchAt=now();const start=openAt-330*MINUTE,end=now()-16*MINUTE,today=dateKey(now());
    if(end<=start){const s=structuredClone(state);s.premarketAnalysis={sessionDate:today,lastUpdatedAt:new Date(now()).toISOString(),source:'Consolidated SIP historical data',minimumDelayMinutes:16,rankings:[],status:'Waiting for delayed premarket bars'};commit(s);return;}
    try{
      if(referenceDate!==today){
        const data=await collectBars({symbols:symbols.join(','),timeframe:'1Day',start:new Date(openAt-14*86400000).toISOString(),end:new Date(start-1000).toISOString(),limit:'10000',feed:'sip',adjustment:'split',sort:'asc'});
        const refs={};for(const [sym,rows]of Object.entries(data)){const last=rows.filter(b=>dateKey(Date.parse(b.t))<today&&valid(b.c)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)).at(-1);if(last)refs[sym]=last.c;}referenceCloses=refs;referenceDate=today;
      }
      const bars=await collectBars({symbols:symbols.join(','),timeframe:'5Min',start:new Date(start).toISOString(),end:new Date(end).toISOString(),limit:'10000',feed:'sip',adjustment:'raw',sort:'asc'});
      if(gen!==generation||!state.running)return;
      await refreshBaselines(openAt,gen);if(gen!==generation||!state.running)return;
      const rankings=rankPremarket(bars,referenceCloses,now(),start,end,symbols),benchmark=rankings.find(r=>r.symbol==='SPY');
      const s=structuredClone(state);s.premarketAnalysis={sessionDate:today,lastUpdatedAt:new Date(now()).toISOString(),source:'Consolidated SIP historical data',minimumDelayMinutes:16,rankings,status:rankings.length?'Premarket watchlist ranked; research only':'No delayed premarket bars available yet',benchmarkGapPercent:benchmark?.gapPercent??null};if(!s.openPositions.length)s.lastError=null;commit(s);
    }catch(e){if(gen!==generation)return;const s=structuredClone(state);s.premarketAnalysis={...(s.premarketAnalysis||{}),sessionDate:today,lastAttemptAt:new Date(now()).toISOString(),status:'Premarket data unavailable',error:e.message,minimumDelayMinutes:16};commit(s);}
  }
  function buy(symbol,q,signal,metrics) {
    const gate=researchGate(symbol);if(!gate.allowed)return false;
    const entriesToday=state.history.filter(r=>r.type==='BUY'&&r.symbol===symbol&&dateKey(Date.parse(r.time))===dateKey(now())).length;
    const stoppedToday=state.history.some(r=>r.type==='SELL'&&r.symbol===symbol&&dateKey(Date.parse(r.time))===dateKey(now())&&(r.exitCategory||exitCategory(r.reason))==='STOP');
    const cooldown=(state.lastExitWon[symbol]?5:15)*MINUTE;
    const equity=state.cashUsd+state.openPositions.reduce((s,p)=>s+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0),notional=Math.min(state.nextEntryUsd,gate.macro.degraded?10:20,equity*0.2,equity*0.0025/(0.012+2*SLIPPAGE+2*FEE+q.spreadPercent/100));
    if(!state.running||state.riskSession?.halted||stoppedToday||state.openPositions.length>=3||state.openPositions.some(p=>p.symbol===symbol)||now()-Number(state.lastExitAt[symbol]||0)<cooldown||entriesToday>=2||notional<10||state.cashUsd<notional*(1+FEE))return false;
    const s=structuredClone(state), entryPrice=q.ask*(1+SLIPPAGE), quantity=notional/entryPrice;
    const p={id:randomUUID(),symbol,tokenAddress:symbol,entryPrice,entryReferencePriceUsd:q.mid,entryQuoteTime:q.time,quantity,originalQuantity:quantity,notionalUsd:notional,costBasisUsd:notional*(1+FEE),originalCostBasisUsd:notional*(1+FEE),entryFeeUsd:notional*FEE,highestPrice:q.bid,lowestPrice:q.bid,markPriceUsd:q.bid,lastMarkAt:q.time,maxRunUpPercent:0,maxAdverseExcursionPercent:Math.min(0,(q.bid/entryPrice-1)*100),maxDrawdownPercent:0,excursionCoverage:'Observed bid quotes during 15-second monitoring; not tick-by-tick extremes',entryTime:new Date(now()).toISOString(),strategy:STRATEGY,entryReason:signal,entryMetrics:metrics,partialTaken:false,realizedPnlUsd:0};
    s.cashUsd-=p.costBasisUsd;s.openPositions.push(p);
    s.history.unshift({...p,type:'BUY',positionId:p.id,amountUsd:notional,amountInvested:p.costBasisUsd,estimatedFeesUsd:p.entryFeeUsd,estimatedSlippageUsd:quantity*(entryPrice-q.ask),estimatedSpreadUsd:quantity*(q.ask-q.mid),time:p.entryTime,mode:'PAPER'});commit(s);return true;
  }
  function sell(id,q,reason,partial=false) {
    const s=structuredClone(state),i=s.openPositions.findIndex(p=>p.id===id);if(i<0)return;
    const p=s.openPositions[i];if(partial&&p.partialTaken)return;
    const quantity=partial?Math.min(p.quantity,p.originalQuantity*0.5):p.quantity,ratio=quantity/p.quantity,cost=p.costBasisUsd*ratio,entryFee=p.entryFeeUsd*ratio;
    const exitPrice=q.bid*(1-SLIPPAGE),gross=quantity*exitPrice,fee=gross*FEE,proceeds=gross-fee,pnl=proceeds-cost,time=new Date(now()).toISOString();
    const hasReference=valid(p.entryReferencePriceUsd),pnlWithoutCostsUsd=hasReference?quantity*(q.mid-p.entryReferencePriceUsd):null;
    const estimatedSlippageUsd=quantity*(p.entryPrice-p.entryPrice/(1+SLIPPAGE)+q.bid-exitPrice);
    const estimatedSpreadUsd=hasReference?quantity*(p.entryPrice/(1+SLIPPAGE)-p.entryReferencePriceUsd+q.mid-q.bid):null;
    const closed=!partial,totalPositionPnl=p.realizedPnlUsd+pnl;
    s.cashUsd+=proceeds;
    s.history.unshift({...p,id:randomUUID(),type:'SELL',positionId:p.id,quantity,costBasisUsd:cost,exitPrice,exitReferencePriceUsd:q.mid,exitQuoteTime:q.time,exitTime:time,time,amountInvested:cost,investedUsd:cost,saleValueUsd:proceeds,saleGrossUsd:gross,amountUsd:proceeds,pnl,pnlUsd:pnl,netPnlUsd:pnl,pnlWithoutCostsUsd,totalCostsUsd:hasReference?pnlWithoutCostsUsd-pnl:null,pnlPercent:pnl/cost*100,returnPercent:pnl/cost*100,estimatedFeesUsd:entryFee+fee,estimatedSlippageUsd,estimatedSpreadUsd,exitCategory:exitCategory(reason),exitReason:reason,reason,holdTimeMs:now()-Date.parse(p.entryTime),partial,closed,totalPositionPnlUsd:closed?totalPositionPnl:null,mode:'PAPER'});
    if(closed){s.openPositions.splice(i,1);s.closedDates[p.symbol]=dateKey(now());s.lastExitAt[p.symbol]=now();s.lastExitWon[p.symbol]=totalPositionPnl>0;s.nextEntryUsd=totalPositionPnl>0?Math.min(20,Math.round(s.nextEntryUsd*1.1*100)/100):10;}
    else{p.quantity-=quantity;p.costBasisUsd-=cost;p.entryFeeUsd-=entryFee;p.realizedPnlUsd=totalPositionPnl;p.partialTaken=true;p.trailingActivatedAt=time;p.runnerHighestPrice=q.bid;}
    commit(s);
  }
  function updatePositions(snapshots,flatten=false) {
    if(flatten){const s=structuredClone(state);for(const p of s.openPositions)p.pendingExitReason||='SESSION CLOSE 10 MIN BEFORE BELL';commit(s);}
    for(const p of structuredClone(state.openPositions)) {
      const q=quote(snapshots[p.symbol],now());
      if(!q){
        if(now()-Date.parse(p.entryTime)>=60*MINUTE||dateKey(Date.parse(p.entryTime))!==dateKey(now())){
          const pending=structuredClone(state),held=pending.openPositions.find(x=>x.id===p.id);
          held.pendingExitReason||=dateKey(Date.parse(p.entryTime))!==dateKey(now())?'RECOVERY EXIT FROM PREVIOUS SESSION':'TIME EXIT 60 MIN';commit(pending);
        }
        continue;
      }
      const s=structuredClone(state),current=s.openPositions.find(x=>x.id===p.id);
      current.markPriceUsd=q.bid;current.highestPrice=Math.max(current.highestPrice,q.bid);commit(s);
      const change=(q.bid/p.entryPrice-1)*100;
      if(current.pendingExitReason)sell(p.id,q,current.pendingExitReason);
      else if(flatten || dateKey(Date.parse(p.entryTime))!==dateKey(now()))sell(p.id,q,flatten?'SESSION CLOSE 10 MIN BEFORE BELL':'RECOVERY EXIT FROM PREVIOUS SESSION');
      else if(change<=-1.2)sell(p.id,q,'STOP TRIGGER -1.2%');
      else if(now()-Date.parse(p.entryTime)>=60*MINUTE)sell(p.id,q,'TIME EXIT 60 MIN');
      else if(!current.partialTaken && change>=1.5)sell(p.id,q,'PARTIAL TP +1.5%: SELL 50% ORIGINAL',true);
      else if(current.partialTaken){const floor=current.costBasisUsd/current.quantity/((1-SLIPPAGE)*(1-FEE))*1.0005,stop=Math.max(floor,(current.runnerHighestPrice??q.bid)*0.9925);if(q.bid<=stop)sell(p.id,q,'RUNNER TRAIL 0.75% / COST-ADJUSTED BREAK EVEN');}
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
      ensureRiskSession(marketOpen);
      void enrichResearch(gen);
      if(!marketOpen){
        const opening=Date.parse(nextOpen),premarket=Number.isFinite(opening)&&dateKey(opening)===dateKey(now())&&now()>=opening-330*MINUTE&&now()<opening;
        sessionMode=state.openPositions.length?'EXIT_PENDING_MARKET_CLOSED':premarket?'PREMARKET_ANALYSIS':'MARKET_CLOSED';
        const s=structuredClone(state);s.lastError=state.openPositions.length?'Session exit pending: no fresh regular-session quotes; will retry next open':null;commit(s);
        await discover(gen);if(premarket)await researchPremarket(opening,gen);return;
      }
      const closeAt=Date.parse(nextClose);if(!Number.isFinite(closeAt)||closeAt<=now())throw Error('Invalid market closing time');
      const openAt=sessionOpen(nextClose),flatten=closeAt-now()<=10*MINUTE;
      const snapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:symbols.join(','),feed:'iex'}));
      if(gen!==generation||!state.running)return;
      markPositions(snapshots);
      const dailyHalt=applyDailyRisk(snapshots);
      if(!dailyHalt)updatePositions(snapshots,flatten);
      // Realized execution costs or a stop can breach the limit after marking.
      applyDailyRisk(snapshots);
      const marked=structuredClone(state),equity=marked.cashUsd+marked.openPositions.reduce((s,p)=>s+p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),0);
      marked.peakEquityUsd=Math.max(marked.peakEquityUsd,equity);marked.maxDrawdownPercent=Math.max(marked.maxDrawdownPercent,(1-equity/marked.peakEquityUsd)*100);commit(marked);
      dailyPnlUsd=equityOf()-state.riskSession.capitalUsd;
      sessionMode=state.riskSession.halted?'DAILY_LOSS_PAUSE':flatten?'CLOSING_SESSION':state.openPositions.some(p=>p.pendingExitReason)?'EXIT_PENDING_QUOTE':closeAt-now()<=30*MINUTE?'NO_NEW_ENTRIES':now()<openAt+15*MINUTE?'OPENING_WAIT':'SCANNING';
      if(sessionMode!=='SCANNING'){
        const s=structuredClone(state);s.lastError=(flatten||s.riskSession.halted||s.openPositions.some(p=>p.pendingExitReason))&&s.openPositions.length?'Exit pending: waiting for fresh quotes; new entries blocked':null;commit(s);return;
      }
      if(now()-lastBarsAt<MINUTE)return;
      await discover(gen);if(gen!==generation||!state.running)return;
      await refreshBaselines(openAt,gen);if(gen!==generation||!state.running)return;
      await refreshBars(openAt);if(gen!==generation||!state.running)return;
      const currentClock=await request('https://paper-api.alpaca.markets/v2/clock');
      if(gen!==generation||!state.running)return;
      const checkedTimestamp=Date.parse(currentClock.timestamp),checkedClose=Date.parse(currentClock.next_close);
      if(currentClock.is_open!==true||!Number.isFinite(checkedTimestamp)||Math.abs(now()-checkedTimestamp)>120000||!Number.isFinite(checkedClose)||checkedClose-now()<=30*MINUTE)return;
      const ranked=[],rejections=[];
      const freshSnapshots=await request('https://data.alpaca.markets/v2/stocks/snapshots?'+new URLSearchParams({symbols:symbols.join(','),feed:'iex'}));
      if(gen!==generation||!state.running)return;
      if(checkedClose-now()<=30*MINUTE)return;
      // Recheck risk and timed exits after entry research/network requests.
      markPositions(freshSnapshots);
      if(applyDailyRisk(freshSnapshots)){sessionMode='DAILY_LOSS_PAUSE';return;}
      updatePositions(freshSnapshots,checkedClose-now()<=10*MINUTE);
      if(applyDailyRisk(freshSnapshots)){sessionMode='DAILY_LOSS_PAUSE';return;}
      const marketStrength=sessionStrength(barsCache.SPY,now(),openAt);
      for(const symbol of symbols){
        const a=assess(freshSnapshots[symbol],barsCache[symbol],now(),openAt,baselines[symbol]);
        if(!a.accepted){rejections.push({symbol,reason:a.reason,metrics:a.metrics||null,time:new Date(now()).toISOString()});continue;}
        const gate=researchGate(symbol);
        const own=sessionStrength(barsCache[symbol],now(),openAt),sector=gate.profile?.sector||'UNKNOWN',benchmark=SECTOR_BENCHMARKS[sector];
        const sectorStrength=sessionStrength(barsCache[benchmark],now(),openAt);
        const relativeToMarket=own&&marketStrength?own.returnPercent-marketStrength.returnPercent:null;
        const relativeToSector=own&&sectorStrength?own.returnPercent-sectorStrength.returnPercent:null;
        const news=(state.marketResearch?.news||[]).filter(n=>n.symbols.includes(symbol)).map(n=>({...n,evidence:[],verification:'NEWS_FEED_ONLY'}));
        const metrics={...a.metrics,news,researchAsOf:state.marketResearch?.updatedAt||null,sector,sectorBasis:gate.profile?.sectorBasis,sectorBenchmark:benchmark,relativeToMarketPercent:relativeToMarket,relativeToSectorPercent:relativeToSector,sectorAboveVwap:sectorStrength?.aboveVwap??null,macroGate:macroEntryGate(state.economicCalendar,now()),riskBudgetPercent:0.25,assetIdentitySource:'Alpaca',assetIdentityAsOf:state.assetResearch?.asOf,assetExchange:gate.asset?.exchange,researchWarnings:gate.macro?.warnings||[]};
        const reason=!gate.allowed?gate.reason:relativeToMarket===null?'Fresh SPY benchmark bars unavailable':relativeToMarket< -0.25?'Underperforming SPY by more than 0.25 percentage points':null;
        if(reason){rejections.push({symbol,reason,metrics,time:new Date(now()).toISOString()});continue;}
        const research=state.premarketAnalysis?.sessionDate===dateKey(now())?state.premarketAnalysis.rankings?.find(r=>r.symbol===symbol&&r.longWatchCandidate):null;
        const newsScore=Math.min(2,news.reduce((sum,n)=>sum+(n.evidence.length?1:0.25),0));
        ranked.push({symbol,...a,metrics,score:a.score+Math.min(3,(research?.score||0)*0.1)+newsScore+Math.max(-2,Math.min(2,relativeToSector||0))});
      }
      ranked.sort((a,b)=>b.score-a.score);
      let entered=0;
      for(const c of ranked){if(buy(c.symbol,c.quote,c.signal,c.metrics)){entered++;if(applyDailyRisk(freshSnapshots)){sessionMode='DAILY_LOSS_PAUSE';break;}}else rejections.push({symbol:c.symbol,reason:researchGate(c.symbol).allowed?'Setup qualified; position, cash, risk budget, cooldown or daily entry limit':researchGate(c.symbol).reason,metrics:c.metrics,time:new Date(now()).toISOString()});}
      const s=structuredClone(state);s.lastScanAt=new Date(now()).toISOString();s.lastError=null;s.rejections=rejections;
      s.scanDiagnostics={scanned:symbols.length,qualified:ranked.length,entered,lastScanAt:s.lastScanAt,watchlist:symbols,filters:SCAN_FILTERS,baselineSessionDate:baselineDate,baselineSymbolsReady:Object.keys(baselines).length,qualifiedSetups:ranked.map(c=>({symbol:c.symbol,signal:c.signal,score:c.score,metrics:c.metrics})),skippedByReason:rejections.reduce((out,r)=>{out[r.reason]=(out[r.reason]||0)+1;return out;},{})};
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
      markPositions(snapshots);
      for(const p of structuredClone(state.openPositions)){const q=quote(snapshots[p.symbol],now());if(q){sell(p.id,q,'MANUAL PAPER CLOSE');results.push({success:true,symbol:p.symbol});}else results.push({success:false,symbol:p.symbol,error:'Fresh exit bid unavailable'});}
    }catch(e){results.push({success:false,error:e.message});}finally{busy=false;}
    return {success:results.every(r=>r.success),results};
  }
  function getStatus(){return {running:state.running&&configured()&&connection==='CONNECTED',enabled:state.running,mode:'PAPER',tradingStyle:'INTRADAY_OPPORTUNITY',watchlistSize:symbols.length,sessionMode,dailyPnlUsd:state.riskSession?equityOf()-state.riskSession.capitalUsd:dailyPnlUsd,riskRules:RISK_RULES,riskSession:state.riskSession||null,pendingExits:state.openPositions.filter(p=>p.pendingExitReason).map(p=>({symbol:p.symbol,reason:p.pendingExitReason})),connection:configured()?connection:'WAITING_FOR_ALPACA',marketOpen,nextOpen,nextClose,lastScanAt:state.lastScanAt,lastError:state.lastError,premarketLastUpdatedAt:state.premarketAnalysis?.lastUpdatedAt||null,premarketDataDelayMinutes:16,researchStatus:{assetIdentitySource:'Alpaca',assetDataAsOf:state.assetResearch?.asOf||null,eligibleSymbolCount:symbols.filter(symbol=>assetEligibility(state.assetResearch?.assets?.[symbol],state.assetResearch?.asOf,now()).allowed).length,macroGate:macroEntryGate(state.economicCalendar,now()),sectorEntryRestrictions:false},statusMessage:!configured()?'Waiting for Alpaca paper API connection':!state.running?'Stopped':state.lastError||(sessionMode==='PREMARKET_ANALYSIS'?'Analyzing premarket movers; consolidated data delayed at least 16 min; no premarket orders':!marketOpen?'Market closed; next research window starts 4am ET':sessionMode==='CLOSING_SESSION'?'Closing positions before market close':sessionMode==='NO_NEW_ENTRIES'?'Last 30 minutes: exits only':sessionMode==='DAILY_LOSS_PAUSE'?'Daily 2.5% loss limit reached: liquidating; entries halted until next trading day':sessionMode==='OPENING_WAIT'?'First 15 minutes: monitoring only':sessionMode==='EXIT_PENDING_QUOTE'?'Pending liquidation: waiting for fresh quotes':(!macroEntryGate(state.economicCalendar,now()).allowed?macroEntryGate(state.economicCalendar,now()).reason:'Scanning news, sector strength, intraday breakouts and pullback recoveries')),openPositions:state.openPositions.length,maxOpenPositions:3};}
  function getDashboardData(){
    const livePositions=state.openPositions.map(p=>{const value=p.quantity*p.markPriceUsd*(1-SLIPPAGE)*(1-FEE),pnl=value-p.costBasisUsd;return {position:p,live:{priceUsd:p.markPriceUsd,currentValue:value,pnl,pnlPercent:pnl/p.costBasisUsd*100,holdTimeMs:now()-Date.parse(p.entryTime)},pnl};});
    const equity=state.cashUsd+livePositions.reduce((s,p)=>s+p.live.currentValue,0),totalPnl=equity-100;
    const groups=new Map();for(const row of state.history){if(row.type!=='SELL')continue;if(!groups.has(row.positionId))groups.set(row.positionId,[]);groups.get(row.positionId).push(row);}
    const completedTrades=[];for(const [id,rows]of groups){const final=rows.find(r=>r.closed===true||(r.closed===undefined&&r.partial!==true));if(!final)continue;const invested=rows.reduce((s,r)=>s+r.amountInvested,0),proceeds=rows.reduce((s,r)=>s+r.saleValueUsd,0),pnl=proceeds-invested,quantity=rows.reduce((s,r)=>s+r.quantity,0);completedTrades.push({...final,id,positionId:id,quantity,amountInvested:invested,investedUsd:invested,costBasisUsd:invested,saleValueUsd:proceeds,pnl,pnlUsd:pnl,pnlPercent:pnl/invested*100,returnPercent:pnl/invested*100,estimatedFeesUsd:rows.reduce((s,r)=>s+(r.estimatedFeesUsd||0),0),exitPrice:rows.reduce((s,r)=>s+r.quantity*r.exitPrice,0)/quantity});}
    for(const trade of completedTrades){
      const rows=groups.get(trade.positionId)||[],covered=rows.every(r=>Number.isFinite(r.pnlWithoutCostsUsd));
      trade.pnlWithoutCostsUsd=covered?rows.reduce((s,r)=>s+r.pnlWithoutCostsUsd,0):null;
      trade.netPnlUsd=trade.pnlUsd;trade.totalCostsUsd=covered?trade.pnlWithoutCostsUsd-trade.pnlUsd:null;
      trade.estimatedSlippageUsd=rows.every(r=>Number.isFinite(r.estimatedSlippageUsd))?rows.reduce((s,r)=>s+r.estimatedSlippageUsd,0):null;
      trade.estimatedSpreadUsd=rows.every(r=>Number.isFinite(r.estimatedSpreadUsd))?rows.reduce((s,r)=>s+r.estimatedSpreadUsd,0):null;
      trade.maxDrawdownPercent ??= null;trade.maxRunUpPercent ??= null;
    }
    const reports=tradeReports(state.history,completedTrades,now());
    return {label:'Stock Bot',marketResearch:state.marketResearch||null,assetResearch:state.assetResearch||null,economicCalendar:state.economicCalendar||null,macroEntryGate:macroEntryGate(state.economicCalendar,now()),sectorExposure:state.openPositions.reduce((out,p)=>{const sector=p.entryMetrics?.sector||'UNKNOWN';out[sector]=(out[sector]||0)+1;return out;},{}),reports,mode:'PAPER',paperOnly:true,simulation:'Local paper ledger; no broker orders',exchange:'Alpaca IEX market data',strategy:STRATEGY,scannerFilters:SCAN_FILTERS,premarketAnalysis:state.premarketAnalysis||null,scanDiagnostics:state.scanDiagnostics||null,startingBalance:100,startingBalanceUsd:100,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:totalPnl,livePositions,completedTrades,history:state.history,rejections:state.rejections,lastScanAt:state.lastScanAt,lastError:state.lastError,maxDrawdownPercent:state.maxDrawdownPercent,estimatedFeePercentPerSide:FEE*100,estimatedSlippagePercentPerSide:SLIPPAGE*100,nextTradeSizeUsd:state.nextEntryUsd,compoundIncrementPercent:10,maxTradeSizeUsd:20,maxEntriesPerSymbolPerDay:2,maxReentriesPerSymbolPerDay:1,maxOpenPositions:3,...getStatus(),openPositions:livePositions};
  }
  return {start,stop,tick,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state)};
}
let singleton;
const instance=()=>singleton||(singleton=createStockBot());
module.exports={assetEligibility,parseEconomicCalendar,parseFedCalendar,macroEntryGate,easternTimestamp,sessionStrength,createStockBot,assess,quote,sessionOpen,rankPremarket,buildBaselines,sameTimeVolume,SYMBOLS,STRATEGY,SCAN_FILTERS,RISK_RULES,tradeReports,exitCategory,start:()=>instance().start(),stop:()=>instance().stop(),closeAll:()=>instance().closeAll(),getStatus:()=>instance().getStatus(),getDashboardData:()=>instance().getDashboardData()};



