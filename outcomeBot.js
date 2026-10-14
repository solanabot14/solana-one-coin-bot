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
const TRAIL_FROM_PEAK_PERCENT = 2.5;
const MAX_HOLD_MS = 4 * 60 * 60 * 1000;
const LEGACY_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DAILY_LOSS_LIMIT_USD = 20;
const MIN_DAILY_VOLUME_USD = 2_000_000;
const MAX_SCAN_PRODUCTS = 60;
const MAX_MOVER_CANDLES = 18;
const PRODUCT_CACHE_MS = 15 * 60 * 1000;
const FEE_RATE = Math.min(0.01, Math.max(0, Number(process.env.OUTCOME_PAPER_FEE_RATE ?? 0.006)));
const SLIPPAGE_RATE = Math.min(0.005, Math.max(0, Number(process.env.OUTCOME_PAPER_SLIPPAGE_RATE ?? 0.001)));
const SCAN_INTERVAL_MS = 60_000;
const MONITOR_INTERVAL_MS = 5_000;
const PRODUCTS = ["ETH-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","LINK-USD","AVAX-USD","DOT-USD","LTC-USD","BCH-USD","UNI-USD","XLM-USD"];
const BASE_URL = "https://api.exchange.coinbase.com";

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
    const response = await fetchImpl(url, { signal:signal || AbortSignal.timeout(8000), headers: { "Accept": "application/json", "User-Agent": "OutcomeBot-Paper/1.0" } });
    if (!response.ok) throw new Error("Coinbase market data HTTP " + response.status);
    return response.json();
  }
  async function getStats(productId, signal) {
    return requestJson(BASE_URL + "/products/" + encodeURIComponent(productId) + "/stats", signal);
  }
  async function getTicker(productId, signal) {
    return requestJson(BASE_URL + "/products/" + encodeURIComponent(productId) + "/ticker", signal);
  }
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
      !product.auction_mode && !product.fx_stablecoin && !stable.has(product.base_currency) && volumeById.has(product.id))
      .sort((a,b) => (volumeById.get(b.id)||0) - (volumeById.get(a.id)||0))
      .slice(0, MAX_SCAN_PRODUCTS).map(product => product.id);
    if (!eligible.length) throw new Error("Coinbase returned no active USD spot products for the mover scan");
    productCache = eligible;
    productCacheAt = now();
    return eligible.slice();
  }
  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let next = 0;
    async function run() {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        output[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
    return output;
  }
  function assessCandidate(productId, stats, candles, at = now()) {
    const last = Number(stats.last), open = Number(stats.open), baseVolume = Number(stats.volume);
    const volumeUsd = last * baseVolume;
    const dayChange = open > 0 ? (last / open - 1) * 100 : 0;
    const lastClosedBucket = Math.floor(at / 300_000) * 300;
    const recent = candles.filter(candle => Number(candle.time) < lastClosedBucket).slice(-13);
    const current = recent[recent.length - 1];
    const previous = recent[recent.length - 2];
    const hourAnchor = recent[0];
    const hourChange = hourAnchor && hourAnchor.close > 0 ? (last / hourAnchor.close - 1) * 100 : 0;
    const fiveMinChange = current && current.open > 0 ? (current.close / current.open - 1) * 100 : 0;
    const prePullback = recent.slice(-7,-2);
    const pullbackBars = recent.slice(-5,-1);
    const priorHigh = prePullback.length ? Math.max(...prePullback.map(candle => candle.high)) : 0;
    const pullbackLow = pullbackBars.length ? Math.min(...pullbackBars.map(candle => candle.low)) : 0;
    const pullbackPercent = priorHigh > 0 ? (priorHigh-pullbackLow)/priorHigh*100 : 0;
    const stopGapPercent = current && current.close > 0 ? (current.close-pullbackLow)/current.close*100 : 0;
    const baselineVolumes = recent.slice(-6,-1).map(candle => Number(candle.volume)||0).sort((a,b)=>a-b);
    const medianVolume = baselineVolumes.length ? baselineVolumes[Math.floor(baselineVolumes.length/2)] : 0;
    const volumeConfirmed = !!current && current.volume >= medianVolume && current.volume > 0;
    const reclaimed = !!(current && previous && current.close > previous.high && current.close > current.open);
    const reasons = [];
    if (!(last > 0 && open > 0)) reasons.push("Price unavailable");
    if (!Number.isFinite(volumeUsd) || volumeUsd < MIN_DAILY_VOLUME_USD) reasons.push("24h USD volume below $2M");
    if (dayChange < 1) reasons.push("Not a positive 24h mover");
    if (hourChange < 0.2 || hourChange > 15) reasons.push("1h trend is weak or overextended");
    if (recent.length < 13) reasons.push("Not enough closed 5m candles for a one-hour trend");
    if (pullbackPercent < 0.4 || pullbackPercent > 6) reasons.push("No orderly 0.4%–6% pullback");
    if (!reclaimed) reasons.push("Waiting for a 5m reclaim above the prior candle high");
    if (fiveMinChange < 0 || fiveMinChange > 3) reasons.push("5m rebound is weak or overextended");
    if (!volumeConfirmed) reasons.push("Reclaim lacks 5m volume confirmation");
    if (stopGapPercent > 3.75) reasons.push("Pullback stop would be too far from entry");
    const accepted = reasons.length === 0;
    const riskPercent = current && current.close > 0 ? Math.min(4,Math.max(1.5,stopGapPercent+0.25)) : 4;
    const score = accepted ? dayChange * 2 + hourChange + Math.log10(Math.max(volumeUsd,1)) : 0;
    return { accepted, reasons, candidate: { productId, symbol: productId.split("-")[0], priceUsd:last, volumeUsd,
      dayChangePercent:dayChange, hourChangePercent:hourChange, fiveMinChangePercent:fiveMinChange,
      pullbackPercent, pullbackLow, riskPercent, score, candles:recent } };
  }
  function recordRejections(rows) {
    if (!rows.length) return;
    const next = structuredClone(state);
    next.rejections.unshift(...rows.map(row => ({ time:new Date(now()).toISOString(), productId:row.productId,
      symbol:row.productId.split("-")[0], reason:row.reasons.join("; "), metrics:row.metrics||{} })));
    next.rejections = next.rejections.slice(0, 150);
    commit(next);
  }
  function buy(candidate) {
    const next = structuredClone(state); rotateDay(next);
    if (!next.running) return { success:false, error:"Coinbase Bot is stopped" };
    if (next.pausedForDailyLoss) return { success:false, error:"Daily loss limit reached" };
    if (next.openPositions.length >= MAX_OPEN_POSITIONS) return { success:false, error:"Six position limit reached" };
    if (next.openPositions.some(p => p.productId === candidate.productId)) return { success:false, error:"Coin already has an open position" };
    if (candidate.newsRisk) return { success:false, error:"Recent risk headline: " + candidate.newsRisk.title };
    const notional = Math.min(next.nextEntryUsd, MAX_SIZE_USD, next.cashUsd / (1 + FEE_RATE));
    if (!(candidate.priceUsd > 0) || notional < 1) return { success:false, error:"Insufficient paper cash or invalid quote" };
    const entryPrice = candidate.priceUsd * (1 + SLIPPAGE_RATE);
    const quantity = notional / entryPrice;
    const fee = notional * FEE_RATE;
    const riskPercent = Math.min(4,Math.max(1.5,Number(candidate.riskPercent)||3));
    const breakEvenPriceUsd = (notional+fee)/(quantity*(1-SLIPPAGE_RATE)*(1-FEE_RATE));
    const pos = {
      id:randomUUID(), productId:candidate.productId, tokenAddress:candidate.productId, symbol:candidate.symbol,
      entryPrice, marketEntryPrice:candidate.priceUsd, highestPrice:candidate.priceUsd, quantity,
      notionalUsd:notional, costBasisUsd:notional+fee, entryFeeUsd:fee, entryTime:new Date(now()).toISOString(),
      riskPercent, initialStopPriceUsd:candidate.priceUsd*(1-riskPercent/100), stopPriceUsd:candidate.priceUsd*(1-riskPercent/100),
      breakEvenPriceUsd, trailActivationPercent:Math.max(3,riskPercent*1.5),
      strategy:"Coinbase Bot · rolling 24h mover pullback/reclaim · stop below pullback · breakeven at +1R · 2.5% peak trail after +1.5R · 4h max hold",
      entryMetrics:{ dayChangePercent:candidate.dayChangePercent, hourChangePercent:candidate.hourChangePercent, fiveMinChangePercent:candidate.fiveMinChangePercent,
        pullbackPercent:candidate.pullbackPercent, pullbackLow:candidate.pullbackLow, riskPercent, volumeUsd:candidate.volumeUsd, score:candidate.score },
      markPriceUsd:candidate.priceUsd
    };
    next.cashUsd -= notional + fee;
    next.openPositions.push(pos);
    next.history.unshift({ type:"BUY", positionId:pos.id, productId:pos.productId, tokenAddress:pos.productId, symbol:pos.symbol,
      entryPrice:pos.entryPrice, quantity:pos.quantity, amountUsd:notional, feeUsd:fee, costBasisUsd:pos.costBasisUsd,
      time:pos.entryTime, entryTime:pos.entryTime, mode:"PAPER", strategy:pos.strategy, entryReason:"Top rolling-24h mover; pullback reclaimed with volume" });
    commit(next);
    return { success:true, position:structuredClone(pos) };
  }
  function closePosition(positionId, markPrice, reason) {
    const next = structuredClone(state); rotateDay(next);
    const index = next.openPositions.findIndex(p => p.id === positionId);
    if (index < 0) return { success:false, error:"Position not found" };
    const p = next.openPositions[index], price = Number(markPrice);
    if (!(price > 0)) return { success:false, error:"Invalid exit quote" };
    const exitPrice = price * (1 - SLIPPAGE_RATE);
    const grossValue = p.quantity * exitPrice;
    const fee = grossValue * FEE_RATE;
    const proceeds = grossValue - fee;
    const pnlUsd = proceeds - p.costBasisUsd;
    next.cashUsd += proceeds;
    next.dailyPnlUsd += pnlUsd;
    const time = new Date(now()).toISOString();
    const trade = { type:"SELL", id:randomUUID(), positionId:p.id, productId:p.productId, tokenAddress:p.productId, symbol:p.symbol,
      entryPrice:p.entryPrice, exitPrice, quantity:p.quantity, amountUsd:proceeds, saleValueUsd:proceeds,
      costBasisUsd:p.costBasisUsd, amountInvested:p.costBasisUsd, pnl:pnlUsd, pnlUsd, pnlPercent:p.costBasisUsd > 0 ? pnlUsd/p.costBasisUsd*100 : 0,
      estimatedFeesUsd:p.entryFeeUsd+fee, estimatedSlippageUsd:p.notionalUsd*SLIPPAGE_RATE+grossValue*SLIPPAGE_RATE,
      time, entryTime:p.entryTime, exitTime:time, holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),
      maxGainPercent:p.entryPrice > 0 ? (p.highestPrice/p.entryPrice-1)*100 : 0,
      reason, exitReason:reason, mode:"PAPER", strategy:p.strategy };
    next.history.unshift(trade);
    next.openPositions.splice(index,1);
    if (pnlUsd > 0) next.nextEntryUsd = Math.min(MAX_SIZE_USD, Math.round(next.nextEntryUsd * (1 + COMPOUND_RATE) * 100) / 100);
    else next.nextEntryUsd = START_SIZE_USD;
    if (next.dailyPnlUsd <= -DAILY_LOSS_LIMIT_USD) next.pausedForDailyLoss = true;
    commit(next);
    return { success:true, trade };
  }
  async function scanOnce() {
    if (!state.running || scanning || state.openPositions.length >= MAX_OPEN_POSITIONS || state.pausedForDailyLoss) return;
    scanning = true;
    try {
      const rejectionRows=[];
      let products;
      try { products=await getScanProducts(); }
      catch (error) { products=PRODUCTS.slice(); rejectionRows.push({productId:"COINBASE-USD-UNIVERSE",reasons:[error.message]}); }
      await news.refresh();
      const marketRows=await mapLimit(products.filter(id=>!state.openPositions.some(p=>p.productId===id)),5,async productId=>{
        try {
          const stats=await getStats(productId);
          const last=Number(stats.last),open=Number(stats.open),volumeUsd=last*Number(stats.volume);
          const dayChange=open>0?(last/open-1)*100:0;
          if (!(last>0&&open>0) || !Number.isFinite(volumeUsd) || dayChange<1 || volumeUsd<MIN_DAILY_VOLUME_USD) return null;
          return {productId,stats,last,dayChange,volumeUsd};
        } catch(error) { rejectionRows.push({productId,reasons:[error.message]});return null; }
      });
      const topMovers=marketRows.filter(Boolean).sort((a,b)=>b.dayChange-a.dayChange).slice(0,MAX_MOVER_CANDLES);
      const evaluated=await mapLimit(topMovers,5,async row=>{
        try {
          const candles=await getCandles(row.productId);
          return assessCandidate(row.productId,row.stats,candles);
        } catch(error) { rejectionRows.push({productId:row.productId,reasons:[error.message],metrics:{dayChangePercent:row.dayChange,volumeUsd:row.volumeUsd}});return null; }
      });
      const ranked=evaluated.filter(Boolean).map(result=>{
        if(!result.accepted)rejectionRows.push({productId:result.candidate.productId,reasons:result.reasons,metrics:result.candidate});
        return result;
      });
      lastMarketScan=ranked.map(result=>({ ...result.candidate, accepted:result.accepted, reasons:result.reasons }));
      const confirmed=ranked.filter(result=>result.accepted).map(result=>result.candidate);
      for (const candidate of confirmed.sort((a,b) => b.score-a.score)) {
        if (!state.running || state.openPositions.length >= MAX_OPEN_POSITIONS || state.pausedForDailyLoss) break;
        const risk=news.riskForProduct(candidate.productId);
        if(risk){candidate.newsRisk=risk;rejectionRows.push({productId:candidate.productId,reasons:["News risk flag: "+risk.term],metrics:{headline:risk.title,source:risk.source,publishedAt:risk.publishedAt}});continue;}
        buy(candidate);
      }
      recordRejections(rejectionRows.slice(0,60));
      const next = structuredClone(state); next.lastScanAt = new Date(now()).toISOString(); next.lastError = null; commit(next);
    } catch (error) {
      const next = structuredClone(state); next.lastError = error.message; commit(next);
    } finally { scanning = false; }
  }
  async function monitorOnce() {
    if (!state.running || monitoring || state.openPositions.length === 0) return;
    monitoring = true;
    try {
      for (const snapshot of structuredClone(state.openPositions)) {
        if (!state.running) break;
        try {
          const ticker = await getTicker(snapshot.productId);
          const price = Number(ticker.price);
          if (!(price > 0)) continue;
          const current = state.openPositions.find(p => p.id === snapshot.id);
          if (!current) continue;
          const next = structuredClone(state);
          const p = next.openPositions.find(item => item.id === snapshot.id);
          p.markPriceUsd = price;
          if (price > p.highestPrice) p.highestPrice = price;
          const age = now() - Date.parse(p.entryTime);
          const pnlPercent = (price / p.entryPrice - 1) * 100;
          if (!Number.isFinite(Number(p.riskPercent))) {
            commit(next);
            if (pnlPercent <= -3) closePosition(p.id,price,"LEGACY HARD STOP -3%");
            else if (pnlPercent >= 5) closePosition(p.id,price,"LEGACY TAKE PROFIT +5%");
            else if (pnlPercent >= 3 && price <= p.highestPrice*(1-TRAIL_FROM_PEAK_PERCENT/100)) closePosition(p.id,price,"LEGACY TRAILING STOP 2.5% FROM HIGH");
            else if (age >= LEGACY_MAX_HOLD_MS) closePosition(p.id,price,"LEGACY TIME EXIT 24H");
            continue;
          }
          const riskPercent=Number(p.riskPercent)||3;
          if(pnlPercent>=riskPercent)p.stopPriceUsd=Math.max(Number(p.stopPriceUsd)||0,Number(p.breakEvenPriceUsd)||p.entryPrice);
          if(pnlPercent>=Number(p.trailActivationPercent||Math.max(3,riskPercent*1.5)))
            p.stopPriceUsd=Math.max(Number(p.stopPriceUsd)||0,p.highestPrice*(1-TRAIL_FROM_PEAK_PERCENT/100));
          const stopPrice=Number(p.stopPriceUsd)||Number(p.initialStopPriceUsd)||p.entryPrice*(1-riskPercent/100);
          commit(next);
          if (price <= stopPrice) closePosition(p.id,price,Number(p.breakEvenPriceUsd)>0&&stopPrice>=Number(p.breakEvenPriceUsd)?"BREAKEVEN/TRAIL STOP":"PULLBACK HARD STOP");
          else if (age >= MAX_HOLD_MS) closePosition(p.id,price,"TIME EXIT 4H");
        } catch (error) {
          const next = structuredClone(state); next.lastError = error.message; commit(next);
        }
      }
    } finally { monitoring = false; }
  }
  function start() {
    if (scanTimer || monitorTimer) return;
    if (!state.running) {
      const next = structuredClone(state); rotateDay(next); next.running = true; next.lastError = null; commit(next);
    }
    scanTimer = timers.setInterval(() => void scanOnce(), SCAN_INTERVAL_MS);
    monitorTimer = timers.setInterval(() => void monitorOnce(), MONITOR_INTERVAL_MS);
    void scanOnce(); void monitorOnce();
  }
  function stop() {
    if (!state.running) return;
    if (scanTimer) timers.clearInterval(scanTimer);
    if (monitorTimer) timers.clearInterval(monitorTimer);
    scanTimer = monitorTimer = null;
    const next = structuredClone(state); next.running = false; commit(next);
  }
  async function closeAll() {
    const results = [];
    for (const position of structuredClone(state.openPositions)) {
      try {
        const ticker = await getTicker(position.productId);
        const result = closePosition(position.id, Number(ticker.price), "MANUAL PAPER CLOSE");
        results.push({ ...result, symbol:position.symbol });
      } catch (error) { results.push({ success:false, symbol:position.symbol, error:error.message }); }
    }
    return { success:results.every(row=>row.success), results };
  }
  function getStatus() {
    return { running:state.running, mode:"PAPER", exchange:"Coinbase Exchange public market data", lastScanAt:state.lastScanAt,
      lastError:state.lastError, openPositions:state.openPositions.length, maxOpenPositions:MAX_OPEN_POSITIONS,
      pausedForDailyLoss:state.pausedForDailyLoss, dailyPnlUsd:state.dailyPnlUsd,
      dailyMoverUniverseSize:productCache.length, paperOnly:true };
  }
  function getDashboardData() {
    const closed = new Map();
    for (const row of state.history) {
      if (row.type !== "SELL") continue;
      if (!closed.has(row.positionId)) closed.set(row.positionId,{ sells:[], buy:null });
      closed.get(row.positionId).sells.push(row);
    }
    for (const row of state.history) if (row.type === "BUY" && closed.has(row.positionId)) closed.get(row.positionId).buy=row;
    const completedTrades = [...closed.entries()].map(([id,g]) => {
      const sell=g.sells[0], buyRow=g.buy||{};
      return { positionId:id, symbol:sell.symbol, tokenAddress:sell.productId, entryPrice:sell.entryPrice, exitPrice:sell.exitPrice,
        investedUsd:sell.amountInvested, amountInvested:sell.amountInvested, saleValueUsd:sell.saleValueUsd, pnlUsd:sell.pnlUsd,
        pnl:sell.pnl, pnlPercent:sell.pnlPercent, returnPercent:sell.pnlPercent, entryTime:sell.entryTime, exitTime:sell.exitTime,
        estimatedFeesUsd:sell.estimatedFeesUsd, estimatedSlippageUsd:sell.estimatedSlippageUsd, costEstimateAvailable:true, netPnl:sell.pnlUsd, grossPnl:sell.pnlUsd+sell.estimatedFeesUsd+sell.estimatedSlippageUsd, holdTimeMs:sell.holdTimeMs, exitReason:sell.reason, maxGainPercent:sell.maxGainPercent, strategy:sell.strategy };
    });
    const livePositions = state.openPositions.map(p => {
      const exitPrice=p.markPriceUsd*(1-SLIPPAGE_RATE), value=p.quantity*exitPrice*(1-FEE_RATE);
      const pnl=value-p.costBasisUsd;
      return { position:p, live:{ priceUsd:p.markPriceUsd, currentValue:value, pnl, pnlPercent:p.costBasisUsd>0?pnl/p.costBasisUsd*100:0,
        holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)), exchangeUrl:"https://www.coinbase.com/advanced-trade/spot/"+p.productId.replace("-","-") }, pnl };
    });
    const equity=state.cashUsd+livePositions.reduce((sum,row)=>sum+Number(row.live.currentValue||0),0);
    const totalPnl=equity-state.startingBalanceUsd;
    return { label:"Coinbase Bot", paperOnly:true, mode:"PAPER", exchange:"Coinbase",
      strategy:"Rolling-24h Coinbase movers ranked by gain and $2M+ volume; enter on 5m pullback reclaim with volume. Stop 1.5%–4% below entry near pullback low; move to fee-aware breakeven at +1R; trail 2.5% from peak after +1.5R; 4h time exit. News risk headlines pause matching entries. Paper only.",
      startingBalance:state.startingBalanceUsd, startingBalanceUsd:state.startingBalanceUsd, cashBalance:state.cashUsd,
      equity,totalPnl,totalPnlPercent:state.startingBalanceUsd>0?totalPnl/state.startingBalanceUsd*100:0,
      nextTradeSizeUsd:state.nextEntryUsd, compoundIncrementPercent:COMPOUND_RATE*100, maxOpenPositions:MAX_OPEN_POSITIONS,
      estimatedFeePercentPerSide:FEE_RATE*100, estimatedSlippagePercentPerSide:SLIPPAGE_RATE*100,
      completedTrades, history:state.history, livePositions, openPositions:livePositions,
      rejections:state.rejections.slice(0,30), lastScanAt:state.lastScanAt,lastError:state.lastError,
      running:state.running, pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,
      candidates:lastMarketScan.slice(0,12), news:news.getState(), dailyMoverUniverseSize:productCache.length };
  }
  return { start, stop, scanOnce, monitorOnce, buy, closePosition, closeAll, getStatus, getDashboardData, getState:()=>structuredClone(state), assessCandidate, file };
}
const instance=createOutcomeBot();
module.exports={ createOutcomeBot, assessCandidate:(...a)=>assessCandidateStatic(...a), PRODUCTS, constants:{MAX_OPEN_POSITIONS,START_SIZE_USD,MAX_SIZE_USD,COMPOUND_RATE,TRAIL_FROM_PEAK_PERCENT,MAX_HOLD_MS,DAILY_LOSS_LIMIT_USD,MIN_DAILY_VOLUME_USD,MAX_SCAN_PRODUCTS,FEE_RATE,SLIPPAGE_RATE}, ...instance };
function assessCandidateStatic(productId,stats,candles) { return instance.assessCandidate(productId,stats,candles); }

