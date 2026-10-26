const { getGeckoPools, getDexProfiles, getDexPairs, getPairDetails, getGeckoTokenQuote } = require("./geminiSources");
const { retry } = require("./geminiHttp");
const { evaluateCandidate } = require("./geminiFilter");
const { createExecutionVerifier } = require("./profitSniperExecutionQuote");
const { createGeminiLiveExecution, USDC } = require("./geminiLiveExecution");
const traderDefault = require("./geminiTrader");

const SCAN_MS = Number(process.env.GEMINI_SCAN_MS) || 30000;
const MONITOR_MS = Number(process.env.GEMINI_MONITOR_MS) || 3000;
const HARD_STOP = -8;
const MAX_SLIPPAGE_BPS = Math.min(1000, Math.max(200, Number(process.env.SLIPPAGE_BPS) || 300));
const MAX_DISCOVERY_CANDIDATES = 40;
const SELLABILITY_TIMEOUT_MS = 10_000;
// Exit-only guard: do not wait for an open pool to approach zero liquidity.
const MIN_EXIT_LIQUIDITY_USD = 3000;
const MAX_LIQUIDITY_DROP_FROM_ENTRY = 0.50;

function poolToCandidate(pool, pair) {
  const createdAt = pool.poolCreatedAt || pair?.pairCreatedAt || null;
  return {
    tokenAddress: pool.tokenAddress || pair?.baseToken?.address,
    pairAddress: pair?.pairAddress || pool.pairAddress,
    symbol: pair?.baseToken?.symbol || pool.symbol?.split("/")?.[0] || pool.symbol,
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
}function createGeminiBot({ trader = traderDefault, timers = globalThis, poolFetcher = getGeckoPools, profileFetcher = getDexProfiles, pairFetcher = getDexPairs, pairDetails = getPairDetails, tokenQuoteFallback = getGeckoTokenQuote, filter = evaluateCandidate, sellabilityCheck = createExecutionVerifier(), liveExecution = createGeminiLiveExecution() } = {}) {
  let lastMonitorAt = null, lastQuoteAt = null, lastQuoteFailureAt = null;
  const lastPriceByPositionId = new Map();
  let session = null, scanInterval = null, monitorInterval = null, busyScan = false, busyMonitor = false, lastError = null;
  const isActive = s => session === s && !s.controller.signal.aborted;
  async function verifyFullPositionExit(candidate, amountUsd, parentSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = timers.setTimeout ? timers.setTimeout(() => controller.abort(), SELLABILITY_TIMEOUT_MS) : setTimeout(() => controller.abort(), SELLABILITY_TIMEOUT_MS);
    try {
      const result = await sellabilityCheck(candidate, { amountUsd, signal: controller.signal });
      if (controller.signal.aborted && !parentSignal?.aborted)
        return { allowed: false, reason: "SELLABILITY_CHECK_TIMEOUT" };
      return result?.allowed ? result : { allowed: false, reason: result?.reason || "FULL_POSITION_EXIT_UNAVAILABLE", details: result };
    } catch (error) {
      return { allowed: false, reason: "FULL_POSITION_EXIT_UNAVAILABLE", details: { error: error.message } };
    } finally {
      parentSignal?.removeEventListener("abort", abort);
      if (timers.clearTimeout) timers.clearTimeout(timeout); else clearTimeout(timeout);
    }
  }
  async function candidateForPool(pool, signal) {
    let pairs = [];
    try { pairs = await pairFetcher(pool.tokenAddress, signal); }
    catch (error) { console.warn("[INFO] DexScreener token lookup failed", error.message); }
    const solanaPairs = pairs.filter(p => String(p?.chainId || "solana").toLowerCase() === "solana");
    const pair = pool.pairAddress
      ? solanaPairs.find(p => String(p.pairAddress).toLowerCase() === String(pool.pairAddress).toLowerCase())
        || solanaPairs.sort((a,b) => (Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0))[0]
      : solanaPairs.sort((a,b) => (Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0))[0];
    if (!pair) return poolToCandidate(pool, null);
    return poolToCandidate(pool, pair);
  }
  async function scan(s) {
    if (!isActive(s) || busyScan || trader.getState().position) return;
    busyScan = true;
    try {
      // GeckoTerminal supplies brand-new Solana pools while DexScreener profiles add
      // current discovery coverage. Every candidate is then resolved to its exact
      // PumpSwap pair before Gemini's existing safety gates can evaluate it.
      const [geckoResult, profileResult] = await Promise.allSettled([
        poolFetcher(s.controller.signal),
        profileFetcher(s.controller.signal)
      ]);
      const pools = [
        ...(geckoResult.status === "fulfilled" ? geckoResult.value : []),
        ...(profileResult.status === "fulfilled" ? profileResult.value : [])
      ];
      if (geckoResult.status === "rejected") console.warn("[INFO] Gemini GeckoTerminal discovery failed", geckoResult.reason?.message);
      if (profileResult.status === "rejected") console.warn("[INFO] Gemini DexScreener discovery failed", profileResult.reason?.message);
      const unique = new Map();
      for (const pool of pools) {
        if (pool.tokenAddress && !unique.has(pool.tokenAddress) && unique.size < MAX_DISCOVERY_CANDIDATES)
          unique.set(pool.tokenAddress, pool);
      }
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
          // This is deliberately the final entry gate. It checks the exact entry
          // size and confirms that the entire received token amount can be routed
          // back to USDC now. A failed or slow quote rejects only this candidate;
          // scanning immediately continues with the next one.
          const sizing = trader.getSizing?.();
          const liveReady = liveExecution.status().mode === "LIVE_READY";
          // Live execution has its own capped sizing cycle. Do not test a live
          // $5 order with the much larger paper-account sizing amount.
          const liveSizing = liveReady ? (trader.getLiveSizing?.() || { step: 0, amountUsd: 5 }) : null;
          const entryAmountUsd = liveSizing?.amountUsd ?? sizing?.amountUsd;
          const sellability = await verifyFullPositionExit(candidate, entryAmountUsd, s.controller.signal);
          if (!sellability.allowed) {
            trader.recordRejection(candidate, "Full Position Exit Unavailable", {
              reason: sellability.reason,
              sellability: sellability.details || sellability
            });
            continue;
          }
          candidate.geminiDetails = { ...result.details, executionQuote: sellability };
          candidate.slippageBps = slippageFor(candidate);
          let liveAmount;
          if (liveReady) {
            const liveRawAmount = Math.round(liveSizing.amountUsd * 1e6);
            const fill = await liveExecution.executeSwap({ inputMint: USDC, outputMint: candidate.tokenAddress, amount: liveRawAmount, slippageBps: candidate.slippageBps });
            candidate.liveExecution = { ...fill, executionMode: "LIVE", outputAmount: fill.actualOutputAmount || fill.quotedOutputAmount };
            candidate.liveSizing = liveSizing;
            liveAmount = liveSizing.amountUsd;
          }
          const buy = trader.buy(candidate, liveAmount);
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
      console.log("[INFO] Gemini scan complete", {
        geckoCandidates: geckoResult.status === "fulfilled" ? geckoResult.value.length : 0,
        dexProfileCandidates: profileResult.status === "fulfilled" ? profileResult.value.length : 0,
        uniqueTokens: unique.size,
        passed
      });
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
      let quotedPair = pair;
      const primaryLiquidityUsd = Number(pair?.liquidity?.usd);
      let price = Number(quotedPair?.priceUsd);
      if (!(price > 0) || !Number.isFinite(price)) {
        try {
          const pairs = await pairFetcher(p.tokenAddress, s.controller.signal);
          const selectedPair = pairs.sort((a,b)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0))[0] || null;
          quotedPair = selectedPair;
          price = Number(selectedPair?.priceUsd);
        } catch (error) { console.warn("[INFO] Gemini token quote failed; trying GeckoTerminal", error.message); }
      }
      let fallbackQuote = null;
      if (!(price > 0) || !Number.isFinite(price)) {
        try { fallbackQuote = await tokenQuoteFallback(p.tokenAddress, s.controller.signal); }
        catch (error) { console.warn("[INFO] Gemini GeckoTerminal quote failed", error.message); }
        price = Number(fallbackQuote?.priceUsd);
      }
      const quotedLiquidityUsd = Number(quotedPair?.liquidity?.usd);
      // Preserve an explicit zero from the original pair even if an alternate
      // lookup has no pair to return.
      const liquidityUsd = Number.isFinite(quotedLiquidityUsd) ? quotedLiquidityUsd : primaryLiquidityUsd;
      const hasConfirmedZeroLiquidity = Number.isFinite(liquidityUsd) && liquidityUsd <= 0;
      const latest = trader.getState().position;
      if (!latest || latest.id !== p.id) return;
      // A reported zero is materially different from a temporarily missing
      // quote.  Paper trading must realize this as a full loss and release the
      // single Gemini slot; otherwise it can remain stuck forever.
      if (hasConfirmedZeroLiquidity) {
        if (latest.liveExecution?.executionMode === "LIVE") {
          // In live mode do not fabricate a sale.  Attempt the real swap; a
          // failed swap leaves the actual asset open rather than hiding it.
          const raw = latest.liveExecution?.outputAmount;
          if (!/^\d+$/.test(String(raw || ""))) throw new Error("Live position has no confirmed token amount.");
          const fill = await liveExecution.executeSwap({ inputMint: latest.tokenAddress, outputMint: USDC, amount: raw, slippageBps: MAX_SLIPPAGE_BPS, purpose: "exit" });
          const out = Number(fill.actualOutputAmount);
          if (!Number.isFinite(out) || out < 0) throw new Error("Live exit lacks confirmed USDC output.");
          return trader.sell((out / 1e6) / latest.quantity, 100, "LIQUIDITY COLLAPSE EXIT — ZERO LIQUIDITY", { ...fill, actualOutputAmount: String(out) });
        }
        return trader.writeOff("LIQUIDITY COLLAPSE EXIT — ZERO LIQUIDITY");
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
      const entryLiquidityUsd = Number(latest.entryDetails?.liquidityUsd);
      const exitLiquidityFloorUsd = Number.isFinite(entryLiquidityUsd) && entryLiquidityUsd > 0
        ? Math.max(MIN_EXIT_LIQUIDITY_USD, entryLiquidityUsd * (1 - MAX_LIQUIDITY_DROP_FROM_ENTRY))
        : MIN_EXIT_LIQUIDITY_USD;
      lastPriceByPositionId.set(latest.id, price);
      if (fallbackQuote?.pairAddress && fallbackQuote.pairAddress !== latest.pairAddress) {
        trader.updatePosition?.({ ...latest, pairAddress: fallbackQuote.pairAddress });
      }
      if (price > latest.highestPrice) {
        const state = trader.getState();
        state.position.highestPrice = price;
        trader.updatePosition?.(state.position);
      }
      // Exit while a quote and meaningful liquidity still exist, rather than
      // allowing this one-position bot to be trapped at near-zero liquidity.
      const close = async reason => {
        if (latest.liveExecution?.executionMode !== "LIVE") return trader.sell(price, 100, reason);
        const raw = latest.liveExecution?.outputAmount;
        if (!/^\d+$/.test(String(raw || ""))) throw new Error("Live position has no confirmed token amount.");
        const fill = await liveExecution.executeSwap({ inputMint: latest.tokenAddress, outputMint: USDC, amount: raw, slippageBps: MAX_SLIPPAGE_BPS, purpose: "exit" });
        const out = Number(fill.actualOutputAmount);
        if (!Number.isFinite(out) || out < 0) throw new Error("Live exit lacks confirmed USDC output.");
        return trader.sell((out / 1e6) / latest.quantity, 100, reason, { ...fill, actualOutputAmount: String(out) });
      };
      if (Number.isFinite(liquidityUsd) && liquidityUsd > 0 && liquidityUsd < exitLiquidityFloorUsd) {
        await close("LIQUIDITY COLLAPSE EXIT");
        return;
      }
      if (price <= latest.entryPrice * (1 + HARD_STOP / 100)) { await close("HARD STOP -8%"); return; }
      if (price >= latest.entryPrice * 1.15) {
        await close("TP +15% FULL EXIT");
        return;
      }
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
    console.log("[INFO] Gemini Bot started in PAPER mode; sell 100% at +15%; stop -8%; sizing 10% / 12.5% of cash.");
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
