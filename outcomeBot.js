"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createCoinbaseNews } = require("./coinbaseNews");

const STARTING_BALANCE_USD = 200;
const MAX_OPEN_POSITIONS = 3;
const START_SIZE_USD = 10;
const COMPOUND_RATE = 0.10;
const HARD_STOP_PERCENT = 2.0;
const TP1_PERCENT = 5;
const TP2_PERCENT = 8;
const TP1_SELL_FRACTION = 0.70;
const TP2_SELL_FRACTION = 0.20;
const RUNNER_TRAIL_PERCENT = 8;
const MAX_HOLD_MS = 45 * 60 * 1000;
const LEGACY_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DAILY_LOSS_FRACTION = 0.03;
const MIN_DAILY_GAIN_PERCENT = -5;
const MAX_DAILY_GAIN_PERCENT = 35;
const MIN_DAILY_VOLUME_USD = 1_000_000;
const MAX_SCAN_PRODUCTS = 180;
const MAX_MOVER_CANDLES = 30;
const PRODUCT_CACHE_MS = 15 * 60 * 1000;
const MAX_SPREAD_PERCENT = 0.30;
const MAX_EXIT_SPREAD_PERCENT = 0.60;
const COIN_COOLDOWN_MS = 60 * 60 * 1000;
const END_OF_DAY_PR = "23:45";
const FEE_RATE = Math.min(0.01, Math.max(0, Number(process.env.OUTCOME_PAPER_FEE_RATE ?? 0.006)));
const SLIPPAGE_RATE = Math.min(0.005, Math.max(0, Number(process.env.OUTCOME_PAPER_SLIPPAGE_RATE ?? 0.001)));
const SCAN_INTERVAL_MS = 45_000;
const MONITOR_INTERVAL_MS = 5_000;
const PRODUCTS = ["BTC-USD","SOL-USD","XRP-USD","HYPE-USD"];
const BASE_URL = "https://api.exchange.coinbase.com";
const STRATEGY_VERSION = "COINBASE_MAJOR_UPTREND_V5";
const MIN_POSITION_EQUITY_FRACTION = 0.05;
const MAX_POSITION_EQUITY_FRACTION = 0.10;
const REQUEST_INTERVAL_MS = 200;
const MAX_429_RETRIES = 3;

function defaultFile() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "outcome-paper-state.json");
}
function freshState() {
  return {
    schemaVersion: 1, startingBalanceUsd: STARTING_BALANCE_USD, cashUsd: STARTING_BALANCE_USD, coinCooldowns: {},
    openPositions: [], history: [], rejections: [], lastScanAt: null, lastError: null,
    running: false, nextEntryUsd: START_SIZE_USD, dailyPnlUsd: 0, dailyStartingEquityUsd: STARTING_BALANCE_USD,
    dailyPnlDate: localDayKey(Date.now()), pausedForDailyLoss: false
  };
}
function localDayKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {timeZone:"America/Puerto_Rico",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(timestamp));
}
function validateState(s) {
  if (!s || s.schemaVersion !== 1 || !Number.isFinite(s.cashUsd) || !Array.isArray(s.openPositions) ||
      !Array.isArray(s.history) || !Array.isArray(s.rejections)) {
    throw new Error("Invalid Coinbase Bot paper state; refusing to reset it.");
  }
  return s;
}
function estimatePortfolioEquity(s) {
  return (Number(s.cashUsd) || 0) + (Array.isArray(s.openPositions) ? s.openPositions.reduce((sum, p) => {
    const mark = Number(p.markPriceUsd || p.marketEntryPrice || p.entryPrice) || 0;
    return sum + (Number(p.quantity) || 0) * mark * (1 - FEE_RATE - SLIPPAGE_RATE);
  }, 0) : 0);
}
function migrateState(s, timestamp = Date.now()) {
  validateState(s);
  const today = localDayKey(timestamp);
  const history = s.history;
  const realizedToday = history.reduce((sum, row) => {
    if (String(row.type || "").toUpperCase() !== "SELL") return sum;
    const time = Date.parse(row.exitTime || row.time || row.timestamp || "");
    if (!Number.isFinite(time) || localDayKey(time) !== today) return sum;
    const pnl = Number(row.pnlUsd ?? row.pnl ?? row.realizedPnl);
    return sum + (Number.isFinite(pnl) ? pnl : 0);
  }, 0);
  const dailyPnlUsd = s.dailyPnlDate === today && Number.isFinite(s.dailyPnlUsd)
    ? s.dailyPnlUsd : realizedToday;
  const dailyStartingEquityUsd = s.dailyPnlDate === today && Number.isFinite(Number(s.dailyStartingEquityUsd)) && Number(s.dailyStartingEquityUsd) > 0
    ? Number(s.dailyStartingEquityUsd) : (estimatePortfolioEquity(s) || Number(s.startingBalanceUsd) || STARTING_BALANCE_USD);
  return validateState({
    ...s,
    coinCooldowns: s.coinCooldowns && typeof s.coinCooldowns === "object" ? s.coinCooldowns : {},
    nextEntryUsd: Number.isFinite(s.nextEntryUsd) && s.nextEntryUsd > 0
      ? s.nextEntryUsd : START_SIZE_USD,
    dailyPnlDate: today,
    dailyPnlUsd,
    dailyStartingEquityUsd,
    pausedForDailyLoss: s.pausedForDailyLoss === true || dailyPnlUsd <= -((Number(s.dailyStartingEquityUsd) || Number(s.startingBalanceUsd) || STARTING_BALANCE_USD) * DAILY_LOSS_FRACTION)
  });
}
function createOutcomeBot({ file = defaultFile(), io = fs, fetchImpl = globalThis.fetch, timers = globalThis, now = () => Date.now(), newsProvider = null } = {}) {
  let state = freshState();
  if (io.existsSync(file)) state = migrateState(JSON.parse(io.readFileSync(file, "utf8")), now());
  let scanTimer = null, monitorTimer = null, scanning = false, monitoring = false;
  let lastMarketScan = [];
  let productCache = [], productCacheAt = 0;
  let lastRequestAt = 0;
  let requestQueue = Promise.resolve();
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
  function localDayKey(timestamp) { return new Intl.DateTimeFormat("en-CA", {timeZone:"America/Puerto_Rico",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(timestamp)); }
  function portfolioEquity(source = state) {
    return source.cashUsd + source.openPositions.reduce((sum, p) => {
      const mark = Number(p.markPriceUsd || p.marketEntryPrice || p.entryPrice) || 0;
      return sum + (Number(p.quantity) || 0) * mark * (1 - FEE_RATE - SLIPPAGE_RATE);
    }, 0);
  }
  function dailyLossLimitUsd(source = state) {
    return Math.max(0, Number(source.dailyStartingEquityUsd) || Number(source.startingBalanceUsd) || STARTING_BALANCE_USD) * DAILY_LOSS_FRACTION;
  }
  function localClock(timestamp) { return new Intl.DateTimeFormat("en-GB", {timeZone:"America/Puerto_Rico",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(timestamp)); }
  function isEndOfDay(timestamp = now()) { return localClock(timestamp) >= END_OF_DAY_PR; }
  function rotateDay(next) {
    const today = localDayKey(now());
    if (next.dailyPnlDate !== today) {
      next.dailyPnlDate = today; next.dailyPnlUsd = 0; next.dailyStartingEquityUsd = portfolioEquity(next); next.pausedForDailyLoss = false; next.coinCooldowns = {};
    }
  }
  async function waitForRequestSlot() {
    const previous = requestQueue;
    let release;
    requestQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, REQUEST_INTERVAL_MS - (now() - lastRequestAt));
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      lastRequestAt = now();
    } finally { release(); }
  }
  async function requestJson(url, signal) {
    for (let attempt = 0; ; attempt++) {
      await waitForRequestSlot();
      const response = await fetchImpl(url, { signal: signal || AbortSignal.timeout(8000), headers: { "Accept": "application/json", "User-Agent": "CoinbaseTopGainerBot-Paper/2.0" } });
      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(response.headers?.get?.("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 250 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (!response.ok) throw new Error("Coinbase market data HTTP " + response.status);
      return response.json();
    }
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
      .filter(row => ["USD","USDC"].includes(row.quote_currency) && Array.isArray(row.market_types) && row.market_types.includes("spot"))
      .map(row => [row.id, Number(row.spot_volume_24hour) || 0]));
    const stable = new Set(["USDC","USDT","DAI","PYUSD","GUSD","USDP","USDS"]);
    const wrapped = new Set(["WBTC","WETH","WSTETH","CBBTC","CBETH","WETH.E"]);
    const eligible = (Array.isArray(products) ? products : []).filter(product =>
      product && PRODUCTS.includes(product.id) && product.id && ["USD","USDC"].includes(product.quote_currency) && product.status === "online" &&
      !product.trading_disabled && !product.cancel_only && !product.post_only && !product.limit_only &&
      !product.auction_mode && !product.fx_stablecoin && !stable.has(product.base_currency) && !wrapped.has(product.base_currency) &&
      (!product.trading_start || (now() - Date.parse(product.trading_start) >= 48 * 60 * 60 * 1000)) &&
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
  function ema(values, period) {
    if (values.length < period) return null;
    const alpha = 2 / (period + 1);
    let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
    for (const next of values.slice(period)) value = next * alpha + value * (1 - alpha);
    return value;
  }
  function rsi(values, period = 14) {
    if (values.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = values.length - period; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      if (change > 0) gains += change; else losses -= change;
    }
    if (gains === 0 && losses === 0) return 50;
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
  }
  function assessCandidate(productId, stats, candles, at = now()) {
    const last = Number(stats.last), open = Number(stats.open), baseVolume = Number(stats.volume);
    const volumeUsd = last * baseVolume;
    const dayChange = open > 0 ? (last / open - 1) * 100 : 0;
    const closed = candles.filter(c => Number(c.time) < Math.floor(at / 300_000) * 300).slice(-288);
    const prices = closed.map(c => Number(c.close)).filter(n => n > 0);
    const current = closed[closed.length - 1], previous = closed[closed.length - 2];
    const hourAnchor = closed[closed.length - 13];
    const hourChange = hourAnchor && hourAnchor.close > 0 ? (last / hourAnchor.close - 1) * 100 : 0;
    const fiveMinChange = current && current.open > 0 ? (current.close / current.open - 1) * 100 : 0;
    const hourlyBars = closed.slice(-12);
    const localHigh = hourlyBars.length ? Math.max(...hourlyBars.map(c => c.high)) : 0;
    const pullbackPercent = localHigh > 0 ? Math.max(0, (localHigh - last) / localHigh * 100) : 0;
    const sessionStart = Math.floor(at / 86_400_000) * 86_400_000 / 1000;
    const session = closed.filter(c => c.time >= sessionStart);
    const vwapVolume = session.reduce((sum, c) => sum + (Number(c.volume) || 0), 0);
    const vwap = vwapVolume > 0 ? session.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0) / vwapVolume : null;
    const ema9 = ema(prices, 9), ema21 = ema(prices, 21), rsi5m = rsi(prices, 14);
    const recent15mVolume = closed.slice(-3).reduce((sum, c) => sum + (Number(c.volume) || 0), 0);
    const windows = [];
    for (let i = Math.max(0, closed.length - 288); i + 3 <= closed.length - 3; i += 3) {
      windows.push(closed.slice(i, i + 3).reduce((sum, c) => sum + (Number(c.volume) || 0), 0));
    }
    const average15mVolume = windows.length ? windows.reduce((sum, n) => sum + n, 0) / windows.length : 0;
    const relativeVolume15m = average15mVolume > 0 ? recent15mVolume / average15mVolume : 0;
    const priorResistance = closed.length >= 4 ? Math.max(...closed.slice(-4, -1).map(c => c.high)) : 0;
    const pullbackSetup = !!(closed.length >= 21 && current && previous &&
      current.close > current.open && current.close > ema9 && current.close > previous.close &&
      previous.low <= ema9 * 1.01 && last >= ema9);
    const breakoutSetup = !!(closed.length >= 21 && current && previous &&
      current.close > current.open && current.close > previous.high &&
      current.close > priorResistance && relativeVolume15m >= 1.2);
    const setup = pullbackSetup ? "UPTREND_PULLBACK_RECLAIM" : (breakoutSetup ? "UPTREND_BREAKOUT" : null);
    const recentHigh = closed.length ? Math.max(...closed.slice(-12).map(c => c.high)) : 0;
    const offHighPercent = recentHigh > 0 ? Math.max(0, (recentHigh - last) / recentHigh * 100) : 0;
    const reasons = [];
    if (!(last > 0 && open > 0)) reasons.push("Price unavailable");
    if (!Number.isFinite(volumeUsd) || volumeUsd < MIN_DAILY_VOLUME_USD) reasons.push("24h USD volume below $5M");
    if (dayChange < MIN_DAILY_GAIN_PERCENT) reasons.push("24h gain below +4%");
    if (dayChange > MAX_DAILY_GAIN_PERCENT) reasons.push("24h gain above +35% chase limit");
    if (closed.length < 21) reasons.push("Insufficient 105 minutes of trend history");
    if (relativeVolume15m < 1.2) reasons.push("15m relative volume below 1.2x");
    if (!(vwap > 0 && last > vwap)) reasons.push("Price is not above session VWAP");
    if (!(ema9 > 0 && ema21 > 0 && ema9 > ema21)) reasons.push("5m EMA9 is not above EMA21");
    if (!(rsi5m !== null && rsi5m < 85)) reasons.push("5m RSI is 85 or higher");
    if (hourChange <= 0.25 || hourChange > 25) reasons.push("1h trend is not rising or is overextended");
    if (!setup) reasons.push("Waiting for a green pullback reclaim or upward breakout");
    if (offHighPercent > 5) reasons.push("Price is more than 5% below the local high");
    const feeAndSlippageRoundTripPercent = (2 * FEE_RATE + 2 * SLIPPAGE_RATE) * 100;
    if (TP1_PERCENT < feeAndSlippageRoundTripPercent * 3) reasons.push("First target does not clear the 3x round-trip cost hurdle");
    const accepted = reasons.length === 0;
    const score = accepted ? dayChange * 2 + hourChange + Math.min(relativeVolume15m, 6) * 3 +
      (setup === "PULLBACK_RECLAIM" ? 4 : 2) + (last > vwap ? 2 : 0) : 0;
    const atrBars = closed.slice(-15);
    const atr = atrBars.length >= 15 ? atrBars.slice(1).reduce((sum, c, i) => {
      const prev = atrBars[i].close;
      return sum + Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    }, 0) / 14 : 0;
    const atrPercent = last > 0 ? atr / last * 100 : 0;
    const riskPercent = Math.min(2.5, Math.max(1.5, atrPercent * 1.5));
    return { accepted, reasons, candidate:{ productId, symbol:productId.split("-")[0], priceUsd:last, volumeUsd,
      dayChangePercent:dayChange, hourChangePercent:hourChange, fiveMinChangePercent:fiveMinChange, pullbackPercent,
      pullbackLow:Math.min(...hourlyBars.map(c => c.low)), volumeRatio:relativeVolume15m, relativeVolume15m,
      offHighPercent, vwap, ema9, ema21, rsi5m, atrPercent, entrySetup:setup, riskPercent, score, candles:closed } };
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
    if (next.openPositions.length >= MAX_OPEN_POSITIONS) return {success:false,error:"Three position limit reached"};
    if (next.openPositions.some(p=>p.productId===candidate.productId)) return {success:false,error:"Coin already has an open position"};
    if (Number(next.coinCooldowns?.[candidate.productId]) > now()) return {success:false,error:"Coin re-entry cooldown active"};
    if (candidate.newsRisk) return {success:false,error:"Recent risk headline: "+candidate.newsRisk.title};
    const equityUsd = portfolioEquity(next);
    const notional = Math.min(Math.max(next.nextEntryUsd, equityUsd * MIN_POSITION_EQUITY_FRACTION),
      equityUsd * MAX_POSITION_EQUITY_FRACTION, next.cashUsd/(1+FEE_RATE));
    if (!(candidate.priceUsd>0) || notional<1) return {success:false,error:"Insufficient paper cash or invalid quote"};
    const entryPrice = candidate.priceUsd*(1+SLIPPAGE_RATE), quantity=notional/entryPrice, fee=notional*FEE_RATE;
    const costBasisUsd=notional+fee;
    const pos={ id:randomUUID(),productId:candidate.productId,tokenAddress:candidate.productId,symbol:candidate.symbol,
      entryPrice,marketEntryPrice:candidate.priceUsd,highestPrice:candidate.priceUsd,quantity,originalQuantity:quantity,
      notionalUsd:notional,costBasisUsd,initialCostBasisUsd:costBasisUsd,remainingCostBasisUsd:costBasisUsd,entryFeeUsd:fee,
      realizedPnlUsd:0,entryTime:new Date(now()).toISOString(),strategyVersion:STRATEGY_VERSION,
      hardStopPercent:Number(candidate.riskPercent)||HARD_STOP_PERCENT,stopPriceUsd:entryPrice*(1-(Number(candidate.riskPercent)||HARD_STOP_PERCENT)/100),tp1Done:false,tp2Done:false,
      runnerTrailActive:false,markPriceUsd:candidate.priceUsd,
      strategy:"Coinbase Bot paper major-coin uptrend · BTC/SOL/XRP/HYPE only · rising 1h trend · VWAP + EMA9>EMA21 · green reclaim/breakout · 70% at +5%, 20% at +8%, 10% runner trailing 8% · 2% hard stop · PR 23:45 flat",
      entryMetrics:{dayChangePercent:candidate.dayChangePercent,hourChangePercent:candidate.hourChangePercent,fiveMinChangePercent:candidate.fiveMinChangePercent,
        pullbackPercent:candidate.pullbackPercent,volumeRatio:candidate.volumeRatio,volumeUsd:candidate.volumeUsd,score:candidate.score,entrySetup:candidate.entrySetup} };
    next.cashUsd -= costBasisUsd; next.openPositions.push(pos);
    next.history.unshift({type:"BUY",positionId:pos.id,productId:pos.productId,tokenAddress:pos.productId,symbol:pos.symbol,
      entryPrice:pos.entryPrice,quantity:pos.quantity,amountUsd:notional,feeUsd:fee,costBasisUsd:pos.costBasisUsd,time:pos.entryTime,
      entryTime:pos.entryTime,mode:"PAPER",strategy:pos.strategy,entryReason:"Major-coin upward momentum; "+(candidate.entrySetup||"trend confirmation")});
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
    if (next.dailyPnlUsd <= -dailyLossLimitUsd(next)) next.pausedForDailyLoss = true;
    const totalRealized=(Number(p.realizedPnlUsd)||0)+pnlUsd;
    next.history.unshift({type:"SELL",id:randomUUID(),positionId:p.id,productId:p.productId,tokenAddress:p.productId,symbol:p.symbol,
      entryPrice:p.entryPrice,exitPrice,quantity:qty,amountUsd:proceeds,saleValueUsd:proceeds,costBasisUsd:allocatedCost,amountInvested:allocatedCost,
      pnl:pnlUsd,pnlUsd,pnlPercent:allocatedCost>0?pnlUsd/allocatedCost*100:0,estimatedFeesUsd:allocatedEntryFee+fee,
      estimatedSlippageUsd:(p.notionalUsd||0)*SLIPPAGE_RATE*(qty/originalQty)+grossValue*SLIPPAGE_RATE,time,entryTime:p.entryTime,exitTime:time,
      holdTimeMs:Math.max(0,now()-Date.parse(p.entryTime)),maxGainPercent:p.entryPrice>0?(Number(p.highestPrice||price)/p.entryPrice-1)*100:0,
      reason,exitReason:reason,partial:!final,mode:"PAPER",strategy:p.strategy});
    if(final){
      next.openPositions.splice(index,1);
      if(totalRealized>0)next.nextEntryUsd=Math.round(next.nextEntryUsd*(1+COMPOUND_RATE)*100)/100; else next.nextEntryUsd=START_SIZE_USD;
    } else {
      p.quantity=remainingQty;p.remainingCostBasisUsd=Math.max(0,remainingCost-allocatedCost);p.costBasisUsd=p.remainingCostBasisUsd;p.realizedPnlUsd=totalRealized;
      Object.assign(p,patch);
      next.openPositions[index]=p;
    }
    if(next.dailyPnlUsd<=-dailyLossLimitUsd(next))next.pausedForDailyLoss=true;
    commit(next); return {success:true,trade:structuredClone(next.history[0]),final};
  }
  function closePosition(positionId, markPrice, reason) {
    const p=state.openPositions.find(x=>x.id===positionId); if(!p)return {success:false,error:"Position not found"};
    const result=sellQuantity(positionId,markPrice,p.quantity,reason);
    if(result.success && result.final && /STOP|SPREAD EXIT/i.test(reason)){const next=structuredClone(state);next.coinCooldowns=next.coinCooldowns||{};next.coinCooldowns[p.productId]=now()+COIN_COOLDOWN_MS;commit(next);}
    return result;
  }
  async function scanOnce() {
    if(!state.running||scanning||state.openPositions.length>=MAX_OPEN_POSITIONS||state.pausedForDailyLoss||isEndOfDay())return;
    scanning=true;
    try {
      const rejectionRows=[];let products;
      if (await btcMarketSelloff()) { const next=structuredClone(state); next.lastScanAt=new Date(now()).toISOString(); next.lastError=null; commit(next); recordRejections([{productId:"BTC-USD",reasons:["New entries paused: BTC fell more than 2% in one hour or is selling off sharply"]}]); return; }
      try{products=await getScanProducts();}catch(error){products=PRODUCTS.slice();rejectionRows.push({productId:"COINBASE-USD-UNIVERSE",reasons:[error.message]});}
      await news.refresh();
      const marketRows=await mapLimit(products.filter(id=>!state.openPositions.some(p=>p.productId===id) && !(Number(state.coinCooldowns?.[id]) > now())),4,async productId=>{
        try{const stats=await getStats(productId);const last=Number(stats.last),open=Number(stats.open),volumeUsd=last*Number(stats.volume),dayChange=open>0?(last/open-1)*100:0;
          if(!(last>0&&open>0)){rejectionRows.push({productId,reasons:["Price/24h stats unavailable"]});return null;}
          if(!Number.isFinite(volumeUsd)||volumeUsd<MIN_DAILY_VOLUME_USD){rejectionRows.push({productId,reasons:["24h USD volume below $1M"],metrics:{volumeUsd}});return null;}
          if(dayChange<MIN_DAILY_GAIN_PERCENT||dayChange>MAX_DAILY_GAIN_PERCENT){rejectionRows.push({productId,reasons:[dayChange<MIN_DAILY_GAIN_PERCENT?"24h change below -5%":"24h change above +35% chase limit"],metrics:{dayChangePercent:dayChange,volumeUsd}});return null;}
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
          if(spread>MAX_SPREAD_PERCENT){rejectionRows.push({productId:candidate.productId,reasons:["Bid/ask spread above 0.30%"],metrics:{spreadPercent:spread}});continue;}
          candidate.priceUsd=price;candidate.spreadPercent=spread;buy(candidate);
        }catch(error){rejectionRows.push({productId:candidate.productId,reasons:["Pre-entry quote failed: "+error.message]});}
      }
      recordRejections(rejectionRows.slice(0,80));
      console.log("COINBASE_SCAN",JSON.stringify({at:new Date(now()).toISOString(),universe:products.length,topMovers:topMovers.length,qualified:ranked.filter(x=>x.accepted).length,opened:state.openPositions.length,candidates:lastMarketScan.slice(0,5).map(x=>({productId:x.productId,score:x.score,dayChangePercent:x.dayChangePercent,hourChangePercent:x.hourChangePercent,relativeVolume15m:x.relativeVolume15m})),rejections:rejectionRows.slice(0,8).map(x=>({productId:x.productId,reasons:x.reasons}))}));
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
    if(pnlPercent<=-(Number(p.hardStopPercent)||HARD_STOP_PERCENT)){closePosition(p.id,price,"ATR HARD STOP -"+(Number(p.hardStopPercent)||HARD_STOP_PERCENT)+"%");return;}
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    if(!current.tp1Done&&pnlPercent+1e-9>=TP1_PERCENT){
      sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP1_SELL_FRACTION,"TAKE PROFIT +5% (70%)",{tp1Done:true,stopPriceUsd:current.entryPrice*(1+0.014)});
    }
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    if(!current.tp2Done&&pnlPercent+1e-9>=TP2_PERCENT){
      sellQuantity(current.id,price,(Number(current.originalQuantity)||current.quantity)*TP2_SELL_FRACTION,"TAKE PROFIT +8% (20%)",{tp1Done:true,tp2Done:true,runnerTrailActive:true,stopPriceUsd:current.entryPrice*(1+0.014)});
    }
    current=state.openPositions.find(x=>x.id===snapshot.id);if(!current)return;
    next=structuredClone(state);p=next.openPositions.find(x=>x.id===snapshot.id);p.markPriceUsd=price;if(price>Number(p.highestPrice||0))p.highestPrice=price;
    let stop=p.entryPrice*(1-HARD_STOP_PERCENT/100);if(p.tp1Done)stop=Math.max(stop,p.entryPrice*1.014);if(p.tp2Done||p.runnerTrailActive)stop=Math.max(stop,p.entryPrice*1.014,p.highestPrice*(1-RUNNER_TRAIL_PERCENT/100));p.stopPriceUsd=stop;commit(next);
    if(price<=stop){closePosition(p.id,price,p.tp2Done?"RUNNER TRAILING STOP 8%":"BREAKEVEN STOP");return;}
    if(now()-Date.parse(p.entryTime)>=MAX_HOLD_MS && pnlPercent<1)closePosition(p.id,price,"TIME STOP 45M UNDER +1%");
  }
  async function closeAllForReason(reason){const results=[];for(const p of structuredClone(state.openPositions)){try{const ticker=await getTicker(p.productId);results.push(closePosition(p.id,Number(ticker.price),reason));}catch(error){results.push({success:false,symbol:p.symbol,error:error.message});}}return results;}
  async function btcMarketSelloff(){try{const bars=await getCandles("BTC-USD");const closed=bars.filter(c=>c.time<Math.floor(now()/300_000)*300).slice(-13);if(closed.length<13)return false;const first=closed[0].close,last=closed[closed.length-1].close;const drop=first>0?(last/first-1)*100:0;const red=closed.slice(-4).filter(c=>c.close<c.open).length;return drop<=-2||(drop<=-1.5&&red>=3);}catch{return false;}}
  async function monitorOnce() {
    if(!state.running||monitoring||state.openPositions.length===0)return;monitoring=true;
    try{if(isEndOfDay()){await closeAllForReason("END OF DAY FLAT");return;} for(const snapshot of structuredClone(state.openPositions)){if(!state.running)break;try{const ticker=await getTicker(snapshot.productId),price=Number(ticker.price),bid=Number(ticker.bid),ask=Number(ticker.ask);if(!(price>0))continue;const mid=bid>0&&ask>0?(bid+ask)/2:0,spread=mid>0?(ask-bid)/mid*100:0;if(spread>MAX_EXIT_SPREAD_PERCENT){closePosition(snapshot.id,price,"LIQUIDITY SPREAD EXIT >0.6%");continue;}
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
      strategy:"Paper-only Coinbase spot trend trading on BTC, SOL, XRP and HYPE; no other listings. Entry requires an upward 1h trend, price above session VWAP, EMA9>EMA21, green pullback reclaim or breakout, and moderate volume confirmation. Exit 70% at +5%, 20% at +8%, and trail the remaining 10% by 8%; retain hard stop, spread, daily-loss, news and end-of-day safety controls. No live order execution.",
      startingBalance:state.startingBalanceUsd,startingBalanceUsd:state.startingBalanceUsd,cashBalance:state.cashUsd,equity,totalPnl,totalPnlPercent:state.startingBalanceUsd>0?totalPnl/state.startingBalanceUsd*100:0,nextTradeSizeUsd:state.nextEntryUsd,compoundIncrementPercent:COMPOUND_RATE*100,positionEquityFractionMin:MIN_POSITION_EQUITY_FRACTION,positionEquityFractionMax:MAX_POSITION_EQUITY_FRACTION,dailyLossLimitUsd:dailyLossLimitUsd(state),maxOpenPositions:MAX_OPEN_POSITIONS,estimatedFeePercentPerSide:FEE_RATE*100,estimatedSlippagePercentPerSide:SLIPPAGE_RATE*100,completedTrades,history:state.history,livePositions,openPositions:livePositions,rejections:state.rejections.slice(0,30),lastScanAt:state.lastScanAt,lastError:state.lastError,running:state.running,pausedForDailyLoss:state.pausedForDailyLoss,dailyPnlUsd:state.dailyPnlUsd,candidates:lastMarketScan.slice(0,15),news:news.getState(),dailyMoverUniverseSize:productCache.length};
  }
  return {start,stop,scanOnce,monitorOnce,buy,closePosition,closeAll,getStatus,getDashboardData,getState:()=>structuredClone(state),assessCandidate,file};
}
const instance=createOutcomeBot();
module.exports={createOutcomeBot,assessCandidate:(...a)=>instance.assessCandidate(...a),PRODUCTS,constants:{MAX_OPEN_POSITIONS,START_SIZE_USD,COMPOUND_RATE,HARD_STOP_PERCENT,TP1_PERCENT,TP2_PERCENT,RUNNER_TRAIL_PERCENT,MAX_HOLD_MS,DAILY_LOSS_FRACTION,MIN_POSITION_EQUITY_FRACTION,MAX_POSITION_EQUITY_FRACTION,MIN_DAILY_GAIN_PERCENT,MAX_DAILY_GAIN_PERCENT,MIN_DAILY_VOLUME_USD,MAX_SCAN_PRODUCTS,FEE_RATE,SLIPPAGE_RATE},...instance};
