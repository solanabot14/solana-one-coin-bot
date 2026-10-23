const { getGeckoPools, getDexProfiles, getDexPairs, getPairDetails, getGeckoTokenQuote } = require("./geminiSources");
const { retry } = require("./geminiHttp");
const { evaluateCandidate } = require("./geminiFilter");
const traderDefault = require("./geminiTrader");

const SCAN_MS = Number(process.env.GEMINI_SCAN_MS) || 30000;
const MONITOR_MS = Number(process.env.GEMINI_MONITOR_MS) || 3000;
const HARD_STOP = -8;
const MAX_SLIPPAGE_BPS = Math.min(1000, Math.max(200, Number(process.env.SLIPPAGE_BPS) || 300));

function poolToCandidate(pool, pair) {
  const createdAt = pool.poolCreatedAt || pair?.pairCreatedAt || null;
  return {
    tokenAddress: pool.tokenAddress || pair?.baseToken?.address,
    pairAddress: pool.pairAddress || pair?.pairAddress,
    symbol: pair?.baseToken?.symbol || pool.symbol?.split("/")[0] || pool.symbol,
    name: pair?.baseToken?.name || pool.symbol,
    priceUsd: Number(pair?.priceUsd ?? pool.priceUsd),
    priceChange5m: Number(pair?.priceChange?.m5 ?? pool.priceChange5m),
    liquidityUsd: Number(pair?.liquidity?.usd ?? pool.liquidityUsd),
    poolCreatedAt: createdAt,
    buys5m: Number(pair?.txns?.m5?.buys ?? pool.buys5m),
    sells5m: Number(pair?.txns?.m5?.sells ?? pool.sells5m),
    volume5m: Number(pair?.volume?.m5 ?? pool.volume5m),
    dexId: pair?.dexId || pool.source,
    url: pair?.url || null
  };
}
function slippageFor(pair) {
  const tx = (Number(pair?.txns?.m5?.buys) || 0) + (Number(pair?.txns?.m5?.sells) || 0);
  const change = Math.abs(Number(pair?.priceChange?.m5) || 0);
  return Math.min(1000, Math.max(200, 200 + Math.round(change * 20) + Math.max(0, 15 - tx) * 20));
}
function createGeminiBot({ trader = traderDefault, timers = globalThis, poolFetcher = getGeckoPools, profileFetcher = getDexProfiles, pairFetcher = getDexPairs, pairDetails = getPairDetails, tokenQuoteFallback = getGeckoTokenQuote, filter = evaluateCandidate } = {}) {
  let lastMonitorAt = null, lastQuoteAt = null, lastQuoteFailureAt = null;
  const lastPriceByPositionId = new Map();
  let session = null, scanInterval = null, monitorInterval = null, busyScan = false, busyMonitor = false, lastError = null;
  const isActive = s => session === s && !s.controller.signal.aborted;
  async function candidateForPool(pool, signal) {
    let pairs = [];
    try { pairs = await pairFetcher(pool.tokenAddress, signal); }
    catch (error) { console.warn("[INFO] DexScreener token lookup failed", error.message); }
    const pair = pool.pairAddress
      ? pairs.find(p => String(p.pairAddress).toLowerCase() === String(pool.pairAddress).toLowerCase())
      : pairs.sort((a,b) => (Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0))[0];
    if (!pair) return poolToCandidate(pool, null);
    return poolToCandidate(pool, pair);
  }
  async function scan(s) {
    if (!isActive(s) || busyScan || trader.getState().position) return;
    busyScan = true;
    try {
      const pools = await poolFetcher(s.controller.signal);
      const unique = new Map();
      for (const pool of pools) if (pool.tokenAddress && !unique.has(pool.tokenAddress)) unique.set(pool.tokenAddress, pool);
      let passed = 0;
      for (const pool of unique.values()) {
        if (!isActive(s) || trader.getState().position) break;
        try {
          const candidate = await candidateForPool(pool, s.controller.signal);
          if (!(candidate.priceUsd > 0)) {
            trader.recordRejection(candidate, "Price Unavailable");
            continue;
          }
          const result = await filter(candidate, { signal: s.controller.signal });
          if (!result.accepted) {
            trader.recordRejection(candidate, result.reason, result.details);
            continue;
          }
          passed++;
          candidate.geminiDetails = result.details;
          candidate.slippageBps = slippageFor(candidate);
          const buy = trader.buy(candidate);
          if (buy.success) {
            console.log("[INFO] Gemini paper entry", { symbol: candidate.symbol, mint: candidate.tokenAddress, pair: candidate.pairAddress, liquidityUsd: candidate.liquidityUsd, priceChange5m: candidate.priceChange5m, slippageBps: candidate.slippageBps, tradeSizeUsd: buy.position.originalCostUsd, sizingPercent: buy.position.sizingPercent });
            break;
          }
          trader.recordRejection(candidate, buy.error);
        } catch (error) {
          if (isActive(s)) {
            trader.recordRejection(pool, "Candidate Evaluation Error", { error: error.message });
            console.error("[INFO] Gemini candidate error", pool.tokenAddress, error.message);
          }
        }
      }
      lastError = null;
      trader.setScanTime();
      console.log("[INFO] Gemini scan complete", { uniqueTokens: unique.size, passed });
    } catch (error) {
      if (isActive(s)) {
        lastError = error.message;
        console.error("[INFO] Gemini scan failed", error.message);
      }
    } finally { busyScan = false; }
  }
  async function monitor(s) {
    if (!isActive(s) || busyMonitor) return;
    busyMonitor = true;
    try {
      lastMonitorAt = new Date().toISOString();
      const p = trader.getState().position;
      if (!p) return;
      let pair = null;
      if (p.pairAddress) {
        try { pair = await pairDetails(p.pairAddress, s.controller.signal); }
        catch (error) { console.warn("[INFO] Gemini pair quote failed; trying alternate sources", error.message); }
      }
      let price = Number(pair?.priceUsd);
      if (!(price > 0) || !Number.isFinite(price)) {
        try {
          const pairs = await pairFetcher(p.tokenAddress, s.controller.signal);
          const selectedPair = pairs.sort((a,b)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0))[0] || null;
          price = Number(selectedPair?.priceUsd);
        } catch (error) { console.warn("[INFO] Gemini token quote failed; trying GeckoTerminal", error.message); }
      }
      let fallbackQuote = null;
      if (!(price > 0) || !Number.isFinite(price)) {
        try { fallbackQuote = await tokenQuoteFallback(p.tokenAddress, s.controller.signal); }
        catch (error) { console.warn("[INFO] Gemini GeckoTerminal quote failed", error.message); }
        price = Number(fallbackQuote?.priceUsd);
      }
      if (!isActive(s) || !Number.isFinite(price) || price <= 0) {
        const now = Date.now();
        if (isActive(s) && (!lastQuoteFailureAt || now - lastQuoteFailureAt > 60_000)) {
          lastQuoteFailureAt = now;
          console.warn("[INFO] Gemini position has no quote from DexScreener or GeckoTerminal; keeping position open", p.symbol, p.tokenAddress);
        }
        return;
      }
      lastQuoteAt = new Date().toISOString();
      lastError = null;
      const latest = trader.getState().position;
      if (!latest || latest.id !== p.id) return;
      lastPriceByPositionId.set(latest.id, price);
      if (fallbackQuote?.pairAddress && fallbackQuote.pairAddress !== latest.pairAddress) {
        trader.updatePosition?.({ ...latest, pairAddress: fallbackQuote.pairAddress });
      }
      if (price > latest.highestPrice) {
        const state = trader.getState();
        state.position.highestPrice = price;
        // Persist by replacing state through the small state mutation endpoint below.
        trader.updatePosition?.(state.position);
      }
      const pnl = (price / latest.entryPrice - 1) * 100;
      const ageMs = Date.now() - Date.parse(latest.entryTime);
      if (price <= latest.entryPrice * (1 + HARD_STOP / 100)) { trader.sell(price, 100, "HARD STOP -8%"); return; }
      if (price >= latest.entryPrice * 1.20) { trader.sell(price, 100, "TP +20% FULL EXIT"); return; }
      if (ageMs >= 15 * 60 * 1000 && pnl >= -5 && pnl <= 10) trader.sell(price, 100, "TIME EXIT 15M");
    } catch (error) {
      if (isActive(s)) { lastError = error.message; console.error("[INFO] Gemini monitor failed", error.message); }
    } finally { busyMonitor = false; }
  }
  function start() {
    if (session) return;
    trader.getState();
    lastError = null;
    const s = { controller: new AbortController() };
    session = s;
    console.log("[INFO] Gemini Bot started in PAPER mode; TP +20% full exit; stop -8%; sizing 10% / 12.5% of cash.");
    scanInterval = timers.setInterval(() => void scan(s), SCAN_MS);
    monitorInterval = timers.setInterval(() => void monitor(s), MONITOR_MS);
    void scan(s); void monitor(s);
  }
  function stop() {
    if (!session) return;
    session.controller.abort(); session = null;
    timers.clearInterval(scanInterval); timers.clearInterval(monitorInterval);
    scanInterval = monitorInterval = null;
    console.log("[INFO] Gemini Bot stopped; saved paper position retained.");
  }
  return { start, stop, getStatus: () => !!session, getLastError: () => lastError, lastKnownPrice: positionId => lastPriceByPositionId.get(positionId) || 0, getDiagnostics: () => ({ lastMonitorAt, lastQuoteAt, lastQuoteFailureAt, lastScanAt: trader.getState().lastScanAt, activity: trader.getState().position ? "MONITORING POSITION" : "SCANNING" }), scan: () => scan(session), monitor: () => monitor(session) };
}
module.exports = { createGeminiBot, ...createGeminiBot() };

