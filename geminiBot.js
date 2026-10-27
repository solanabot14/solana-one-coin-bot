const { getGeckoPools, getDexProfiles, getCanonicalPumpSwapPools, getDexPairs, getDexPairsBatch, getPairDetails, getGeckoTokenQuote } = require("./geminiSources");
const { retry } = require("./geminiHttp");
const { evaluateCandidate } = require("./geminiFilter");
const { createExecutionVerifier } = require("./profitSniperExecutionQuote");
const { createGeminiLiveExecution, USDC } = require("./geminiLiveExecution");
const traderDefault = require("./geminiTrader");
const { randomUUID } = require("node:crypto");
const { getTelegramConfig, sendGeminiBuyAlert, startTelegramBuyPolling } = require("./telegram");

const SCAN_MS = Number(process.env.GEMINI_SCAN_MS) || 30000;
const MONITOR_MS = Number(process.env.GEMINI_MONITOR_MS) || 3000;
const HARD_STOP = -8;
const MAX_SLIPPAGE_BPS = Math.min(1000, Math.max(200, Number(process.env.SLIPPAGE_BPS) || 300));
const MAX_DISCOVERY_CANDIDATES = 40;
const SELLABILITY_TIMEOUT_MS = 10_000;
// Exit-only guard: do not wait for an open pool to approach zero liquidity.
const MIN_EXIT_LIQUIDITY_USD = 3000;
const MAX_LIQUIDITY_DROP_FROM_ENTRY = 0.50;
const BUY_SIGNAL_TTL_MS = 300_000;

function poolToCandidate(pool, pair) {
  const createdAt = pool.poolCreatedAt || pair?.pairCreatedAt || null;
  return {
    tokenAddress: pool.tokenAddress || pair?.baseToken?.address,
    pairAddress: pool.pairAddress || pair?.pairAddress || null,
    exactPoolVerified: pool.canonicalPoolVerified === true && Boolean(pool.pairAddress),
    canonicalPoolFailureReason: pool.canonicalPoolFailureReason || null,
    symbol: pair?.baseToken?.symbol || pool.symbol?.split("/")?.[0] || pool.symbol,
    name: pair?.baseToken?.name || pool.symbol,
    priceUsd: Number(pair?.priceUsd ?? pool.priceUsd),
    priceChange5m: Number(pair?.priceChange?.m5 ?? pool.priceChange5m),
    liquidityUsd: Number(pair?.liquidity?.usd ?? pool.liquidityUsd),
    poolCreatedAt: createdAt,
    buys5m: Number(pair?.txns?.m5?.buys ?? pool.buys5m),
    sells5m: Number(pair?.txns?.m5?.sells ?? pool.sells5m),
    volume5m: Number(pair?.volume?.m5 ?? pool.volume5m),
    dexId: pool.canonicalPoolVerified ? "pumpswap" : pair?.dexId || pool.source,
    url: pair?.url || null
  };
}
function slippageFor(pair) {
  const tx = (Number(pair?.txns?.m5?.buys) || 0) + (Number(pair?.txns?.m5?.sells) || 0);
  const change = Math.abs(Number(pair?.priceChange?.m5) || 0);
  return Math.min(1000, Math.max(200, 200 + Math.round(change * 20) + Math.max(0, 15 - tx) * 20));
}function createGeminiBot({ trader = traderDefault, timers = globalThis, poolFetcher = getGeckoPools, profileFetcher = getDexProfiles, pairBatchFetcher = getDexPairsBatch, pairFetcher = getDexPairs, pairDetails = getPairDetails, tokenQuoteFallback = getGeckoTokenQuote, filter = evaluateCandidate, sellabilityCheck = createExecutionVerifier({ maxQuotedRoundTripCostPercent: 3.70, maxRoundTripLossPercent: 4.7 }), liveExecution = createGeminiLiveExecution() } = {}) {
  let lastMonitorAt = null, lastQuoteAt = null, lastQuoteFailureAt = null;
  const lastPriceByPositionId = new Map();
  const liquiditySnapshots = new Map();
  let session = null, scanInterval = null, monitorInterval = null, busyScan = false, busyMonitor = false, busyTelegramBuy = false, telegramPollingStop = null, lastError = null;
  const pendingBuySignals = new Map();
  function observeLiquidityTrend(candidate) {
    const pairAddress = String(candidate.pairAddress || "").toLowerCase();
    const liquidityUsd = Number(candidate.liquidityUsd);
    if (!pairAddress || !Number.isFinite(liquidityUsd) || liquidityUsd < 0) return "Unavailable";
    const now = Date.now();
    for (const [key, snapshot] of liquiditySnapshots) {
      if (now - snapshot.at > 5 * 60_000) liquiditySnapshots.delete(key);
    }
    const previous = liquiditySnapshots.get(pairAddress);
    liquiditySnapshots.set(pairAddress, { liquidityUsd, at: now });
    while (liquiditySnapshots.size > 500) liquiditySnapshots.delete(liquiditySnapshots.keys().next().value);
    if (!previous || now - previous.at > 5 * 60_000) return "No prior reading";
    if (liquidityUsd > previous.liquidityUsd) return "Rising since last scan";
    if (liquidityUsd < previous.liquidityUsd) return "Falling since last scan";
    return "Stable since last scan";
  }
  const isActive = s => session === s && !s.controller.signal.aborted;

  async function closeForLiquidity(position, price, reason) {
    if (position.liveExecution?.executionMode === "LIVE") {
      const raw = position.liveExecution?.outputAmount;
      if (!/^\d+$/.test(String(raw || ""))) throw new Error("Live position has no confirmed token amount.");
      const fill = await liveExecution.executeSwap({ inputMint: position.tokenAddress, outputMint: USDC, amount: raw, slippageBps: MAX_SLIPPAGE_BPS, purpose: "exit" });
      const out = Number(fill.actualOutputAmount);
      if (!Number.isFinite(out) || out < 0) throw new Error("Live exit lacks confirmed USDC output.");
      return trader.sell((out / 1e6) / position.quantity, 100, reason, { ...fill, actualOutputAmount: String(out) });
    }
    const currentPrice = Number(price);
    const lastKnownPrice = Number(lastPriceByPositionId.get(position.id));
    const exitPrice = currentPrice > 0 && Number.isFinite(currentPrice) ? currentPrice : lastKnownPrice;
    if (exitPrice > 0 && Number.isFinite(exitPrice))
      return trader.sell(exitPrice, 100, reason + (currentPrice > 0 ? "" : " — LAST OBSERVED PRICE"));
    return trader.writeOff(reason + " — NO PRICE AVAILABLE");
  }
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
  function candidateForPool(pool, canonicalPools) {
    const validation = canonicalPools.get(String(pool.pairAddress || "").toLowerCase());
    return poolToCandidate({
      ...pool,
      canonicalPoolVerified: validation?.verified === true,
      canonicalPoolFailureReason: validation?.reason || null
    }, null);
  }
  function pruneBuySignals() {
    const now = Date.now();
    for (const [id, signal] of pendingBuySignals) {
      if (now >= signal.expiresAt) pendingBuySignals.delete(id);
    }
  }
  async function handleTelegramBuy(signalId) {
    if (busyTelegramBuy) return { success: false, message: "Gemini is already processing a Telegram buy." };
    const signal = pendingBuySignals.get(String(signalId));
    if (!signal || Date.now() >= signal.expiresAt) {
      pendingBuySignals.delete(String(signalId));
      return { success: false, message: "That Gemini signal expired. Wait for a fresh alert." };
    }
    pendingBuySignals.delete(String(signalId));
    const s = session;
    if (!isActive(s)) return { success: false, message: "Gemini is stopped; no order was placed." };
    if (trader.getState().position) return { success: false, message: "Gemini already has an open position; no order was placed." };
    busyTelegramBuy = true;
    try {
      const original = signal.candidate;
      const pair = await pairDetails(original.pairAddress, s.controller.signal);
      if (!isActive(s) || !pair || pair.baseToken?.address !== original.tokenAddress ||
          String(pair.pairAddress || "").toLowerCase() !== String(original.pairAddress || "").toLowerCase() ||
          String(pair.dexId || "").toLowerCase() !== "pumpswap") {
        return { success: false, message: "The signal's exact PumpSwap pool could not be reverified; no order was placed." };
      }
      const canonical = await getCanonicalPumpSwapPools([{
        tokenAddress: original.tokenAddress, pairAddress: original.pairAddress
      }], s.controller.signal);
      const verification = canonical.get(String(original.pairAddress).toLowerCase());
      if (!verification?.verified) return { success: false, message: "PumpSwap pool verification failed; no order was placed." };
      const candidate = poolToCandidate({
        tokenAddress: original.tokenAddress,
        pairAddress: original.pairAddress,
        canonicalPoolVerified: true,
        poolCreatedAt: original.poolCreatedAt
      }, pair);
      if (!(candidate.priceUsd > 0)) return { success: false, message: "A fresh price is unavailable; no order was placed." };
      const check = await filter(candidate, { signal: s.controller.signal });
      if (!check?.accepted) return { success: false, message: "The coin no longer passes Gemini's entry filters; no order was placed." };
      const liveSizing = trader.getLiveSizing?.() || { step: 0, amountUsd: 2 };
      const amountUsd = Number(liveSizing.amountUsd);
      if (!(amountUsd > 0) || Number(trader.getState().cashUsd) < amountUsd)
        return { success: false, message: "Gemini's managed account cannot reserve the current live-cycle size; no order was placed." };
      const sellability = await verifyFullPositionExit(candidate, amountUsd, s.controller.signal);
      if (!sellability.allowed) {
        const reason = String(sellability.reason || "FULL_POSITION_EXIT_UNAVAILABLE");
        const details = sellability.details || {};
        const quotedCost = Number(details.quotedCostPercent);
        const maxCost = Number(details.maximumQuotedCostPercent);
        const costNote = Number.isFinite(quotedCost) && Number.isFinite(maxCost)
          ? " Quoted round-trip cost: " + quotedCost.toFixed(2) + "%; allowed maximum: " + maxCost.toFixed(2) + "%."
          : "";
        console.warn("[INFO] Gemini Telegram manual buy blocked by exit-route check", {
          symbol: candidate.symbol, reason, details: sellability.details || null
        });
        return { success: false, message: "Safety check blocked this buy: " + reason + "." + costNote + " No order was placed." };
      }
      candidate.geminiDetails = { ...check.details, executionQuote: sellability };
      candidate.slippageBps = slippageFor(pair);
      const fill = await liveExecution.executeManualEntry({
        outputMint: candidate.tokenAddress,
        amountUsd,
        slippageBps: candidate.slippageBps
      });
      candidate.liveExecution = {
        ...fill,
        executionMode: "LIVE",
        outputAmount: fill.actualOutputAmount || fill.quotedOutputAmount
      };
      candidate.liveSizing = liveSizing;
      const buy = trader.buy(candidate, amountUsd);
      if (!buy.success) {
        console.error("[CRITICAL] Gemini Telegram buy executed but could not be recorded", candidate.tokenAddress, buy.error);
        return { success: false, message: "The swap executed, but Gemini could not record it. Check the wallet and Live Execution Audit immediately." };
      }
      console.log("[INFO] Gemini Telegram manual live entry", {
        symbol: candidate.symbol, mint: candidate.tokenAddress, tradeSizeUsd: amountUsd,
        signature: fill.signature
      });
      return {
        success: true,
        message: "GEMINI BUY CONFIRMED | " + candidate.symbol + " | $" + amountUsd.toFixed(2) +
          " | Gemini is monitoring exits at +15%, -8%, and the liquidity guard. Signature: " + fill.signature
      };
    } catch (error) {
      return { success: false, message: "Gemini could not complete that buy: " + String(error.message || error).slice(0, 220) };
    } finally { busyTelegramBuy = false; }
  }
  function startTelegramBuyAlerts() {
    if (telegramPollingStop) return { started: true, alreadyRunning: true };
    const config = getTelegramConfig();
    if (!config.enabled) return { started: false, reason: "Telegram is not configured." };
    telegramPollingStop = startTelegramBuyPolling(handleTelegramBuy);
    return { started: true };
  }
  function stopTelegramBuyAlerts() {
    if (telegramPollingStop) telegramPollingStop();
    telegramPollingStop = null;
  }
  async function scan(s) {
    pruneBuySignals();
    if (!isActive(s) || busyScan || trader.getState().position || pendingBuySignals.size > 0) return;
    busyScan = true;
    try {
      // Discover new pools from GeckoTerminal and use DexScreener profiles as a
      // batched fallback. Only exact, on-chain verified PumpSwap pools can proceed.
      const [geckoResult, profileResult] = await Promise.allSettled([
        poolFetcher(s.controller.signal),
        profileFetcher(s.controller.signal)
      ]);
      const geckoPools = geckoResult.status === "fulfilled" && Array.isArray(geckoResult.value) ? geckoResult.value : [];
      const profiles = profileResult.status === "fulfilled" && Array.isArray(profileResult.value) ? profileResult.value : [];
      if (geckoResult.status === "rejected") console.warn("[INFO] Gemini GeckoTerminal discovery failed", geckoResult.reason?.message);
      if (profileResult.status === "rejected") console.warn("[INFO] Gemini DexScreener discovery failed", profileResult.reason?.message);
      let dexPools = [];
      if (profiles.length) {
        try {
          const pairs = await pairBatchFetcher(profiles.slice(0, 30).map(profile => profile.tokenAddress), s.controller.signal);
          dexPools = (Array.isArray(pairs) ? pairs : []).filter(pair =>
            String(pair.dexId || "").toLowerCase() === "pumpswap" &&
            profiles.some(profile => profile.tokenAddress === pair.baseToken?.address)
          ).map(pair => ({
            tokenAddress: pair.baseToken.address,
            pairAddress: pair.pairAddress,
            symbol: pair.baseToken.symbol || "Unknown",
            poolCreatedAt: pair.pairCreatedAt ? new Date(Number(pair.pairCreatedAt)).toISOString() : null,
            liquidityUsd: Number(pair.liquidity?.usd) || 0,
            priceUsd: Number(pair.priceUsd) || 0,
            priceChange5m: Number(pair.priceChange?.m5),
            volume5m: Number(pair.volume?.m5) || 0,
            buys5m: Number(pair.txns?.m5?.buys) || 0,
            sells5m: Number(pair.txns?.m5?.sells) || 0,
            source: "DexScreener"
          })).filter(pool => pool.pairAddress);
        } catch (error) { console.warn("[INFO] Gemini DexScreener batch lookup failed", error.message); }
      }
      const pools = [...geckoPools, ...dexPools];
      let canonicalPools = new Map();
      if (pools.length) {
        try { canonicalPools = await getCanonicalPumpSwapPools(pools, s.controller.signal); }
        catch (error) { console.warn("[INFO] Gemini canonical pool check failed", error.message); }
      }
      // Prefer a verified pool for a mint when both feeds report multiple pools.
      const prioritizedPools = [...pools].sort((left, right) => {
        const leftVerified = canonicalPools.get(String(left.pairAddress || "").toLowerCase())?.verified === true;
        const rightVerified = canonicalPools.get(String(right.pairAddress || "").toLowerCase())?.verified === true;
        return Number(rightVerified) - Number(leftVerified);
      });
      const unique = new Map();
      for (const pool of prioritizedPools) {
        if (pool.tokenAddress && !unique.has(pool.tokenAddress) && unique.size < MAX_DISCOVERY_CANDIDATES)
          unique.set(pool.tokenAddress, pool);
      }
      let passed = 0;
      for (const pool of unique.values()) {
        if (!isActive(s) || trader.getState().position) break;
        try {
          const candidate = candidateForPool(pool, canonicalPools);
          candidate.liquidityTrend = observeLiquidityTrend(candidate);
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
          const liveSizing = trader.getLiveSizing?.() || { step: 0, amountUsd: 2 };
          const sellability = await verifyFullPositionExit(candidate, liveSizing.amountUsd, s.controller.signal);
          if (!sellability.allowed) {
            trader.recordRejection(candidate, "Full Position Exit Unavailable", {
              reason: sellability.reason,
              sellability: sellability.details || sellability
            });
            continue;
          }
          candidate.geminiDetails = { ...result.details, executionQuote: sellability };
          candidate.slippageBps = slippageFor(candidate);
          if (!getTelegramConfig().enabled) {
            trader.recordRejection(candidate, "Telegram Manual Signal Unavailable", {
              reason: "Gemini manual-live mode requires Telegram configuration."
            });
            continue;
          }
          // Manual-live signal mode never opens paper positions or automatic live entries.
          // Only an authorized Telegram Buy tap can authorize this individual live order.
          const signalId = randomUUID();
          pendingBuySignals.set(signalId, {
            candidate: structuredClone(candidate),
            expiresAt: Date.now() + BUY_SIGNAL_TTL_MS
          });
          const alert = await sendGeminiBuyAlert(signalId, candidate, liveSizing.amountUsd);
          if (!alert.sent) {
            pendingBuySignals.delete(signalId);
            trader.recordRejection(candidate, "Telegram Buy Alert Delivery Failed", { reason: alert.reason });
            continue;
          }
          console.log("[INFO] Gemini Telegram manual-live buy signal sent", {
            symbol: candidate.symbol, mint: candidate.tokenAddress,
            amountUsd: liveSizing.amountUsd, liquidityTrend: candidate.liquidityTrend, expiresInMs: BUY_SIGNAL_TTL_MS
          });
          break;
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
        dexProfileCandidates: profiles.length,
        dexPairCandidates: dexPools.length,
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

      // Act on the exact held pair's liquidity before waiting on alternate price sources.
      // The collapse threshold remains the existing max($3,000, 50% of entry liquidity).
      const entryLiquidityAtStart = Number(p.entryDetails?.liquidityUsd);
      const exitLiquidityFloorAtStart = Number.isFinite(entryLiquidityAtStart) && entryLiquidityAtStart > 0
        ? Math.max(MIN_EXIT_LIQUIDITY_USD, entryLiquidityAtStart * (1 - MAX_LIQUIDITY_DROP_FROM_ENTRY))
        : MIN_EXIT_LIQUIDITY_USD;
      if (Number.isFinite(primaryLiquidityUsd) && primaryLiquidityUsd <= exitLiquidityFloorAtStart) {
        const reason = primaryLiquidityUsd <= 0
          ? "LIQUIDITY COLLAPSE EXIT — ZERO LIQUIDITY"
          : "LIQUIDITY COLLAPSE EXIT";
        console.warn("[INFO] Gemini immediate liquidity-collapse exit", {
          symbol: p.symbol, liquidityUsd: primaryLiquidityUsd, thresholdUsd: exitLiquidityFloorAtStart
        });
        await closeForLiquidity(p, Number(pair?.priceUsd), reason);
        return;
      }
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
    console.log("[INFO] Gemini Bot started in Telegram signal mode; a personal BUY tap is required for live entries; exits remain +15%, -8%, and the liquidity guard.");
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
  return { start, stop, startTelegramBuyAlerts, stopTelegramBuyAlerts, handleTelegramBuy, getStatus: () => !!session, getLastError: () => lastError, lastKnownPrice: positionId => lastPriceByPositionId.get(positionId) || 0, getDiagnostics: () => ({ lastMonitorAt, lastQuoteAt, lastQuoteFailureAt, lastScanAt: trader.getState().lastScanAt, activity: trader.getState().position ? "MONITORING POSITION" : pendingBuySignals.size ? "TELEGRAM BUY SIGNAL PENDING" : "SCANNING" }), scan: () => scan(session), monitor: () => monitor(session) };
}
module.exports = { createGeminiBot, ...createGeminiBot() };
