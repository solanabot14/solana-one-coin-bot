"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createCoinbaseNews } = require("./coinbaseNews");

const STARTING_BALANCE_USD = 200;
const MAX_OPEN_POSITIONS = 6;
const START_SIZE_USD = 10;
const COMPOUND_RATE = 0.10;
const HARD_STOP_PERCENT = 2.0;
const STOP_MIN_PERCENT = 1.5;
const STOP_MAX_PERCENT = 2.5;
const ATR_STOP_MULTIPLE = 1.4;
const TP1_PERCENT = 3.0;
const TP2_PERCENT = 5.0;
const TP1_SELL_FRACTION = 0.50;
const TP2_SELL_FRACTION = 0.30;
const RUNNER_FRACTION = 0.20;
const RUNNER_TRAIL_PERCENT = 2.0;
const MOMENTUM_DECAY_MIN_MS = 10 * 60 * 1000;
const MOMENTUM_DECAY_MAX_MS = 15 * 60 * 1000;
const MAX_HOLD_MS = 25 * 60 * 1000;
const LEGACY_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DAILY_LOSS_FRACTION = 0.03;
const MIN_DAILY_GAIN_PERCENT = 1.0;
const MAX_DAILY_GAIN_PERCENT = 30;
const MIN_HOUR_GAIN_PERCENT = 0.35;
const MIN_DAILY_VOLUME_USD = 5_000_000;
const MIN_RELATIVE_VOLUME_15M = 1.5;
const MIN_MOMENTUM_SCORE = 70;
const MAX_SCAN_PRODUCTS = 180;
const MAX_MOVER_CANDLES = 45;
const PRODUCT_CACHE_MS = 15 * 60 * 1000;
const MAX_SPREAD_PERCENT = 0.30;
const MAX_EXIT_SPREAD_PERCENT = 0.60;
const COIN_COOLDOWN_MS = 30 * 60 * 1000;
const END_OF_DAY_PR = "23:45";
const FEE_RATE = Math.min(0.01, Math.max(0, Number(process.env.OUTCOME_PAPER_FEE_RATE ?? 0.006)));
const SLIPPAGE_RATE = Math.min(0.005, Math.max(0, Number(process.env.OUTCOME_PAPER_SLIPPAGE_RATE ?? 0.001)));
const SCAN_INTERVAL_MS = 45_000;
const MONITOR_INTERVAL_MS = 5_000;
const MOMENTUM_RECHECK_MS = 60_000;
const PRODUCTS = ["BTC-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","LINK-USD","AVAX-USD","DOT-USD","LTC-USD","BCH-USD","UNI-USD","XLM-USD","SUI-USD","AAVE-USD"];
const BASE_URL = "https://api.exchange.coinbase.com";
const STRATEGY_VERSION = "COINBASE_INTRADAY_MOMENTUM_V5";
const MIN_POSITION_EQUITY_FRACTION = 0.05;
const MAX_POSITION_EQUITY_FRACTION = 0.10;
const REQUEST_INTERVAL_MS = 200;
const MAX_429_RETRIES = 3;

function localDayKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {timeZone:"America/Puerto_Rico",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(timestamp));
}
function defaultFile() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "outcome-paper-state.json");
}
function freshState() {
  return {schemaVersion:1,startingBalanceUsd:STARTING_BALANCE_USD,cashUsd:STARTING_BALANCE_USD,coinCooldowns:{},openPositions:[],history:[],rejections:[],lastScanAt:null,lastError:null,running:false,nextEntryUsd:START_SIZE_USD,dailyPnlUsd:0,dailyStartingEquityUsd:STARTING_BALANCE_USD,dailyPnlDate:localDayKey(Date.now()),pausedForDailyLoss:false};
}
function validateState(s) {
  if (!s || s.schemaVersion !== 1 || !Number.isFinite(Number(s.cashUsd)) || !Array.isArray(s.openPositions) || !Array.isArray(s.history) || !Array.isArray(s.rejections)) throw new Error("Invalid Coinbase Bot paper state; refusing to reset it.");
  return s;
}
function estimatePortfolioEquity(s) {
  return Number(s.cashUsd||0) + (s.openPositions||[]).reduce((sum,p)=>sum + Number(p.quantity||0)*Number(p.markPriceUsd||p.marketEntryPrice||p.entryPrice||0)*(1-FEE_RATE-SLIPPAGE_RATE),0);
}
function migrateState(s, timestamp=Date.now()) {
  validateState(s);
  const today=localDayKey(timestamp);
  const realizedToday=(s.history||[]).reduce((sum,row)=>{
    if(String(row.type||"").toUpperCase()!=="SELL") return sum;
    const time=Date.parse(row.exitTime||row.time||row.timestamp||"");
    if(!Number.isFinite(time)||localDayKey(time)!==today) return sum;
    const pnl=Number(row.pnlUsd??row.pnl??row.realizedPnl); return sum+(Number.isFinite(pnl)?pnl:0);
  },0);
  const dailyPnlUsd=s.dailyPnlDate===today&&Number.isFinite(Number(s.dailyPnlUsd))?Number(s.dailyPnlUsd):realizedToday;
  const dailyStartingEquityUsd=s.dailyPnlDate===today&&Number(s.dailyStartingEquityUsd)>0?Number(s.dailyStartingEquityUsd):(estimatePortfolioEquity(s)||Number(s.startingBalanceUsd)||STARTING_BALANCE_USD);
  return validateState({...s,coinCooldowns:s.coinCooldowns&&typeof s.coinCooldowns==="object"?s.coinCooldowns:{},nextEntryUsd:Number(s.nextEntryUsd)>0?Number(s.nextEntryUsd):START_SIZE_USD,dailyPnlDate:today,dailyPnlUsd,dailyStartingEquityUsd,pausedForDailyLoss:s.pausedForDailyLoss===true||dailyPnlUsd<=-(dailyStartingEquityUsd*DAILY_LOSS_FRACTION)});
}

function createOutcomeBot({file=defaultFile(),io=fs,fetchImpl=globalThis.fetch,timers=globalThis,now=()=>Date.now(),newsProvider=null}={}) {
  let state=freshState();
  if(io.existsSync(file)) state=migrateState(JSON.parse(io.readFileSync(file,"utf8")),now());
  let scanTimer=null,monitorTimer=null,scanning=false,monitoring=false,lastMarketScan=[];
  let productCache=[],productCacheAt=0,lastRequestAt=0,requestQueue=Promise.resolve();
  const momentumChecks=new Map();
  const news=newsProvider||createCoinbaseNews({fetchImpl,now});

  function commit(next){
    validateState(next);io.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+"."+process.pid+"."+randomUUID()+".tmp";
    try{io.writeFileSync(tmp,JSON.stringify(next,null,2),{flag:"wx",flush:true});io.renameSync(tmp,file);}finally{if(io.existsSync(tmp))io.unlinkSync(tmp);}state=next;
  }
  function portfolioEquity(source=state){return Number(source.cashUsd||0)+(source.openPositions||[]).reduce((sum,p)=>sum+Number(p.quantity||0)*Number(p.markPriceUsd||p.marketEntryPrice||p.entryPrice||0)*(1-FEE_RATE-SLIPPAGE_RATE),0);}
  function dailyLossLimitUsd(source=state){return Math.max(0,Number(source.dailyStartingEquityUsd)||Number(source.startingBalanceUsd)||STARTING_BALANCE_USD)*DAILY_LOSS_FRACTION;}
  function localClock(timestamp){return new Intl.DateTimeFormat("en-GB",{timeZone:"America/Puerto_Rico",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(timestamp));}
  function isEndOfDay(timestamp=now()){return localClock(timestamp)>=END_OF_DAY_PR;}
  function rotateDay(next){const today=localDayKey(now());if(next.dailyPnlDate!==today){next.dailyPnlDate=today;next.dailyPnlUsd=0;next.dailyStartingEquityUsd=portfolioEquity(next);next.pausedForDailyLoss=false;next.coinCooldowns={};}}
  async function waitForRequestSlot(){const previous=requestQueue;let release;requestQueue=new Promise(r=>release=r);await previous;try{const delay=Math.max(0,REQUEST_INTERVAL_MS-(now()-lastRequestAt));if(delay>0)await new Promise(r=>setTimeout(r,delay));lastRequestAt=now();}finally{release();}}
  async function requestJson(url,signal){for(let attempt=0;;attempt++){await waitForRequestSlot();const response=await fetchImpl(url,{signal:signal||AbortSignal.timeout(8000),headers:{Accept:"application/json","User-Agent":"CoinbaseMomentumBot-Paper/5.0"}});if(response.status===429&&attempt<MAX_429_RETRIES){const retryAfter=Number(response.headers?.get?.("Retry-After"));await new Promise(r=>setTimeout(r,Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,10000):250*(2**attempt)));continue;}if(!response.ok)throw new Error("Coinbase market data HTTP "+response.status);return response.json();}}
  async function getStats(productId,signal){return requestJson(BASE_URL+"/products/"+encodeURIComponent(productId)+"/stats",signal);}
  async function getTicker(productId,signal){return requestJson(BASE_URL+"/products/"+encodeURIComponent(productId)+"/ticker",signal);}
  async function getCandles(productId,signal){const data=await requestJson(BASE_URL+"/products/"+encodeURIComponent(productId)+"/candles?granularity=300",signal);return Array.isArray(data)?data.map(r=>({time:Number(r[0]),low:Number(r[1]),high:Number(r[2]),open:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})).filter(c=>c.time&&c.close>0).sort((a,b)=>a.time-b.time):[];}
  function flattenRows(value){if(Array.isArray(value))return value.flatMap(flattenRows);return value&&typeof value==="object"?[value]:[];}
  async function getScanProducts(){
    if(productCache.length&&now()-productCacheAt<PRODUCT_CACHE_MS)return productCache.slice();
    const [products,volumeSummary]=await Promise.all([requestJson(BASE_URL+"/products"),requestJson(BASE_URL+"/products/volume-summary")]);
    const volumeById=new Map(flattenRows(volumeSummary).filter(r=>["USD","USDC"].includes(r.quote_currency)&&Array.isArray(r.market_types)&&r.market_types.includes("spot")).map(r=>[r.id,Number(r.spot_volume_24hour)||0]));
    const stable=new Set(["USDC","USDT","DAI","PYUSD","GUSD","USDP","USDS"]),wrapped=new Set(["WBTC","WETH","WSTETH","CBBTC","CBETH","WETH.E"]);
    const eligible=(Array.isArray(products)?products:[]).filter(p=>p&&p.id&&["USD","USDC"].includes(p.quote_currency)&&p.status==="online"&&!p.trading_disabled&&!p.cancel_only&&!p.post_only&&!p.limit_only&&!p.auction_mode&&!p.fx_stablecoin&&!stable.has(p.base_currency)&&!wrapped.has(p.base_currency)&&(!p.trading_start||(now()-Date.parse(p.trading_start)>=48*60*60*1000))&&(volumeById.get(p.id)||0)>=MIN_DAILY_VOLUME_USD).sort((a,b)=>(volumeById.get(b.id)||0)-(volumeById.get(a.id)||0)).slice(0,MAX_SCAN_PRODUCTS).map(p=>p.id);
    if(!eligible.length)throw new Error("Coinbase returned no active liquid USD spot products for momentum scan");productCache=eligible;productCacheAt=now();return eligible.slice();
  }
  async function mapLimit(items,limit,worker){const out=new Array(items.length);let next=0;async function run(){while(true){const i=next++;if(i>=items.length)return;out[i]=await worker(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out;}
  function ema(values,period){if(values.length<period)return null;const a=2/(period+1);let value=values.slice(0,period).reduce((s,n)=>s+n,0)/period;for(const n of values.slice(period))value=n*a+value*(1-a);return value;}
  function rsi(values,period=14){if(values.length<=period)return null;let gains=0,losses=0;for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)gains+=d;else losses-=d;}if(gains===0&&losses===0)return 50;if(losses===0)return 100;return 100-100/(1+gains/losses);}
  function median(values){const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
  function indicatorSnapshot(candles,last,at=now()){
    const closed=candles.filter(c=>Number(c.time)<Math.floor(at/300000)*300).slice(-288),prices=closed.map(c=>c.close).filter(n=>n>0);
    if(closed.length<30)return null;
    const current=closed.at(-1),previous=closed.at(-2),prior2=closed.at(-3),hourAnchor=closed.at(-13),fifteenAnchor=closed.at(-4);
    const hourChange=hourAnchor?.close>0?(last/hourAnchor.close-1)*100:0,fifteenChange=fifteenAnchor?.close>0?(last/fifteenAnchor.close-1)*100:0;
    const sessionStart=Math.floor(at/86400000)*86400000/1000,session=closed.filter(c=>c.time>=sessionStart),vwapVol=session.reduce((s,c)=>s+(c.volume||0),0),vwap=vwapVol>0?session.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0)/vwapVol:null;
    const ema9=ema(prices,9),ema21=ema(prices,21),rsi5m=rsi(prices,14);
    const recent15=closed.slice(-3).reduce((s,c)=>s+(c.volume||0),0),windows=[];for(let i=Math.max(0,closed.length-288);i+3<=closed.length-3;i+=3)windows.push(closed.slice(i,i+3).reduce((s,c)=>s+(c.volume||0),0));
    const avg15=windows.length?windows.reduce((s,n)=>s+n,0)/windows.length:0,rv15=avg15>0?recent15/avg15:0;
    const recent=closed.slice(-12),localHigh=Math.max(...recent.map(c=>c.high)),pullback=Math.max(0,(localHigh-last)/localHigh*100);
    const higherStructure=!!(current&&previous&&prior2&&current.close>previous.close&&previous.close>=prior2.close&&current.low>=prior2.low);
    const priorResistance=Math.max(...closed.slice(-4,-1).map(c=>c.high));
    const retest=previous&&previous.low<=priorResistance*1.004&&previous.close>=priorResistance*0.996;
    const breakout=!!(current&&retest&&current.close>Math.max(previous.high,priorResistance)&&current.close>current.open);
    const reclaim=!!(current&&previous&&pullback>=0.5&&pullback<=2.5&&current.close>previous.high&&current.close>current.open);
    const bodies=closed.slice(-12,-1).map(c=>Math.abs(c.close/c.open-1)*100),medianBody=median(bodies),lastBody=current?.open>0?Math.abs(current.close/current.open-1)*100:0;
    const fifteenMove=Math.abs(fifteenChange),spike=lastBody>=4|| (medianBody>0&&lastBody>medianBody*3.5) || (fifteenMove>0&&lastBody/fifteenMove>0.75&&lastBody>2.5);
    const atrBars=closed.slice(-15);const atr=atrBars.slice(1).reduce((sum,c,i)=>{const prev=atrBars[i].close;return sum+Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));},0)/14,atrPercent=last>0?atr/last*100:0;
    return {closed,current,previous,hourChange,fifteenChange,vwap,ema9,ema21,rsi5m,relativeVolume15m:rv15,pullback,higherStructure,breakout,reclaim,spike,lastBody,medianBody,atrPercent};
  }
  function assessCandidate(productId,stats,candles,at=now()){
    const last=Number(stats.last),open=Number(stats.open),volumeUsd=last*Number(stats.volume),dayChange=open>0?(last/open-1)*100:0,ind=indicatorSnapshot(candles,last,at),reasons=[];
    if(!(last>0&&open>0))reasons.push("Price unavailable");if(!Number.isFinite(volumeUsd)||volumeUsd<MIN_DAILY_VOLUME_USD)reasons.push("24h USD volume below $5M");if(dayChange<MIN_DAILY_GAIN_PERCENT)reasons.push("24h trend below +1%");if(dayChange>MAX_DAILY_GAIN_PERCENT)reasons.push("24h gain above +30% chase limit");if(!ind)reasons.push("Insufficient candle history");
    if(ind){if(ind.hourChange<MIN_HOUR_GAIN_PERCENT)reasons.push("1h momentum too weak");if(ind.fifteenChange<=0)reasons.push("15m momentum is not positive");if(ind.relativeVolume15m<MIN_RELATIVE_VOLUME_15M)reasons.push("15m relative volume below 1.5x");if(!(ind.vwap>0&&last>ind.vwap))reasons.push("Price below session VWAP");if(!(ind.ema9>ind.ema21))reasons.push("EMA9 not above EMA21");if(!(ind.rsi5m!==null&&ind.rsi5m<82))reasons.push("RSI too extended");if(ind.spike)reasons.push("Single-candle spike/chase rejected");if(!(ind.higherStructure||ind.breakout||ind.reclaim))reasons.push("No sustained higher-high/retest/reclaim structure");if(ind.pullback>3)reasons.push("Too far below local high");}
    let score=0;if(ind){score+=Math.min(25,Math.max(0,ind.hourChange*5));score+=Math.min(15,Math.max(0,ind.fifteenChange*6));score+=Math.min(20,Math.max(0,(ind.relativeVolume15m-1)*12));if(last>ind.vwap)score+=8;if(ind.ema9>ind.ema21)score+=8;if(ind.higherStructure)score+=8;if(ind.breakout||ind.reclaim)score+=10;if(ind.rsi5m>=50&&ind.rsi5m<=75)score+=6;if(ind.spike)score-=25;score=Math.max(0,Math.min(100,score));if(score<MIN_MOMENTUM_SCORE)reasons.push("Momentum score below 70");}
    const riskPercent=ind?Math.min(STOP_MAX_PERCENT,Math.max(STOP_MIN_PERCENT,ind.atrPercent*ATR_STOP_MULTIPLE)):HARD_STOP_PERCENT;
    const setup=ind?.breakout?"BREAKOUT_RETEST":ind?.reclaim?"PULLBACK_RECLAIM":ind?.higherStructure?"TREND_CONTINUATION":null;
    return {accepted:reasons.length===0,reasons,candidate:{productId,symbol:productId.split("-")[0],priceUsd:last,volumeUsd,dayChangePercent:dayChange,hourChangePercent:ind?.hourChange||0,fifteenMinChangePercent:ind?.fifteenChange||0,relativeVolume15m:ind?.relativeVolume15m||0,volumeRatio:ind?.relativeVolume15m||0,pullbackPercent:ind?.pullback||0,vwap:ind?.vwap||0,ema9:ind?.ema9||0,ema21:ind?.ema21||0,rsi5m:ind?.rsi5m??null,atrPercent:ind?.atrPercent||0,spikeRejected:!!ind?.spike,entrySetup:setup,riskPercent,score,candles:ind?.closed||[]}};
  }
  function recordRejections(rows){if(!rows.length)return;const next=structuredClone(state);next.rejections.unshift(...rows.map(r=>({time:new Date(now()).toISOString(),productId:r.productId,symbol:String(r.productId||"").split("-")[0],reason:(r.reasons||[]).join("; "),metrics:r.metrics||{}})));next.rejections=next.rejections.slice(0,150);commit(next);}
  function buy(candidate){
    const next=structuredClone(state);rotateDay(next);if(!next.running)return {success:false,error:"Coinbase Bot is stopped"};if(next.pausedForDailyLoss)return {success:false,error:"Daily loss limit reached"};if(next.openPositions.length>=MAX_OPEN_POSITIONS)return {success:false,error:"Six position limit reached"};if(next.openPositions.some(p=>p.productId===candidate.productId))return {success:false,error:"Coin already has an open position"};if(Number(next.coinCooldowns?.[candidate.productId])>now())return {success:false,error:"Coin re-entry cooldown active"};if(candidate.newsRisk)return {success:false,error:"Recent risk headline: "+candidate.newsRisk.title};
    const equity=portfolioEquity(next),notional=Math.min(Math.max(next.nextEntryUsd,equity*MIN_POSITION_EQUITY_FRACTION),equity*MAX_POSITION_EQUITY_FRACTION,next.cashUsd/(1+FEE_RATE));if(!(candidate.priceUsd>0)||notional<1)return {success:false,error:"Insufficient paper cash or invalid quote"};
    const entryPrice=candidate.priceUsd*(1+SLIPPAGE_RATE),quantity=notional/entryPrice,fee=notional*FEE_RATE,costBasisUsd=notional+fee,risk=Number(candidate.riskPercent)||HARD_STOP_PERCENT;
    const pos={id:randomUUID(),productId:candidate.productId,tokenAddress:candidate.productId,symbol:candidate.symbol,entryPrice,marketEntryPrice:candidate.priceUsd,highestPrice:candidate.priceUsd,quantity,originalQuantity:quantity,notionalUsd:notional,costBasisUsd,initialCostBasisUsd:costBasisUsd,remainingCostBasisUsd:costBasisUsd,entryFeeUsd:fee,realizedPnlUsd:0,entryTime:new Date(now()).toISOString(),strategyVersion:STRATEGY_VERSION,hardStopPercent:risk,stopPriceUsd:entryPrice*(1-risk/100),tp1Done:false,tp2Done:false,runnerTrailActive:false,markPriceUsd:candidate.priceUsd,lastMomentumCheckAt:0,strategy:"Coinbase Bot paper sustained momentum V5 · liquid USD/USDC · 15m/1h momentum + relative volume + VWAP + EMA + structure · spike rejection · 50% at +3%, 30% at +5%, 20% runner · ATR stop 1.5%-2.5% · momentum-decay exit · 25m max hold",entryMetrics:{dayChangePercent:candidate.dayChangePercent,hourChangePercent:candidate.hourChangePercent,fifteenMinChangePercent:candidate.fifteenMinChangePercent,relativeVolume15m:candidate.relativeVolume15m,score:candidate.score,entrySetup:candidate.entrySetup}};
    next.cashUsd-=costBasisUsd;next.openPositions.push(pos);next.history.unshift({type:"BUY",positionId:pos.id,productId:pos.productId,tokenAddress:pos.productId,symbol:pos.symbol,entryPrice:pos.entryPrice,quantity:pos.quantity,amountUsd:notional,feeUsd:fee,costBasisUsd:pos.costBasisUsd,time:pos.entryTime,entryTime:pos.entryTime,mode:"PAPER",strategy:pos.strategy,entryReason:"Sustained momentum score "+Number(candidate.score||0).toFixed(0)+"; "+(candidate.entrySetup||"trend continuation")});commit(next);return {success:true,position:structuredClone(pos)};
  }
  function sellQuantity(positionId,markPrice,requestedQuantity,reason,patch={}){
    const next=structuredClone(state);rotateDay(next);const index=next.openPositions.findIndex(p=>p.id===positionId);if(index<0)return {success:false,error:"Position not found"};const p=next.openPositions[index],price=Number(markPrice);if(!(price>0))return {success:false,error:"Invalid exit quote"};const quantityBefore=Number(p.quantity)||0,qty=Math.min(quantityBefore,Math.max(0,Number(requestedQuantity)||0));if(!(qty>0))return {success:false,error:"Invalid sell quantity"};const remainingCost=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd)||0,originalQty=Number(p.originalQuantity)||quantityBefore,allocatedCost=quantityBefore>0?remainingCost*(qty/quantityBefore):remainingCost,exitPrice=price*(1-SLIPPAGE_RATE),grossValue=qty*exitPrice,fee=grossValue*FEE_RATE,proceeds=grossValue-fee,pnlUsd=proceeds-allocatedCost,time=new Date(now()).toISOString(),allocatedEntryFee=(Number(p.entryFeeUsd)||0)*(qty/originalQty),remainingQty=Math.max(0,quantityBefore-qty),final=remainingQty<=Math.max(1e-12,originalQty*1e-8);
    next.cashUsd+=proceeds;next.dailyPnlUsd+=pnlUsd;if(next.dailyPnlUsd<=-dailyLossLimitUsd(next))next.pausedForDailyLoss=true;const totalRealized=(Number(p.realizedPnlUsd)||0)+pnlUsd;next.history.unshift({type:"SELL",id:randomUUID(),positionId:p.id,productId:p.productId,tokenAddress:p.productId,symbol:p.symbol,entryPrice:p.entryPrice,exitPrice,quantity:qty,amountUsd:proceeds,saleValueUsd:proceeds,costBasisUsd:allocatedCost,amountInvested:allocatedCost,pnl:pnlUsd,pnlUsd,pnlPercent:allocatedCost>0?pnlUsd/allocatedCost*100:0,estimatedFeesUsd:allocatedEntryFee+fee,estimatedSlippageUsd:(p.notionalUsd||0)*SLIPPAGE_RATE*(qty/originalQty)+grossValue*SLIPPAGE_RATE,time,entryTime:p.entryTime,exitTime:time,holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),maxGainPercent:p.entryPrice>0?(Number(p.highestPrice||price)/p.entryPrice-1)*100:0,reason,exitReason:reason,partial:!final,mode:"PAPER",strategy:p.strategy});
    if(final){next.openPositions.splice(index,1);next.coinCooldowns=next.coinCooldowns||{};next.coinCooldowns[p.productId]=now()+COIN_COOLDOWN_MS;momentumChecks.delete(p.id);if(totalRealized>0)next.nextEntryUsd=Math.round(next.nextEntryUsd*(1+COMPOUND_RATE)*100)/100;else next.nextEntryUsd=START_SIZE_USD;}else{p.quantity=remainingQty;p.remainingCostBasisUsd=Math.max(0,remainingCost-allocatedCost);p.costBasisUsd=p.remainingCostBasisUsd;p.realizedPnlUsd=totalRealized;Object.assign(p,patch);next.openPositions[index]=p;}
    commit(next);return {success:true,trade:structuredClone(next.history[0]),final};
  }
  function closePosition(positionId,markPrice,reason){const p=state.openPositions.find(x=>x.id===positionId);if(!p)return {success:false,error:"Position not found"};return sellQuantity(positionId,markPrice,p.quantity,reason);}
  async function btcMarketSelloff(){try{const bars=await getCandles("BTC-USD"),closed=bars.filter(c=>c.time<Math.floor(now()/300000)*300).slice(-13);if(closed.length<13)return false;const first=closed[0].close,last=closed.at(-1).close,drop=first>0?(last/first-1)*100:0,red=closed.slice(-4).filter(c=>c.close<c.open).length;return drop<=-2||(drop<=-1.5&&red>=3);}catch{return false;}}
  async function scanOnce(){
    if(!state.running||scanning||state.openPositions.length>=MAX_OPEN_POSITIONS||state.pausedForDailyLoss||isEndOfDay())return;scanning=true;
    try{const rejectionRows=[];let products;if(await btcMarketSelloff()){const next=structuredClone(state);next.lastScanAt=new Date(now()).toISOString();next.lastError=null;commit(next);recordRejections([{productId:"BTC-USD",reasons:["New long entries paused: BTC market selloff"]}]);return;}try{products=await getScanProducts();}catch(error){products=PRODUCTS.slice();rejectionRows.push({productId:"COINBASE-UNIVERSE",reasons:[error.message]});}await news.refresh();
      const marketRows=await mapLimit(products.filter(id=>!state.openPositions.some(p=>p.productId===id)&&!(Number(state.coinCooldowns?.[id])>now())),4,async productId=>{try{const stats=await getStats(productId),last=Number(stats.last),open=Number(stats.open),volumeUsd=last*Number(stats.volume),dayChange=open>0?(last/open-1)*100:0;if(!(last>0&&open>0)||!Number.isFinite(volumeUsd)||dayChange<MIN_DAILY_GAIN_PERCENT||dayChange>MAX_DAILY_GAIN_PERCENT||volumeUsd<MIN_DAILY_VOLUME_USD)return null;return {productId,stats,last,dayChange,volumeUsd};}catch(error){rejectionRows.push({productId,reasons:[error.message]});return null;}});
      const preRank=marketRows.filter(Boolean).sort((a,b)=>b.dayChange-a.dayChange).slice(0,MAX_MOVER_CANDLES),evaluated=await mapLimit(preRank,4,async row=>{try{return assessCandidate(row.productId,row.stats,await getCandles(row.productId));}catch(error){rejectionRows.push({productId:row.productId,reasons:[error.message]});return null;}}),ranked=evaluated.filter(Boolean);for(const result of ranked)if(!result.accepted)rejectionRows.push({productId:result.candidate.productId,reasons:result.reasons,metrics:{score:result.candidate.score,hourChangePercent:result.candidate.hourChangePercent,fifteenMinChangePercent:result.candidate.fifteenMinChangePercent,relativeVolume15m:result.candidate.relativeVolume15m}});lastMarketScan=ranked.map(r=>({...r.candidate,accepted:r.accepted,reasons:r.reasons})).sort((a,b)=>b.score-a.score);
      for(const candidate of ranked.filter(r=>r.accepted).map(r=>r.candidate).sort((a,b)=>b.score-a.score)){if(!state.running||state.openPositions.length>=MAX_OPEN_POSITIONS||state.pausedForDailyLoss)break;const risk=news.riskForProduct(candidate.productId);if(risk){rejectionRows.push({productId:candidate.productId,reasons:["News risk flag: "+risk.term],metrics:{headline:risk.title}});continue;}try{const ticker=await getTicker(candidate.productId),bid=Number(ticker.bid),ask=Number(ticker.ask),price=Number(ticker.price)||candidate.priceUsd,mid=bid>0&&ask>0?(bid+ask)/2:0,spread=mid>0?(ask-bid)/mid*100:0;if(spread>MAX_SPREAD_PERCENT){rejectionRows.push({productId:candidate.productId,reasons:["Bid/ask spread above 0.30%"],metrics:{spreadPercent:spread}});continue;}candidate.priceUsd=price;candidate.spreadPercent=spread;buy(candidate);}catch(error){rejectionRows.push({productId:candidate.productId,reasons:["Pre-entry quote failed: "+error.message]});}}
      recordRejections(rejectionRows.slice(0,80));const next=structuredClone(state);next.lastScanAt=new Date(now()).toISOString();next.lastError=null;commit(next);
    }catch(error){const next=structuredClone(state);next.lastError=error.message;commit(next);}finally{scanning=false;}
  }
  async function momentumStillValid(p,price){
    const lastCheck=momentumChecks.get(p.id)||0;if(now()-lastCheck<MOMENTUM_RECHECK_MS)return {valid:true,checked:false};momentumChecks.set(p.id,now());
    try{const candles=await getCandles(p.productId),ind=indicatorSnapshot(candles,price,now());if(!ind)return {valid:true,checked:true};const recent=ind.closed.slice(-3),redCount=recent.filter(c=>c.close<c.open).length,valid=price>ind.vwap&&ind.ema9>ind.ema21&&ind.fifteenChange>-0.25&&redCount<3;return {valid,checked:true,metrics:{vwap:ind.vwap,ema9:ind.ema9,ema21:ind.ema21,fifteenChange:ind.fifteenChange,redCount}};}catch{return {valid:true,checked:true};}
  }
  async function monitorLegacyPosition(snapshot,price){const p=state.openPositions.find(x=>x.id===snapshot.id);if(!p)return;const age=now()-Date.parse(p.entryTime),pnl=(price/p.entryPrice-1)*100;if(pnl<=-3)closePosition(p.id,price,"LEGACY HARD STOP -3%");else if(pnl>=5)closePosition(p.id,price,"LEGACY TAKE PROFIT +5%");else if(age>=LEGACY_MAX_HOLD_MS)closePosition(p.id,price,"LEGACY TIME EXIT 24H");}
  async function monitorV5Position(snapshot,price){
    let current=state.openPositions.find(p=>p.id===snapshot.id);if(!current)return;let next=structuredClone(state),p=next.openPositions.find(x=>x.id===snapshot.id);p.originalQuantity=Number(p.originalQuantity)||Number(p.quantity);p.initialCostBasisUsd=Number(p.initialCostBasisUsd)||Number(p.costBasisUsd);p.remainingCostBasisUsd=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd);p.realizedPnlUsd=Number(p.realizedPnlUsd)||0;p.markPriceUsd=price;if(price>Number(p.highestPrice||0))p.highestPrice=price;commit(next);
    const pnlPercent=(price/p.entryPrice-1)*100,age=now()-Date.parse(p.entryTime),stopPct=Number(p.hardStopPercent)||HARD_STOP_PERCENT;if(pnlPercent<=-stopPct){closePosition(p.id,price,"ATR HARD STOP -"+stopPct.toFixed(2)+"%");return;}
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;if(!current.tp1Done&&pnlPercent>=TP1_PERCENT){sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP1_SELL_FRACTION,"TAKE PROFIT +3% (50%)",{tp1Done:true,stopPriceUsd:current.entryPrice*(1+0.002)});}
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;if(!current.tp2Done&&pnlPercent>=TP2_PERCENT){sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP2_SELL_FRACTION,"TAKE PROFIT +5% (30%)",{tp1Done:true,tp2Done:true,runnerTrailActive:true,stopPriceUsd:current.entryPrice*(1+0.01)});}
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;next=structuredClone(state);p=next.openPositions.find(x=>x.id===snapshot.id);p.markPriceUsd=price;if(price>Number(p.highestPrice||0))p.highestPrice=price;let stop=p.entryPrice*(1-(Number(p.hardStopPercent)||HARD_STOP_PERCENT)/100);if(p.tp1Done)stop=Math.max(stop,p.entryPrice*1.002);if(p.tp2Done||p.runnerTrailActive)stop=Math.max(stop,p.entryPrice*1.01,p.highestPrice*(1-RUNNER_TRAIL_PERCENT/100));p.stopPriceUsd=stop;commit(next);if(price<=stop){closePosition(p.id,price,p.tp2Done?"RUNNER TRAILING STOP 2%":"PROTECTED STOP");return;}
    if(age>=MOMENTUM_DECAY_MIN_MS&&age<=MOMENTUM_DECAY_MAX_MS&&pnlPercent<0.5){const check=await momentumStillValid(p,price);if(check.checked&&!check.valid){closePosition(p.id,price,"MOMENTUM DECAY EXIT 10-15M");return;}}
    if(age>MOMENTUM_DECAY_MAX_MS&&pnlPercent<0.25){const check=await momentumStillValid(p,price);if(check.checked&&!check.valid){closePosition(p.id,price,"MOMENTUM LOST - FREE SLOT");return;}}
    if(age>=MAX_HOLD_MS&&pnlPercent<1)closePosition(p.id,price,"TIME STOP 25M UNDER +1%");
  }
  async function closeAllForReason(reason){const results=[];for(const p of structuredClone(state.openPositions)){try{const ticker=await getTicker(p.productId);results.push(closePosition(p.id,Number(ticker.price),reason));}catch(error){results.push({success:false,symbol:p.symbol,error:error.message});}}return results;}
  async function monitorOnce(){if(!state.running||monitoring||state.openPositions.length===0)return;monitoring=true;try{if(isEndOfDay()){await closeAllForReason("END OF DAY FLAT");return;}for(const snapshot of structuredClone(state.openPositions)){if(!state.running)break;try{const ticker=await getTicker(snapshot.productId),price=Number(ticker.price),bid=Number(ticker.bid),ask=Number(ticker.ask);if(!(price>0))continue;const mid=bid>0&&ask>0?(bid+ask)/2:0,spread=mid>0?(ask-bid)/mid*100:0;if(spread>MAX_EXIT_SPREAD_PERCENT){closePosition(snapshot.id,price,"LIQUIDITY SPREAD EXIT >0.6%");continue;}if(snapshot.strategyVersion===STRATEGY_VERSION)await monitorV5Position(snapshot,price);else await monitorLegacyPosition(snapshot,price);}catch(error){const next=structuredClone(state);next.lastError=error.message;commit(next);}}}finally{monitoring=false;}}
  function start(){if(scanTimer||monitorTimer)return;if(!state.running){const next=structuredClone(state);rotateDay(next);next.running=true;next.lastError=null;commit(next);}scanTimer=timers.setInterval(()=>void scanOnce(),SCAN_INTERVAL_MS);monitorTimer=timers.setInterval(()=>void monitorOnce(),MONITOR_INTERVAL_MS);void scanOnce();void monitorOnce();}
  function stop(){if(scanTimer)timers.clearInterval(scanTimer);if(monitorTimer)timers.clearInterval(monitorTimer);scanTimer=monitorTimer=null;if(!state.running)return;const next=structuredClone(state);next.running=false;commit(next);}
  async function closeAll(){const results=[];for(const p of structuredClone(state.openPositions)){try{const ticker=await getTicker(p.productId);results.push({...closePosition(p.id,Number(ticker.price),"MANUAL PAPER CLOSE"),symbol:p.symbol});}catch(error){results.push({success:false,symbol:p.symbol,error:error.message});}}return {success:results.every(r=>r.success),results};}
  function getStatus(){return {running:state.running,mode:"PAPER",exchange:"Coinbase Exchange public market data",lastScanAt:state.lastScanAt,lastError:state.lastError,openPositions:state.openPositions.length,maxOpenPositions:MAX_OPEN_POSITIONS,pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,dailyMoverUniverseSize:productCache.length,paperOnly:true,strategyVersion:STRATEGY_VERSION};}
  function getDashboardData(){
    const openIds=new Set(state.openPositions.map(p=>p.id)),groups=new Map();for(const row of state.history){if(row.type!=="SELL")continue;if(!groups.has(row.positionId))groups.set(row.positionId,{sells:[],buy:null});groups.get(row.positionId).sells.push(row);}for(const row of state.history)if(row.type==="BUY"&&groups.has(row.positionId))groups.get(row.positionId).buy=row;
    const completedTrades=[...groups.entries()].filter(([id])=>!openIds.has(id)).map(([id,g])=>{const sells=g.sells.slice().sort((a,b)=>Date.parse(a.exitTime||a.time)-Date.parse(b.exitTime||b.time)),buyRow=g.buy||{},qty=sells.reduce((s,x)=>s+Number(x.quantity||0),0),saleValue=sells.reduce((s,x)=>s+Number(x.saleValueUsd||x.amountUsd||0),0),pnl=sells.reduce((s,x)=>s+Number(x.pnlUsd||x.pnl||0),0),fees=sells.reduce((s,x)=>s+Number(x.estimatedFeesUsd||0),0),slip=sells.reduce((s,x)=>s+Number(x.estimatedSlippageUsd||0),0),invested=Number(buyRow.costBasisUsd)||sells.reduce((s,x)=>s+Number(x.amountInvested||0),0),lastSell=sells.at(-1)||{},avgExit=qty>0?sells.reduce((s,x)=>s+Number(x.exitPrice||0)*Number(x.quantity||0),0)/qty:Number(lastSell.exitPrice||0);return {positionId:id,symbol:lastSell.symbol||buyRow.symbol,tokenAddress:lastSell.productId||buyRow.productId,entryPrice:Number(buyRow.entryPrice)||Number(lastSell.entryPrice),exitPrice:avgExit,investedUsd:invested,amountInvested:invested,saleValueUsd:saleValue,pnlUsd:pnl,pnl,pnlPercent:invested>0?pnl/invested*100:0,returnPercent:invested>0?pnl/invested*100:0,entryTime:buyRow.entryTime||lastSell.entryTime,exitTime:lastSell.exitTime||lastSell.time,estimatedFeesUsd:fees,estimatedSlippageUsd:slip,costEstimateAvailable:true,netPnl:pnl,grossPnl:pnl+fees+slip,holdTimeMs:Math.max(0,Date.parse(lastSell.exitTime||lastSell.time)-Date.parse(buyRow.entryTime||lastSell.entryTime)),exitReason:sells.map(x=>x.reason).filter(Boolean).join(" | "),maxGainPercent:Math.max(...sells.map(x=>Number(x.maxGainPercent)||0),0),strategy:lastSell.strategy||buyRow.strategy};});
    const livePositions=state.openPositions.map(p=>{const mark=Number(p.markPriceUsd||p.marketEntryPrice||p.entryPrice),exitPrice=mark*(1-SLIPPAGE_RATE),value=Number(p.quantity)*exitPrice*(1-FEE_RATE),remaining=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd),realized=Number(p.realizedPnlUsd)||0,unrealized=value-remaining,pnl=realized+unrealized,initial=Number(p.initialCostBasisUsd)||Number(p.costBasisUsd);return {position:p,live:{priceUsd:mark,currentValue:value,pnl,pnlPercent:initial>0?pnl/initial*100:0,realizedPnlUsd:realized,unrealizedPnlUsd:unrealized,holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),exchangeUrl:"https://www.coinbase.com/advanced-trade/spot/"+p.productId},pnl};});
    const equity=state.cashUsd+livePositions.reduce((sum,row)=>sum+Number(row.live.currentValue||0),0),totalPnl=equity-state.startingBalanceUsd;
    return {label:"Coinbase Bot",paperOnly:true,mode:"PAPER",exchange:"Coinbase",strategyVersion:STRATEGY_VERSION,strategy:"Paper-only sustained-momentum rotation. Liquid Coinbase USD/USDC pairs; 15m/1h trend, >=1.5x relative volume, VWAP, EMA9>EMA21, continuation/retest/reclaim, spike rejection and BTC/news/spread guards. Max 6 positions but no forced fills. Exit 50% at +3%, 30% at +5%, trail 20% by 2%; ATR stop 1.5%-2.5%; momentum-decay exit after 10-15m; 25m stale-trade exit; 30m coin cooldown.",startingBalance:state.startingBalanceUsd,startingBalanceUsd:state.startingBalanceUsd,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:state.startingBalanceUsd>0?totalPnl/state.startingBalanceUsd*100:0,nextTradeSizeUsd:state.nextEntryUsd,compoundIncrementPercent:COMPOUND_RATE*100,positionEquityFractionMin:MIN_POSITION_EQUITY_FRACTION,positionEquityFractionMax:MAX_POSITION_EQUITY_FRACTION,dailyLossLimitUsd:dailyLossLimitUsd(state),maxOpenPositions:MAX_OPEN_POSITIONS,estimatedFeePercentPerSide:FEE_RATE*100,estimatedSlippagePercentPerSide:SLIPPAGE_RATE*100,completedTrades,history:state.history,livePositions,openPositions:livePositions,rejections:state.rejections.slice(0,30),lastScanAt:state.lastScanAt,lastError:state.lastError,running:state.running,pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,candidates:lastMarketScan.slice(0,15),news:news.getState(),dailyMoverUniverseSize:productCache.length};
  }
  return {start,stop,scanOnce,monitorOnce,buy,closePosition,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state),assessCandidate,file};
}
const instance=createOutcomeBot();
module.exports={createOutcomeBot,assessCandidate:(...a)=>instance.assessCandidate(...a),PRODUCTS,constants:{MAX_OPEN_POSITIONS,START_SIZE_USD,COMPOUND_RATE,HARD_STOP_PERCENT,TP1_PERCENT,TP2_PERCENT,TP1_SELL_FRACTION,TP2_SELL_FRACTION,RUNNER_FRACTION,RUNNER_TRAIL_PERCENT,MAX_HOLD_MS,DAILY_LOSS_FRACTION,MIN_POSITION_EQUITY_FRACTION,MAX_POSITION_EQUITY_FRACTION,MIN_DAILY_GAIN_PERCENT,MAX_DAILY_GAIN_PERCENT,MIN_DAILY_VOLUME_USD,MIN_RELATIVE_VOLUME_15M,MIN_MOMENTUM_SCORE,MAX_SCAN_PRODUCTS,FEE_RATE,SLIPPAGE_RATE},...instance};