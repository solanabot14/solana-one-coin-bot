"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createCoinbaseNews } = require("./coinbaseNews");

const STARTING_BALANCE_USD = 200;
const MAX_OPEN_POSITIONS = 6;
const START_SIZE_USD = 10;
const MAX_SIZE_USD = 25;
const COMPOUND_RATE = 0.10;
const HARD_STOP_PERCENT = 7.5;
const TP1_PERCENT = 10;
const TP2_PERCENT = 20;
const TP1_SELL_FRACTION = 0.40;
const TP2_SELL_FRACTION = 0.40;
const RUNNER_TRAIL_PERCENT = 10;
const MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const LEGACY_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DAILY_LOSS_LIMIT_USD = 20;
const MIN_DAILY_GAIN_PERCENT = 8;
const MAX_DAILY_GAIN_PERCENT = 120;
const MIN_DAILY_VOLUME_USD = 500_000;
const MAX_SCAN_PRODUCTS = 180;
const MAX_MOVER_CANDLES = 30;
const PRODUCT_CACHE_MS = 15 * 60 * 1000;
const MAX_SPREAD_PERCENT = 1.5;
const FEE_RATE = Math.min(0.01, Math.max(0, Number(process.env.OUTCOME_PAPER_FEE_RATE ?? 0.006)));
const SLIPPAGE_RATE = Math.min(0.005, Math.max(0, Number(process.env.OUTCOME_PAPER_SLIPPAGE_RATE ?? 0.001)));
const SCAN_INTERVAL_MS = 90_000;
const MONITOR_INTERVAL_MS = 5_000;
const PRODUCTS = ["ETH-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","LINK-USD","AVAX-USD","DOT-USD","LTC-USD","BCH-USD","UNI-USD","XLM-USD"];
const BASE_URL = "https://api.exchange.coinbase.com";
const STRATEGY_VERSION = "COINBASE_TOP_GAINER_V2";

function defaultFile() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "outcome-paper-state.json");
}
function freshState() {
  return {
    schemaVersion: 1, startingBalanceUsd: STARTING_BALANCE_USD, cashUsd: STARTING_BALANCE_USD,
    openPositions: [], history: [], rejections: [], lastScanAt: null, lastError: null,
    running: false, nextEntryUsd: START_SIZE_USD, dailyPnlUsd: 0,
    dailyPnlDate: new Date().toISOString().slice(0, 10), pausedForDailyLoss: false
  };
}
function validateState(s) {
  if (!s || s.schemaVersion !== 1 || !Number.isFinite(s.cashUsd) || !Array.isArray(s.openPositions) ||
      !Array.isArray(s.history) || !Array.isArray(s.rejections) || s.openPositions.length > MAX_OPEN_POSITIONS ||
      !Number.isFinite(s.nextEntryUsd)) throw new Error("Invalid Coinbase Bot paper state; refusing to reset it.");
  return s;
}
function createOutcomeBot({ file = defaultFile(), io = fs, fetchImpl = globalThis.fetch, timers = globalThis, now = () => Date.now(), newsProvider = null } = {}) {
  let state = freshState();
  if (io.existsSync(file)) state = validateState(JSON.parse(io.readFileSync(file, "utf8")));
  let scanTimer = null, monitorTimer = null, scanning = false, monitoring = false;
  let lastMarketScan = [];
  let productCache = [], productCacheAt = 0;
  const news = newsProvider || createCoinbaseNews({ fetchImpl, now });

  function commit(next) {
    validateState(next);
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      io.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: "wx", flush: true });
      io.renameSync(tmp, file);
    } finally { if (io.existsSync(tmp)) io.unlinkSync(tmp); }
    state = next;
  }
  function rotateDay(next) {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (next.dailyPnlDate !== today) {
      next.dailyPnlDate = today; next.dailyPnlUsd = 0; next.pausedForDailyLoss = false;
    }
  }
  async function requestJson(url, signal) {
    const response = await fetchImpl(url, { signal: signal || AbortSignal.timeout(8000), headers: { "Accept": "application/json", "User-Agent": "CoinbaseTopGainerBot-Paper/2.0" } });
    if (!response.ok) throw new Error("Coinbase market data HTTP " + response.status);
    return response.json();
  }
  async function getStats(productId, signal) { return requestJson(BASE_URL + "/products/" + encodeURIComponent(productId) + "/stats", signal); }
  async function getTicker(productId, signal) { return requestJson(BASE_URL + "/products/" + encodeURIComponent(productId) + "/ticker", signal); }
  async function getCandles(productId, signal) {
    const data = await requestJson(BASE_URL + "/products/" + encodeURIComponent(productId) + "/candles?granularity=300", signal);
    return Array.isArray(data) ? data.map(row => ({ time:Number(row[0]), low:Number(row[1]), high:Number(row[2]), open:Number(row[3]), close:Number(row[4]), volume:Number(row[5]) })).filter(c => c.time && c.close > 0).sort((a,b) => a.time-b.time) : [];
  }
  function flattenRows(value) {
    if (Array.isArray(value)) return value.flatMap(flattenRows);
    return value && typeof value === "object" ? [value] : [];
  }
  async function getScanProducts() {
    if (productCache.length && now() - productCacheAt < PRODUCT_CACHE_MS) return productCache.slice();
    const [products, volumeSummary] = await Promise.all([
      requestJson(BASE_URL + "/products"), requestJson(BASE_URL + "/products/volume-summary")
    ]);
    const volumeById = new Map(flattenRows(volumeSummary)
      .filter(row => row.quote_currency === "USD" && Array.isArray(row.market_types) && row.market_types.includes("spot"))
      .map(row => [row.id, Number(row.spot_volume_24hour) || 0]));
    const stable = new Set(["USDC","USDT","DAI","PYUSD","GUSD","USDP","USDS"]);
    const eligible = (Array.isArray(products) ? products : []).filter(product =>
      product && product.id && product.quote_currency === "USD" && product.status === "online" &&
      !product.trading_disabled && !product.cancel_only && !product.post_only && !product.limit_only &&
      !product.auction_mode && !product.fx_stablecoin && !stable.has(product.base_currency) &&
      (volumeById.get(product.id) || 0) >= MIN_DAILY_VOLUME_USD)
      .sort((a,b) => (volumeById.get(b.id)||0) - (volumeById.get(a.id)||0))
      .slice(0, MAX_SCAN_PRODUCTS).map(product => product.id);
    if (!eligible.length) throw new Error("Coinbase returned no active liquid USD spot products for the top-gainer scan");
    productCache = eligible; productCacheAt = now(); return eligible.slice();
  }
  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length); let next = 0;
    async function run() { while (true) { const index = next++; if (index >= items.length) return; output[index] = await worker(items[index], index); } }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},run)); return output;
  }
  function assessCandidate(productId, stats, candles, at = now()) {
    const last = Number(stats.last), open = Number(stats.open), baseVolume = Number(stats.volume);
    const volumeUsd = last * baseVolume;
    const dayChange = open > 0 ? (last / open - 1) * 100 : 0;
    const lastClosedBucket = Math.floor(at / 300_000) * 300;
    const recent = candles.filter(candle => Number(candle.time) < lastClosedBucket).slice(-13);
    const current = recent[recent.length - 1], previous = recent[recent.length - 2], hourAnchor = recent[0];
    const hourChange = hourAnchor && hourAnchor.close > 0 ? (last / hourAnchor.close - 1) * 100 : 0;
    const fiveMinChange = current && current.open > 0 ? (current.close / current.open - 1) * 100 : 0;
    const priorBars = recent.slice(-7,-1);
    const priorHigh = priorBars.length ? Math.max(...priorBars.map(c => c.high)) : 0;
    const pullbackBars = recent.slice(-5,-1);
    const pullbackLow = pullbackBars.length ? Math.min(...pullbackBars.map(c => c.low)) : 0;
    const pullbackPercent = priorHigh > 0 ? (priorHigh-pullbackLow)/priorHigh*100 : 0;
    const recentHigh = recent.length ? Math.max(...recent.map(c => c.high)) : 0;
    const offHighPercent = recentHigh > 0 ? (recentHigh-last)/recentHigh*100 : 0;
    const baselineVolumes = recent.slice(-6,-1).map(c => Number(c.volume)||0).sort((a,b)=>a-b);
    const medianVolume = baselineVolumes.length ? baselineVolumes[Math.floor(baselineVolumes.length/2)] : 0;
    const volumeRatio = current && medianVolume > 0 ? current.volume / medianVolume : 0;
    const reclaim = !!(current && previous && current.close > previous.high && current.close > current.open);
    const pullbackSetup = recent.length >= 13 && pullbackPercent >= 1.0 && pullbackPercent <= 10 && reclaim && fiveMinChange >= 0 && fiveMinChange <= 5 && volumeRatio >= 1.0;
    const breakoutSetup = recent.length >= 13 && current && priorHigh > 0 && current.close > priorHigh && current.close > current.open && fiveMinChange >= 0.25 && fiveMinChange <= 6 && volumeRatio >= 1.35;
    const highFlyerRequiresPullback = dayChange > 80;
    const setup = pullbackSetup ? "PULLBACK_RECLAIM" : (!highFlyerRequiresPullback && breakoutSetup ? "VOLUME_BREAKOUT" : null);
    const reasons = [];
    if (!(last > 0 && open > 0)) reasons.push("Price unavailable");
    if (!Number.isFinite(volumeUsd) || volumeUsd < MIN_DAILY_VOLUME_USD) reasons.push("24h USD volume below $500K");
    if (dayChange < MIN_DAILY_GAIN_PERCENT) reasons.push("24h gain below top-gainer zone (+8%)");
    if (dayChange > MAX_DAILY_GAIN_PERCENT) reasons.push("24h gain above +120% chase limit");
    if (hourChange < 0.25 || hourChange > 35) reasons.push("1h momentum is weak or blow-off extended");
    if (recent.length < 13) reasons.push("Not enough closed 5m candles");
    if (offHighPercent > 10) reasons.push("Price is reversing too far from its recent high");
    if (!setup) reasons.push(highFlyerRequiresPullback ? "80%+ gainer must pull back and reclaim before entry" : "Waiting for pullback/reclaim or volume breakout");
    const accepted = reasons.length === 0;
    const score = accepted ? dayChange*3 + hourChange*1.5 + Math.log10(Math.max(volumeUsd,1))*2 + Math.min(volumeRatio,3)*3 + (setup === "PULLBACK_RECLAIM" ? 4 : 2) : 0;
    return { accepted, reasons, candidate:{ productId, symbol:productId.split("-")[0], priceUsd:last, volumeUsd,
      dayChangePercent:dayChange, hourChangePercent:hourChange, fiveMinChangePercent:fiveMinChange, pullbackPercent,
      pullbackLow, volumeRatio, offHighPercent, entrySetup:setup, riskPercent:HARD_STOP_PERCENT, score, candles:recent } };
  }
  function recordRejections(rows) {
    if (!rows.length) return;
    const next = structuredClone(state);
    next.rejections.unshift(...rows.map(row => ({ time:new Date(now()).toISOString(), productId:row.productId,
      symbol:String(row.productId||"").split("-")[0], reason:row.reasons.join("; "), metrics:row.metrics||{} })));
    next.rejections = next.rejections.slice(0,150); commit(next);
  }
  function buy(candidate) {
    const next = structuredClone(state); rotateDay(next);
    if (!next.running) return {success:false,error:"Coinbase Bot is stopped"};
    if (next.pausedForDailyLoss) return {success:false,error:"Daily loss limit reached"};
    if (next.openPositions.length >= MAX_OPEN_POSITIONS) return {success:false,error:"Six position limit reached"};
    if (next.openPositions.some(p=>p.productId===candidate.productId)) return {success:false,error:"Coin already has an open position"};
    if (candidate.newsRisk) return {success:false,error:"Recent risk headline: "+candidate.newsRisk.title};
    const notional = Math.min(next.nextEntryUsd,MAX_SIZE_USD,next.cashUsd/(1+FEE_RATE));
    if (!(candidate.priceUsd>0) || notional<1) return {success:false,error:"Insufficient paper cash or invalid quote"};
    const entryPrice = candidate.priceUsd*(1+SLIPPAGE_RATE), quantity=notional/entryPrice, fee=notional*FEE_RATE;
    const costBasisUsd=notional+fee;
    const pos={ id:randomUUID(),productId:candidate.productId,tokenAddress:candidate.productId,symbol:candidate.symbol,
      entryPrice,marketEntryPrice:candidate.priceUsd,highestPrice:candidate.priceUsd,quantity,originalQuantity:quantity,
      notionalUsd:notional,costBasisUsd,initialCostBasisUsd:costBasisUsd,remainingCostBasisUsd:costBasisUsd,entryFeeUsd:fee,
      realizedPnlUsd:0,entryTime:new Date(now()).toISOString(),strategyVersion:STRATEGY_VERSION,
      hardStopPercent:HARD_STOP_PERCENT,stopPriceUsd:entryPrice*(1-HARD_STOP_PERCENT/100),tp1Done:false,tp2Done:false,
      runnerTrailActive:false,markPriceUsd:candidate.priceUsd,
      strategy:"Coinbase Bot · daily top gainers · pullback/reclaim or volume breakout · 40% at +10% · 40% at +20% · final 20% trails 10% · hard stop -7.5% · 24h max",
      entryMetrics:{dayChangePercent:candidate.dayChangePercent,hourChangePercent:candidate.hourChangePercent,fiveMinChangePercent:candidate.fiveMinChangePercent,
        pullbackPercent:candidate.pullbackPercent,volumeRatio:candidate.volumeRatio,volumeUsd:candidate.volumeUsd,score:candidate.score,entrySetup:candidate.entrySetup} };
    next.cashUsd -= costBasisUsd; next.openPositions.push(pos);
    next.history.unshift({type:"BUY",positionId:pos.id,productId:pos.productId,tokenAddress:pos.productId,symbol:pos.symbol,
      entryPrice:pos.entryPrice,quantity:pos.quantity,amountUsd:notional,feeUsd:fee,costBasisUsd:pos.costBasisUsd,time:pos.entryTime,
      entryTime:pos.entryTime,mode:"PAPER",strategy:pos.strategy,entryReason:"Coinbase daily top gainer; "+(candidate.entrySetup||"momentum confirmation")});
    commit(next); return {success:true,position:structuredClone(pos)};
  }
  function sellQuantity(positionId, markPrice, requestedQuantity, reason, patch={}) {
    const next=structuredClone(state); rotateDay(next);
    const index=next.openPositions.findIndex(p=>p.id===positionId); if(index<0)return {success:false,error:"Position not found"};
    const p=next.openPositions[index], price=Number(markPrice); if(!(price>0))return {success:false,error:"Invalid exit quote"};
    const quantityBefore=Number(p.quantity)||0, qty=Math.min(quantityBefore,Math.max(0,Number(requestedQuantity)||0));
    if(!(qty>0))return {success:false,error:"Invalid sell quantity"};
    const remainingCost=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd)||0;
    const originalQty=Number(p.originalQuantity)||quantityBefore;
    const allocatedCost=quantityBefore>0?remainingCost*(qty/quantityBefore):remainingCost;
    const exitPrice=price*(1-SLIPPAGE_RATE),grossValue=qty*exitPrice,fee=grossValue*FEE_RATE,proceeds=grossValue-fee,pnlUsd=proceeds-allocatedCost;
    const time=new Date(now()).toISOString();
    const allocatedEntryFee=(Number(p.entryFeeUsd)||0)*(qty/originalQty);
    const remainingQty=Math.max(0,quantityBefore-qty);
    const final=remainingQty<=Math.max(1e-12,originalQty*1e-8);
    next.cashUsd += proceeds; next.dailyPnlUsd += pnlUsd;
    const totalRealized=(Number(p.realizedPnlUsd)||0)+pnlUsd;
    next.history.unshift({type:"SELL",id:randomUUID(),positionId:p.id,productId:p.productId,tokenAddress:p.productId,symbol:p.symbol,
      entryPrice:p.entryPrice,exitPrice,quantity:qty,amountUsd:proceeds,saleValueUsd:proceeds,costBasisUsd:allocatedCost,amountInvested:allocatedCost,
      pnl:pnlUsd,pnlUsd,pnlPercent:allocatedCost>0?pnlUsd/allocatedCost*100:0,estimatedFeesUsd:allocatedEntryFee+fee,
      estimatedSlippageUsd:(p.notionalUsd||0)*SLIPPAGE_RATE*(qty/originalQty)+grossValue*SLIPPAGE_RATE,time,entryTime:p.entryTime,exitTime:time,
      holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),maxGainPercent:p.entryPrice>0?(Number(p.highestPrice||price)/p.entryPrice-1)*100:0,
      reason,exitReason:reason,partial:!final,mode:"PAPER",strategy:p.strategy});
    if(final){
      next.openPositions.splice(index,1);
      if(totalRealized>0)next.nextEntryUsd=Math.min(MAX_SIZE_USD,Math.round(next.nextEntryUsd*(1+COMPOUND_RATE)*100)/100); else next.nextEntryUsd=START_SIZE_USD;
    } else {
      p.quantity=remainingQty;p.remainingCostBasisUsd=Math.max(0,remainingCost-allocatedCost);p.costBasisUsd=p.remainingCostBasisUsd;p.realizedPnlUsd=totalRealized;
      Object.assign(p,patch);
      next.openPositions[index]=p;
    }
    if(next.dailyPnlUsd<=-DAILY_LOSS_LIMIT_USD)next.pausedForDailyLoss=true;
    commit(next); return {success:true,trade:structuredClone(next.history[0]),final};
  }
  function closePosition(positionId, markPrice, reason) {
    const p=state.openPositions.find(x=>x.id===positionId); if(!p)return {success:false,error:"Position not found"};
    return sellQuantity(positionId,markPrice,p.quantity,reason);
  }
  async function scanOnce() {
    if(!state.running||scanning||state.openPositions.length>=MAX_OPEN_POSITIONS||state.pausedForDailyLoss)return;
    scanning=true;
    try {
      const rejectionRows=[];let products;
      try{products=await getScanProducts();}catch(error){products=PRODUCTS.slice();rejectionRows.push({productId:"COINBASE-USD-UNIVERSE",reasons:[error.message]});}
      await news.refresh();
      const marketRows=await mapLimit(products.filter(id=>!state.openPositions.some(p=>p.productId===id)),4,async productId=>{
        try{const stats=await getStats(productId);const last=Number(stats.last),open=Number(stats.open),volumeUsd=last*Number(stats.volume),dayChange=open>0?(last/open-1)*100:0;
          if(!(last>0&&open>0)||!Number.isFinite(volumeUsd)||dayChange<MIN_DAILY_GAIN_PERCENT||dayChange>MAX_DAILY_GAIN_PERCENT||volumeUsd<MIN_DAILY_VOLUME_USD)return null;
          return {productId,stats,last,dayChange,volumeUsd};}catch(error){rejectionRows.push({productId,reasons:[error.message]});return null;}
      });
      const topMovers=marketRows.filter(Boolean).sort((a,b)=>b.dayChange-a.dayChange).slice(0,MAX_MOVER_CANDLES);
      const evaluated=await mapLimit(topMovers,4,async row=>{try{return assessCandidate(row.productId,row.stats,await getCandles(row.productId));}
        catch(error){rejectionRows.push({productId:row.productId,reasons:[error.message],metrics:{dayChangePercent:row.dayChange,volumeUsd:row.volumeUsd}});return null;}});
      const ranked=evaluated.filter(Boolean).map(result=>{if(!result.accepted)rejectionRows.push({productId:result.candidate.productId,reasons:result.reasons,metrics:result.candidate});return result;});
      lastMarketScan=ranked.map(result=>({...result.candidate,accepted:result.accepted,reasons:result.reasons}));
      for(const candidate of ranked.filter(r=>r.accepted).map(r=>r.candidate).sort((a,b)=>b.score-a.score)){
        if(!state.running||state.openPositions.length>=MAX_OPEN_POSITIONS||state.pausedForDailyLoss)break;
        const risk=news.riskForProduct(candidate.productId);if(risk){rejectionRows.push({productId:candidate.productId,reasons:["News risk flag: "+risk.term],metrics:{headline:risk.title,source:risk.source,publishedAt:risk.publishedAt}});continue;}
        try{const ticker=await getTicker(candidate.productId);const bid=Number(ticker.bid),ask=Number(ticker.ask),price=Number(ticker.price)||candidate.priceUsd;
          const mid=bid>0&&ask>0?(bid+ask)/2:0,spread=mid>0?(ask-bid)/mid*100:0;
          if(spread>MAX_SPREAD_PERCENT){rejectionRows.push({productId:candidate.productId,reasons:["Bid/ask spread above 1.5%"],metrics:{spreadPercent:spread}});continue;}
          candidate.priceUsd=price;candidate.spreadPercent=spread;buy(candidate);
        }catch(error){rejectionRows.push({productId:candidate.productId,reasons:["Pre-entry quote failed: "+error.message]});}
      }
      recordRejections(rejectionRows.slice(0,80));
      const next=structuredClone(state);next.lastScanAt=new Date(now()).toISOString();next.lastError=null;commit(next);
    }catch(error){const next=structuredClone(state);next.lastError=error.message;commit(next);}finally{scanning=false;}
  }
  async function monitorLegacyPosition(snapshot,price){
    const current=state.openPositions.find(p=>p.id===snapshot.id);if(!current)return;
    const next=structuredClone(state),p=next.openPositions.find(x=>x.id===snapshot.id);p.markPriceUsd=price;if(price>p.highestPrice)p.highestPrice=price;
    const age=now()-Date.parse(p.entryTime),pnlPercent=(price/p.entryPrice-1)*100;
    if(!Number.isFinite(Number(p.riskPercent))){commit(next);if(pnlPercent<=-3)closePosition(p.id,price,"LEGACY HARD STOP -3%");else if(pnlPercent>=5)closePosition(p.id,price,"LEGACY TAKE PROFIT +5%");else if(age>=LEGACY_MAX_HOLD_MS)closePosition(p.id,price,"LEGACY TIME EXIT 24H");return;}
    const riskPercent=Number(p.riskPercent)||3;const trailPct=2.5;
    if(pnlPercent>=riskPercent)p.stopPriceUsd=Math.max(Number(p.stopPriceUsd)||0,Number(p.breakEvenPriceUsd)||p.entryPrice);
    if(pnlPercent>=Number(p.trailActivationPercent||Math.max(3,riskPercent*1.5)))p.stopPriceUsd=Math.max(Number(p.stopPriceUsd)||0,p.highestPrice*(1-trailPct/100));
    const stopPrice=Number(p.stopPriceUsd)||Number(p.initialStopPriceUsd)||p.entryPrice*(1-riskPercent/100);commit(next);
    if(price<=stopPrice)closePosition(p.id,price,Number(p.breakEvenPriceUsd)>0&&stopPrice>=Number(p.breakEvenPriceUsd)?"LEGACY BREAKEVEN/TRAIL STOP":"LEGACY PULLBACK HARD STOP");
    else if(age>=4*60*60*1000)closePosition(p.id,price,"LEGACY TIME EXIT 4H");
  }
  async function monitorV2Position(snapshot,price){
    let current=state.openPositions.find(p=>p.id===snapshot.id);if(!current)return;
    let next=structuredClone(state),p=next.openPositions.find(x=>x.id===snapshot.id);
    p.originalQuantity=Number(p.originalQuantity)||Number(p.quantity);p.initialCostBasisUsd=Number(p.initialCostBasisUsd)||Number(p.costBasisUsd);
    p.remainingCostBasisUsd=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd);
    p.realizedPnlUsd=Number(p.realizedPnlUsd)||0;p.markPriceUsd=price;if(price>Number(p.highestPrice||0))p.highestPrice=price;commit(next);
    const pnlPercent=(price/p.entryPrice-1)*100;
    if(pnlPercent<=-HARD_STOP_PERCENT){closePosition(p.id,price,"HARD STOP -7.5%");return;}
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    if(!current.tp1Done&&pnlPercent>=TP1_PERCENT){
      sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP1_SELL_FRACTION,"TAKE PROFIT +10% (40%)",{tp1Done:true,stopPriceUsd:current.entryPrice});
    }
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    if(!current.tp2Done&&pnlPercent>=TP2_PERCENT){
      sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP2_SELL_FRACTION,"TAKE PROFIT +20% (40%)",{tp1Done:true,tp2Done:true,runnerTrailActive:true,stopPriceUsd:current.entryPrice});
    }
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    next=structuredClone(state);p=next.openPositions.find(x=>x.id===snapshot.id);p.markPriceUsd=price;if(price>Number(p.highestPrice||0))p.highestPrice=price;
    let stop=p.entryPrice*(1-HARD_STOP_PERCENT/100);if(p.tp1Done)stop=Math.max(stop,p.entryPrice);if(p.tp2Done||p.runnerTrailActive)stop=Math.max(stop,p.highestPrice*(1-RUNNER_TRAIL_PERCENT/100));p.stopPriceUsd=stop;commit(next);
    if(price<=stop){closePosition(p.id,price,p.tp2Done?"RUNNER TRAILING STOP 10%":"BREAKEVEN STOP");return;}
    if(now()-Date.parse(p.entryTime)>=MAX_HOLD_MS)closePosition(p.id,price,"TIME EXIT 24H");
  }
  async function monitorOnce() {
    if(!state.running||monitoring||state.openPositions.length===0)return;monitoring=true;
    try{for(const snapshot of structuredClone(state.openPositions)){if(!state.running)break;try{const ticker=await getTicker(snapshot.productId),price=Number(ticker.price);if(!(price>0))continue;
      if(snapshot.strategyVersion===STRATEGY_VERSION)await monitorV2Position(snapshot,price);else await monitorLegacyPosition(snapshot,price);
    }catch(error){const next=structuredClone(state);next.lastError=error.message;commit(next);}}}finally{monitoring=false;}
  }
  function start() {
    if(scanTimer||monitorTimer)return;if(!state.running){const next=structuredClone(state);rotateDay(next);next.running=true;next.lastError=null;commit(next);} 
    scanTimer=timers.setInterval(()=>void scanOnce(),SCAN_INTERVAL_MS);monitorTimer=timers.setInterval(()=>void monitorOnce(),MONITOR_INTERVAL_MS);void scanOnce();void monitorOnce();
  }
  function stop() { if(scanTimer)timers.clearInterval(scanTimer);if(monitorTimer)timers.clearInterval(monitorTimer);scanTimer=monitorTimer=null;if(!state.running)return;const next=structuredClone(state);next.running=false;commit(next); }
  async function closeAll(){const results=[];for(const position of structuredClone(state.openPositions)){try{const ticker=await getTicker(position.productId);results.push({...closePosition(position.id,Number(ticker.price),"MANUAL PAPER CLOSE"),symbol:position.symbol});}catch(error){results.push({success:false,symbol:position.symbol,error:error.message});}}return {success:results.every(r=>r.success),results};}
  function getStatus(){return {running:state.running,mode:"PAPER",exchange:"Coinbase Exchange public market data",lastScanAt:state.lastScanAt,lastError:state.lastError,openPositions:state.openPositions.length,maxOpenPositions:MAX_OPEN_POSITIONS,pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,dailyMoverUniverseSize:productCache.length,paperOnly:true,strategyVersion:STRATEGY_VERSION};}
  function getDashboardData(){
    const openIds=new Set(state.openPositions.map(p=>p.id)),groups=new Map();
    for(const row of state.history){if(row.type!=="SELL")continue;if(!groups.has(row.positionId))groups.set(row.positionId,{sells:[],buy:null});groups.get(row.positionId).sells.push(row);}
    for(const row of state.history)if(row.type==="BUY"&&groups.has(row.positionId))groups.get(row.positionId).buy=row;
    const completedTrades=[...groups.entries()].filter(([id])=>!openIds.has(id)).map(([id,g])=>{const sells=g.sells.slice().sort((a,b)=>Date.parse(a.exitTime||a.time)-Date.parse(b.exitTime||b.time)),buyRow=g.buy||{},qty=sells.reduce((s,x)=>s+Number(x.quantity||0),0),saleValue=sells.reduce((s,x)=>s+Number(x.saleValueUsd||x.amountUsd||0),0),pnl=sells.reduce((s,x)=>s+Number(x.pnlUsd||x.pnl||0),0),fees=sells.reduce((s,x)=>s+Number(x.estimatedFeesUsd||0),0),slip=sells.reduce((s,x)=>s+Number(x.estimatedSlippageUsd||0),0),invested=Number(buyRow.costBasisUsd)||sells.reduce((s,x)=>s+Number(x.amountInvested||0),0),lastSell=sells[sells.length-1]||{};
      const avgExit=qty>0?sells.reduce((s,x)=>s+Number(x.exitPrice||0)*Number(x.quantity||0),0)/qty:Number(lastSell.exitPrice||0);
      return {positionId:id,symbol:lastSell.symbol||buyRow.symbol,tokenAddress:lastSell.productId||buyRow.productId,entryPrice:Number(buyRow.entryPrice)||Number(lastSell.entryPrice),exitPrice:avgExit,investedUsd:invested,amountInvested:invested,saleValueUsd:saleValue,pnlUsd:pnl,pnl, pnlPercent:invested>0?pnl/invested*100:0,returnPercent:invested>0?pnl/invested*100:0,entryTime:buyRow.entryTime||lastSell.entryTime,exitTime:lastSell.exitTime||lastSell.time,estimatedFeesUsd:fees,estimatedSlippageUsd:slip,costEstimateAvailable:true,netPnl:pnl,grossPnl:pnl+fees+slip,holdTimeMs:Math.max(0,Date.parse(lastSell.exitTime||lastSell.time)-Date.parse(buyRow.entryTime||lastSell.entryTime)),exitReason:sells.map(x=>x.reason).filter(Boolean).join(" | "),maxGainPercent:Math.max(...sells.map(x=>Number(x.maxGainPercent)||0),0),strategy:lastSell.strategy||buyRow.strategy};});
    const livePositions=state.openPositions.map(p=>{const mark=Number(p.markPriceUsd||p.marketEntryPrice||p.entryPrice),exitPrice=mark*(1-SLIPPAGE_RATE),value=Number(p.quantity)*exitPrice*(1-FEE_RATE),remaining=Number.isFinite(Number(p.remainingCostBasisUsd))?Number(p.remainingCostBasisUsd):Number(p.costBasisUsd),realized=Number(p.realizedPnlUsd)||0,unrealized=value-remaining,pnl=realized+unrealized,initial=Number(p.initialCostBasisUsd)||Number(p.costBasisUsd);
      return {position:p,live:{priceUsd:mark,currentValue:value,pnl,pnlPercent:initial>0?pnl/initial*100:0,realizedPnlUsd:realized,unrealizedPnlUsd:unrealized,holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),exchangeUrl:"https://www.coinbase.com/advanced-trade/spot/"+p.productId},pnl};});
    const equity=state.cashUsd+livePositions.reduce((sum,row)=>sum+Number(row.live.currentValue||0),0),totalPnl=equity-state.startingBalanceUsd;
    return {label:"Coinbase Bot",paperOnly:true,mode:"PAPER",exchange:"Coinbase",strategyVersion:STRATEGY_VERSION,
      strategy:"Daily Coinbase top gainers (+8% to +120%) ranked by momentum and volume. Enter only on a 5m pullback/reclaim or confirmed volume breakout; 80%+ movers require a pullback/reclaim. Reject weak/reversing momentum, wide spreads and risk news. Exit 40% at +10%, 40% at +20%, trail the final 20% by 10%; hard stop -7.5%; 24h max hold. Paper only.",
      startingBalance:state.startingBalanceUsd,startingBalanceUsd:state.startingBalanceUsd,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:state.startingBalanceUsd>0?totalPnl/state.startingBalanceUsd*100:0,nextTradeSizeUsd:state.nextEntryUsd,compoundIncrementPercent:COMPOUND_RATE*100,maxOpenPositions:MAX_OPEN_POSITIONS,estimatedFeePercentPerSide:FEE_RATE*100,estimatedSlippagePercentPerSide:SLIPPAGE_RATE*100,completedTrades,history:state.history,livePositions,openPositions:livePositions,rejections:state.rejections.slice(0,30),lastScanAt:state.lastScanAt,lastError:state.lastError,running:state.running,pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,candidates:lastMarketScan.slice(0,15),news:news.getState(),dailyMoverUniverseSize:productCache.length};
  }
  return {start,stop,scanOnce,monitorOnce,buy,closePosition,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state),assessCandidate,file};
}
const instance=createOutcomeBot();
module.exports={createOutcomeBot,assessCandidate:(...a)=>instance.assessCandidate(...a),PRODUCTS,constants:{MAX_OPEN_POSITIONS,START_SIZE_USD,MAX_SIZE_USD,COMPOUND_RATE,HARD_STOP_PERCENT,TP1_PERCENT,TP2_PERCENT,RUNNER_TRAIL_PERCENT,MAX_HOLD_MS,DAILY_LOSS_LIMIT_USD,MIN_DAILY_GAIN_PERCENT,MAX_DAILY_GAIN_PERCENT,MIN_DAILY_VOLUME_USD,MAX_SCAN_PRODUCTS,FEE_RATE,SLIPPAGE_RATE},...instance};
