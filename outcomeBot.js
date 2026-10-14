"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STARTING_BALANCE_USD = 200;
const MAX_OPEN_POSITIONS = 6;
const START_SIZE_USD = 10;
const MAX_SIZE_USD = 25;
const COMPOUND_RATE = 0.10;
const TAKE_PROFIT_PERCENT = 5;
const HARD_STOP_PERCENT = -3;
const TRAIL_ACTIVATION_PERCENT = 3;
const TRAIL_FROM_PEAK_PERCENT = 2.5;
const MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DAILY_LOSS_LIMIT_USD = 20;
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
      !Number.isFinite(s.nextEntryUsd)) throw new Error("Invalid Outcome Bot paper state; refusing to reset it.");
  return s;
}
function createOutcomeBot({ file = defaultFile(), io = fs, fetchImpl = globalThis.fetch, timers = globalThis, now = () => Date.now() } = {}) {
  let state = freshState();
  if (io.existsSync(file)) state = validateState(JSON.parse(io.readFileSync(file, "utf8")));
  let scanTimer = null, monitorTimer = null, scanning = false, monitoring = false;
  let lastMarketScan = [];

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
    const response = await fetchImpl(url, { signal, headers: { "Accept": "application/json", "User-Agent": "OutcomeBot-Paper/1.0" } });
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
  function assessCandidate(productId, stats, candles) {
    const last = Number(stats.last), open = Number(stats.open), baseVolume = Number(stats.volume);
    const volumeUsd = last * baseVolume;
    const dayChange = open > 0 ? (last / open - 1) * 100 : 0;
    const recent = candles.slice(-13);
    const current = recent[recent.length - 1];
    const hourAnchor = recent.length >= 13 ? recent[0] : recent[0];
    const hourChange = hourAnchor && hourAnchor.close > 0 ? (last / hourAnchor.close - 1) * 100 : 0;
    const fiveMinChange = current && current.open > 0 ? (current.close / current.open - 1) * 100 : 0;
    const ascendingCount = recent.slice(-3).slice(1).reduce((count, candle, i, arr) => count + (candle.close > recent.slice(-3)[i].close ? 1 : 0), 0);
    const reasons = [];
    if (!(last > 0 && open > 0)) reasons.push("Price unavailable");
    if (volumeUsd < 2_000_000) reasons.push("24h USD volume below $2M");
    if (dayChange < 1 || dayChange > 15) reasons.push("24h move outside 1%–15% trend window");
    if (hourChange < 0.3 || hourChange > 8) reasons.push("1h trend outside 0.3%–8% window");
    if (fiveMinChange < 0.1 || fiveMinChange > 2.5) reasons.push("5m move outside 0.1%–2.5% confirmation window");
    if (ascendingCount < 1) reasons.push("No recent 5m candle reclaim");
    const accepted = reasons.length === 0;
    const score = accepted ? dayChange + hourChange * 2 + Math.log10(Math.max(volumeUsd,1)) : 0;
    return { accepted, reasons, candidate: { productId, symbol: productId.split("-")[0], priceUsd:last, volumeUsd, dayChangePercent:dayChange, hourChangePercent:hourChange, fiveMinChangePercent:fiveMinChange, score, candles:recent } };
  }
  function recordRejection(productId, reasons, metrics = {}) {
    const next = structuredClone(state);
    next.rejections.unshift({ time:new Date(now()).toISOString(), productId, symbol:productId.split("-")[0], reason:reasons.join("; "), metrics });
    next.rejections = next.rejections.slice(0, 150);
    commit(next);
  }
  function buy(candidate) {
    const next = structuredClone(state); rotateDay(next);
    if (!next.running) return { success:false, error:"Outcome Bot is stopped" };
    if (next.pausedForDailyLoss) return { success:false, error:"Daily loss limit reached" };
    if (next.openPositions.length >= MAX_OPEN_POSITIONS) return { success:false, error:"Six position limit reached" };
    if (next.openPositions.some(p => p.productId === candidate.productId)) return { success:false, error:"Coin already has an open position" };
    const notional = Math.min(next.nextEntryUsd, MAX_SIZE_USD, next.cashUsd / (1 + FEE_RATE));
    if (!(candidate.priceUsd > 0) || notional < 1) return { success:false, error:"Insufficient paper cash or invalid quote" };
    const entryPrice = candidate.priceUsd * (1 + SLIPPAGE_RATE);
    const quantity = notional / entryPrice;
    const fee = notional * FEE_RATE;
    const pos = {
      id:randomUUID(), productId:candidate.productId, tokenAddress:candidate.productId, symbol:candidate.symbol,
      entryPrice, marketEntryPrice:candidate.priceUsd, highestPrice:candidate.priceUsd, quantity,
      notionalUsd:notional, costBasisUsd:notional+fee, entryFeeUsd:fee, entryTime:new Date(now()).toISOString(),
      strategy:"Outcome Bot · Coinbase trend confirmation · TP +5% / SL -3% / 2.5% trail after +3%",
      entryMetrics:{ dayChangePercent:candidate.dayChangePercent, hourChangePercent:candidate.hourChangePercent, fiveMinChangePercent:candidate.fiveMinChangePercent, volumeUsd:candidate.volumeUsd, score:candidate.score },
      markPriceUsd:candidate.priceUsd
    };
    next.cashUsd -= notional + fee;
    next.openPositions.push(pos);
    next.history.unshift({ type:"BUY", positionId:pos.id, productId:pos.productId, tokenAddress:pos.productId, symbol:pos.symbol,
      entryPrice:pos.entryPrice, quantity:pos.quantity, amountUsd:notional, feeUsd:fee, costBasisUsd:pos.costBasisUsd,
      time:pos.entryTime, entryTime:pos.entryTime, mode:"PAPER", strategy:pos.strategy, entryReason:"Coinbase momentum confirmation" });
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
      const ranked = [];
      for (const productId of PRODUCTS) {
        if (!state.running || state.openPositions.length >= MAX_OPEN_POSITIONS || state.pausedForDailyLoss) break;
        if (state.openPositions.some(p => p.productId === productId)) continue;
        try {
          const [stats,candles] = await Promise.all([getStats(productId),getCandles(productId)]);
          const result = assessCandidate(productId,stats,candles);
          if (!result.accepted) recordRejection(productId,result.reasons,result.candidate);
          else ranked.push(result.candidate);
        } catch (error) {
          recordRejection(productId,[error.message]);
        }
      }
      ranked.sort((a,b) => b.score-a.score);
      lastMarketScan = ranked;
      for (const candidate of ranked) {
        if (!state.running || state.openPositions.length >= MAX_OPEN_POSITIONS || state.pausedForDailyLoss) break;
        buy(candidate);
      }
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
          commit(next);
          const pnlPercent = (price / p.entryPrice - 1) * 100;
          const age = now() - Date.parse(p.entryTime);
          if (pnlPercent <= HARD_STOP_PERCENT) closePosition(p.id,price,"HARD STOP -3%");
          else if (pnlPercent >= TAKE_PROFIT_PERCENT) closePosition(p.id,price,"TAKE PROFIT +5%");
          else if (pnlPercent >= TRAIL_ACTIVATION_PERCENT && price <= p.highestPrice * (1-TRAIL_FROM_PEAK_PERCENT/100)) closePosition(p.id,price,"TRAILING STOP 2.5% FROM HIGH");
          else if (age >= MAX_HOLD_MS) closePosition(p.id,price,"TIME EXIT 24H");
        } catch (error) {
          const next = structuredClone(state); next.lastError = error.message; commit(next);
        }
      }
    } finally { monitoring = false; }
  }
  function start() {
    if (state.running) return;
    const next = structuredClone(state); rotateDay(next); next.running = true; next.lastError = null; commit(next);
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
  function getStatus() {
    return { running:state.running, mode:"PAPER", exchange:"Coinbase Exchange public market data", lastScanAt:state.lastScanAt,
      lastError:state.lastError, openPositions:state.openPositions.length, maxOpenPositions:MAX_OPEN_POSITIONS,
      pausedForDailyLoss:state.pausedForDailyLoss, dailyPnlUsd:state.dailyPnlUsd };
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
        holdTimeMs:sell.holdTimeMs, exitReason:sell.reason, maxGainPercent:sell.maxGainPercent, strategy:sell.strategy };
    });
    const livePositions = state.openPositions.map(p => {
      const exitPrice=p.markPriceUsd*(1-SLIPPAGE_RATE), value=p.quantity*exitPrice*(1-FEE_RATE);
      const pnl=value-p.costBasisUsd;
      return { position:p, live:{ priceUsd:p.markPriceUsd, currentValue:value, pnl, pnlPercent:p.costBasisUsd>0?pnl/p.costBasisUsd*100:0,
        holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)), exchangeUrl:"https://www.coinbase.com/advanced-trade/spot/"+p.productId.replace("-","-") }, pnl };
    });
    const equity=state.cashUsd+livePositions.reduce((sum,row)=>sum+Number(row.live.currentValue||0),0);
    const totalPnl=equity-state.startingBalanceUsd;
    return { label:"Outcome Bot", paperOnly:true, mode:"PAPER", exchange:"Coinbase",
      strategy:"Trend confirmation: 24h +1–15%, 1h +0.3–8%, 5m +0.1–2.5%; TP +5%, hard stop -3%, trail 2.5% after +3%; max hold 24h.",
      startingBalance:state.startingBalanceUsd, startingBalanceUsd:state.startingBalanceUsd, cashBalance:state.cashUsd,
      equity,totalPnl,totalPnlPercent:state.startingBalanceUsd>0?totalPnl/state.startingBalanceUsd*100:0,
      nextTradeSizeUsd:state.nextEntryUsd, compoundIncrementPercent:COMPOUND_RATE*100, maxOpenPositions:MAX_OPEN_POSITIONS,
      estimatedFeePercentPerSide:FEE_RATE*100, estimatedSlippagePercentPerSide:SLIPPAGE_RATE*100,
      completedTrades, history:state.history, livePositions, openPositions:livePositions,
      rejections:state.rejections.slice(0,30), lastScanAt:state.lastScanAt,lastError:state.lastError,
      running:state.running, pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,
      candidates:lastMarketScan.slice(0,12) };
  }
  return { start, stop, scanOnce, monitorOnce, buy, closePosition, getStatus, getDashboardData, getState:()=>structuredClone(state), assessCandidate, file };
}
const instance=createOutcomeBot();
module.exports={ createOutcomeBot, assessCandidate:(...a)=>assessCandidateStatic(...a), PRODUCTS, constants:{MAX_OPEN_POSITIONS,START_SIZE_USD,COMPOUND_RATE,TAKE_PROFIT_PERCENT,HARD_STOP_PERCENT,TRAIL_ACTIVATION_PERCENT,TRAIL_FROM_PEAK_PERCENT,DAILY_LOSS_LIMIT_USD,FEE_RATE,SLIPPAGE_RATE}, ...instance };
function assessCandidateStatic(productId,stats,candles) { return instance.assessCandidate(productId,stats,candles); }
