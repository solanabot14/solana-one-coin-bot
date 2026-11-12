const { getGeckoPools, getDexProfiles, getCanonicalPumpSwapPools, getDexPairs, getDexPairsBatch, getPairDetails, getGeckoTokenQuote } = require("./geminiSources");
const { retry } = require("./geminiHttp");
const { evaluateCandidate, MIN_POOL_AGE_MS, MAX_POOL_AGE_MS } = require("./geminiFilter");
const { createExecutionVerifier } = require("./profitSniperExecutionQuote");
const { createGeminiLiveExecution, USDC } = require("./geminiLiveExecution");
const geminiLiveControl = require("./geminiLiveControl");
const traderDefault = require("./geminiTrader");
const { randomUUID } = require("node:crypto");
const { getTelegramConfig, sendGeminiBuyAlert, startTelegramBuyPolling } = require("./telegram");

const SCAN_MS = Number(process.env.GEMINI_SCAN_MS) || 30000;
const MONITOR_MS = Number(process.env.GEMINI_MONITOR_MS) || 3000;
const HARD_STOP = -15;
const MAX_SLIPPAGE_BPS = Math.min(1000, Math.max(200, Number(process.env.SLIPPAGE_BPS) || 300));
const MAX_DISCOVERY_CANDIDATES = 80;
const SELLABILITY_TIMEOUT_MS = 10_000;
// Exit-only guard: do not wait for an open pool to approach zero liquidity.
const MIN_EXIT_LIQUIDITY_USD = 3000;
const MAX_LIQUIDITY_DROP_FROM_ENTRY = 0.25;
const BUY_SIGNAL_TTL_MS = 300_000;
const SECOND_PUMP_SETUP_TTL_MS = 20 * 60_000;
const SECOND_PUMP_READY_TTL_MS = 90_000;
const SECOND_PUMP_MIN_PULLBACK = 0.06;
const SECOND_PUMP_MAX_PULLBACK = 0.25;
const SECOND_PUMP_REBOUND = 0.04;
const SECOND_PUMP_RECLAIM = 0.90;

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
  const priceSnapshots = new Map();
  let session = null, scanInterval = null, monitorInterval = null, busyScan = false, busyMonitor = false, busyTelegramBuy = false, telegramPollingStop = null, lastError = null;
  let scanSequence = 0;
  const secondPumpSetups = new Map();
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
  function observePriceTrend(candidate) {
    const pairAddress = String(candidate.pairAddress || "").toLowerCase();
    const priceUsd = Number(candidate.priceUsd);
    if (!pairAddress || !(priceUsd > 0) || !Number.isFinite(priceUsd)) return "Unavailable";
    const now = Date.now();
    for (const [key, snapshot] of priceSnapshots) {
      if (now - snapshot.at > 5 * 60_000) priceSnapshots.delete(key);
    }
    const previous = priceSnapshots.get(pairAddress);
    priceSnapshots.set(pairAddress, { priceUsd, at: now });
    while (priceSnapshots.size > 500) priceSnapshots.delete(priceSnapshots.keys().next().value);
    if (!previous || now - previous.at > 5 * 60_000) return "No prior reading";
    return priceUsd < previous.priceUsd ? "Falling since last scan" : "Not falling since last scan";
  }
  function secondPumpKey(candidate) {
    return [
      String(candidate.tokenAddress || "").toLowerCase(),
      String(candidate.pairAddress || "").toLowerCase()
    ].join(":");
  }
  function updateSecondPumpSetup(candidate, currentScan) {
    const key = secondPumpKey(candidate);
    const now = Date.now();
    const price = Number(candidate.priceUsd);
    const priceChange5m = Number(candidate.priceChange5m);
    const buys = Number(candidate.buys5m) || 0;
    const sells = Number(candidate.sells5m) || 0;
    const transactions = buys + sells;
    const buyRatio = transactions ? buys / transactions : 0;
    const liquidity = Number(candidate.liquidityUsd);
    const volume5m = Number(candidate.volume5m) || 0;
    const validPressure = transactions >= 15 && buys > sells && buyRatio > 0.55;
    const validMarket = validPressure && Number.isFinite(liquidity) && liquidity >= 4000 && volume5m > 0;
    let setup = secondPumpSetups.get(key);

    if (!(price > 0) || !Number.isFinite(price)) return false;
    if (!setup) {
      if (candidate.exactPoolVerified && validMarket &&
          Number.isFinite(priceChange5m) && priceChange5m >= 10 &&
          candidate.priceTrend !== "Falling since last scan") {
        if (secondPumpSetups.size >= 500)
          secondPumpSetups.delete(secondPumpSetups.keys().next().value);
        secondPumpSetups.set(key, {
          phase: "WAIT_PULLBACK",
          startedAt: now,
          firstPumpPeakPrice: price,
          firstPumpLiquidityUsd: liquidity,
          pullbackLowPrice: null,
          pullbackBuys5m: buys,
          pullbackVolume5m: volume5m,
          lastObservedPrice: price,
          lastScan: currentScan,
          readyAt: null,
          readyPrice: null
        });
      }
      return false;
    }
    if (now - setup.startedAt > SECOND_PUMP_SETUP_TTL_MS) {
      secondPumpSetups.delete(key);
      return false;
    }
    if (setup.lastScan === currentScan) return setup.phase === "READY";

    if (setup.phase === "WAIT_PULLBACK") {
      if (price > setup.firstPumpPeakPrice) {
        setup.firstPumpPeakPrice = price;
        setup.firstPumpLiquidityUsd = liquidity;
      }
      const pullback = 1 - price / setup.firstPumpPeakPrice;
      if (pullback > SECOND_PUMP_MAX_PULLBACK) {
        secondPumpSetups.delete(key);
        return false;
      }
      if (pullback >= SECOND_PUMP_MIN_PULLBACK) {
        setup.phase = "WAIT_SECOND_PUMP";
        setup.pullbackLowPrice = price;
        setup.pullbackBuys5m = buys;
        setup.pullbackVolume5m = volume5m;
      }
    } else {
      if (setup.phase === "READY" && price < setup.lastObservedPrice) {
        setup.phase = "WAIT_SECOND_PUMP";
        setup.pullbackLowPrice = price;
        setup.pullbackBuys5m = buys;
        setup.pullbackVolume5m = volume5m;
        setup.readyAt = null;
        setup.readyPrice = null;
      }
      if (setup.phase === "READY" && now - setup.readyAt > SECOND_PUMP_READY_TTL_MS) {
        setup.phase = "WAIT_SECOND_PUMP";
        setup.pullbackLowPrice = Math.min(setup.pullbackLowPrice || price, price);
        setup.pullbackBuys5m = buys;
        setup.pullbackVolume5m = volume5m;
        setup.readyAt = null;
        setup.readyPrice = null;
      }
      if (setup.phase === "WAIT_SECOND_PUMP") {
        if (price < setup.firstPumpPeakPrice * (1 - SECOND_PUMP_MAX_PULLBACK)) {
          secondPumpSetups.delete(key);
          return false;
        }
        if (price < setup.pullbackLowPrice) {
          setup.pullbackLowPrice = price;
          setup.pullbackBuys5m = buys;
          setup.pullbackVolume5m = volume5m;
        }
        const reboundLevel = Math.max(
          setup.pullbackLowPrice * (1 + SECOND_PUMP_REBOUND),
          setup.firstPumpPeakPrice * SECOND_PUMP_RECLAIM
        );
        const volumeRecovering = volume5m >= setup.pullbackVolume5m * 0.80;
        const liquidityStable = liquidity >= Math.max(4000, setup.firstPumpLiquidityUsd * 0.75);
        const priceRecovering = price > setup.lastObservedPrice &&
          candidate.priceTrend !== "Falling since last scan";
        if (price >= reboundLevel && priceChange5m >= 2 && validMarket &&
            buys > setup.pullbackBuys5m && volumeRecovering && liquidityStable && priceRecovering) {
          setup.phase = "READY";
          setup.readyAt = now;
          setup.readyPrice = price;
        }
      }
    }
    setup.lastObservedPrice = price;
    setup.lastScan = currentScan;
    return setup.phase === "READY";
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
  function handleTelegramBuy() {
    return { success: false, message: "Gemini buys automatically after a live candidate passes every safety check; Telegram purchases are disabled." };
  }
  function startTelegramBuyAlerts() {
    return { started: false, reason: "Gemini automatic live entries do not use Telegram buy alerts." };
  }
  function stopTelegramBuyAlerts() {}

  async function scan(s) {
    pruneBuySignals();
    if (!isActive(s) || busyScan || trader.getState().position) return;
    busyScan = true;
    const currentScan = ++scanSequence;
    const setupNow = Date.now();
    for (const [key, setup] of secondPumpSetups) {
      if (setupNow - setup.startedAt > SECOND_PUMP_SETUP_TTL_MS) secondPumpSetups.delete(key);
    }
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
      // Prefer verified pools inside the requested age window so a different,
      // newer pool for the same mint cannot hide its eligible PumpSwap pool.
      const poolRank = pool => {
        const createdAt = Date.parse(pool.poolCreatedAt || "");
        const age = Date.now() - createdAt;
        const inWindow = Number.isFinite(createdAt) && age >= MIN_POOL_AGE_MS && age <= MAX_POOL_AGE_MS;
        const verified = canonicalPools.get(String(pool.pairAddress || "").toLowerCase())?.verified === true;
        return Number(inWindow) * 2 + Number(verified);
      };
      const prioritizedPools = [...pools].sort((left, right) =>
        poolRank(right) - poolRank(left) ||
        (Number(right.liquidityUsd) || 0) - (Number(left.liquidityUsd) || 0)
      );
      const unique = new Map();
      for (const pool of prioritizedPools) {
        if (pool.tokenAddress && !unique.has(pool.tokenAddress) && unique.size < MAX_DISCOVERY_CANDIDATES)
          unique.set(pool.tokenAddress, pool);
      }
      const ageWindowCandidates = [...unique.values()].filter(pool => {
        const createdAt = Date.parse(pool.poolCreatedAt || "");
        const age = Date.now() - createdAt;
        return Number.isFinite(createdAt) && age >= MIN_POOL_AGE_MS && age <= MAX_POOL_AGE_MS;
      });
      const verifiedAgeWindowCandidates = ageWindowCandidates.filter(pool =>
        canonicalPools.get(String(pool.pairAddress || "").toLowerCase())?.verified === true
      ).length;
      let passed = 0;
      for (const pool of unique.values()) {
        if (!isActive(s) || trader.getState().position) break;
        try {
          let candidate = candidateForPool(pool, canonicalPools);
          candidate.liquidityTrend = observeLiquidityTrend(candidate);
          candidate.priceTrend = observePriceTrend(candidate);
          updateSecondPumpSetup(candidate, currentScan);
          const priorLosses = trader.getClosedLossCount?.(candidate.tokenAddress) || 0;
          if (priorLosses >= 2) {
            trader.recordRejection(candidate, "Coin Locked After Two Losing Trades", {
              closedLosingTrades: priorLosses,
              rule: "Do not re-enter a mint after two completed losing trades."
            });
            continue;
          }
          if (!(candidate.priceUsd > 0)) {
            trader.recordRejection(candidate, "Price Unavailable");
            continue;
          }
          let result = await filter(candidate, { signal: s.controller.signal });
          if (!result.accepted) {
            trader.recordRejection(candidate, result.reason, result.details);
            continue;
          }
          // Refresh the exact verified PumpSwap pair before alerting, so the
          // liquidity and 5m activity checks use the latest pair snapshot.
          const freshPair = await pairDetails(candidate.pairAddress, s.controller.signal);
          if (!isActive(s) || !freshPair ||
              String(freshPair.pairAddress || "").toLowerCase() !== String(candidate.pairAddress || "").toLowerCase() ||
              String(freshPair.baseToken?.address || "") !== String(candidate.tokenAddress || "") ||
              String(freshPair.dexId || "").toLowerCase() !== "pumpswap") {
            trader.recordRejection(candidate, "Pre-Alert Pair Refresh Failed", { reason: "Exact verified PumpSwap pair snapshot unavailable." });
            continue;
          }
          const refreshed = poolToCandidate({
            ...candidate,
            canonicalPoolVerified: candidate.exactPoolVerified
          }, freshPair);
          refreshed.liquidityTrend = candidate.liquidityTrend;
          refreshed.priceTrend =
            candidate.priceTrend === "Falling since last scan" ||
            Number(refreshed.priceUsd) < Number(candidate.priceUsd)
              ? "Falling since last scan"
              : candidate.priceTrend;
          const freshResult = await filter(refreshed, { signal: s.controller.signal, marketOnly: true });
          if (!freshResult.accepted) {
            trader.recordRejection(refreshed, "Pre-Alert Recheck: " + freshResult.reason, freshResult.details);
            continue;
          }
          candidate = refreshed;
          result = { ...result, details: { ...result.details, ...freshResult.details } };
          const confirmationKey = secondPumpKey(candidate);
          const setup = secondPumpSetups.get(confirmationKey);
          const secondPumpReady = setup?.phase === "READY" &&
            Date.now() - setup.readyAt <= SECOND_PUMP_READY_TTL_MS &&
            Number(candidate.priceUsd) >= setup.readyPrice * 0.99;
          if (!secondPumpReady) {
            trader.recordRejection(candidate, setup ? "Waiting for Second Pump Confirmation" : "Waiting for First Pump");
            continue;
          }
          passed++;
          const liveSizing = trader.getLiveSizing?.() || { step: 0, amountUsd: 2 };
          const amountUsd = Number(liveSizing.amountUsd);
          const managedCashUsd = Number(trader.getState().cashUsd) || 0;
          if (!(amountUsd > 0) || managedCashUsd < amountUsd) {
            trader.recordRejection(candidate, "Insufficient Gemini Account Balance", {
              requiredUsd: amountUsd, availableUsd: managedCashUsd
            });
            continue;
          }
           const sellability = await verifyFullPositionExit(candidate, amountUsd, s.controller.signal);
          if (!sellability.allowed) {
            trader.recordRejection(candidate, "Full Position Exit Unavailable", {
              reason: sellability.reason,
              sellability: sellability.details || sellability
            });
            continue;
          }
          candidate.geminiDetails = { ...result.details, executionQuote: sellability };
          candidate.slippageBps = slippageFor(candidate);
          candidate.entryReason = "Gemini automatic paper entry passed market, on-chain, and exit-route checks";
          const buy = trader.buy(candidate, amountUsd);
          if (!buy.success) {
            console.error("[INFO] Gemini paper buy could not be recorded", candidate.tokenAddress, buy.error);
            lastError = "Gemini paper entry could not be recorded.";
            break;
          }
          secondPumpSetups.delete(confirmationKey);
          console.log("[INFO] Gemini automatic paper entry recorded", {
            symbol: candidate.symbol, mint: candidate.tokenAddress,
            tradeSizeUsd: amountUsd
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
        ageWindowCandidates: ageWindowCandidates.length,
        verifiedAgeWindowCandidates,
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
      // The collapse threshold remains the existing max($3,000, 75% of entry liquidity).
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
        latest.highestPrice = price;
      }
      // Exit while a quote and meaningful liquidity still exist, rather than
      // allowing this one-position bot to be trapped at near-zero liquidity.
      const close = async (reason, percentOfCurrent = 100) => {
        const remainingRatio = latest.originalQuantity > 0 ? latest.quantity / latest.originalQuantity : 1;
        if (latest.liveExecution?.executionMode !== "LIVE")
          return trader.sell(price, remainingRatio * percentOfCurrent, reason);
        const raw = latest.liveExecution?.outputAmount;
        if (!/^\d+$/.test(String(raw || ""))) throw new Error("Live position has no confirmed token amount.");
        const requestedRaw = (BigInt(raw) * BigInt(Math.round(percentOfCurrent * 100))) / 10000n;
        if (requestedRaw <= 0n) throw new Error("Live partial exit amount rounds to zero.");
        const fill = await liveExecution.executeSwap({ inputMint: latest.tokenAddress, outputMint: USDC, amount: requestedRaw.toString(), slippageBps: MAX_SLIPPAGE_BPS, purpose: "exit" });
        const out = Number(fill.actualOutputAmount);
        if (!Number.isFinite(out) || out < 0) throw new Error("Live exit lacks confirmed USDC output.");
        // Prefer the wallet-reflected token input. If Jupiter omits it, this is
        // an exact-input order, so conservatively subtract the requested amount.
        const reportedInput = String(fill.actualInputAmount || "");
        const actualInput = /^\d+$/.test(reportedInput) ? BigInt(reportedInput) : requestedRaw;
        if (actualInput > BigInt(raw)) throw new Error("Live exit input exceeds the recorded token balance.");
        const fractionSold = Number(actualInput) / Number(raw);
        const percentOriginal = remainingRatio * fractionSold * 100;
        const soldQuantity = latest.quantity * fractionSold;
        if (!(soldQuantity > 0)) throw new Error("Live exit has no confirmed sold quantity.");
        const remainingTokenAmount = (BigInt(raw) - actualInput).toString();
        return trader.sell((out / 1e6) / soldQuantity, percentOriginal, reason, {
          ...fill, actualOutputAmount: String(out), remainingTokenAmount
        });
      };
      if (Number.isFinite(liquidityUsd) && liquidityUsd > 0 && liquidityUsd < exitLiquidityFloorUsd) {
        await close("LIQUIDITY COLLAPSE EXIT");
        return;
      }
      const positionStrategy = String(latest.strategy || "");
      const uses90PercentExit = positionStrategy.includes("sell 90% at +30%");
      const usesStagedExit = positionStrategy.includes("staged exits 50% at +20%");
      if (uses90PercentExit) {
        if (!latest.tp1Done) {
          if (price <= latest.entryPrice * (1 + HARD_STOP / 100)) {
            await close("HARD STOP -15%");
            return;
          }
          if (price >= latest.entryPrice * 1.30) {
            await close("TP1 +30% SELL 90%", 90);
            return;
          }
        } else {
          const runnerStop = Math.max(latest.entryPrice, latest.highestPrice * 0.90);
          if (price <= runnerStop) {
            await close("RUNNER TRAILING STOP 10% / BREAKEVEN FLOOR");
            return;
          }
        }
      } else if (usesStagedExit) {
        if (!latest.tp1Done) {
          if (price <= latest.entryPrice * (1 + HARD_STOP / 100)) {
            await close("HARD STOP -15%");
            return;
          }
          if (price >= latest.entryPrice * 1.20) {
            await close("TP1 +20% SELL 50%", 50);
            return;
          }
        } else if (!latest.tp2Done) {
          if (price <= latest.entryPrice) {
            await close("BREAKEVEN STOP AFTER TP1");
            return;
          }
          if (price >= latest.entryPrice * 1.30) {
            // Sell 80% of the remaining half = 40% of the original position.
            await close("TP2 +30% SELL 40%", 80);
            return;
          }
        } else {
          const runnerStop = Math.max(latest.entryPrice, latest.highestPrice * 0.90);
          if (price <= runnerStop) {
            await close("RUNNER TRAILING STOP 10% / BREAKEVEN FLOOR");
            return;
          }
        }
      } else {
        // Existing positions keep the exit rules saved when they were opened.
        if (latest.tp1Done) {
          const runnerStop = Math.max(latest.entryPrice, latest.highestPrice * 0.90);
          if (price <= runnerStop) {
            await close("RUNNER TRAILING STOP 10% / BREAKEVEN FLOOR");
            return;
          }
        } else if (price <= latest.entryPrice * (1 + HARD_STOP / 100)) {
          await close("HARD STOP -15%");
          return;
        }
        if (!latest.tp1Done && price >= latest.entryPrice * 1.20) {
          await close("TP +20% SELL 80%", 80);
          return;
        }
      }
    } catch (error) {
      if (isActive(s)) { lastError = error.message; console.error("[INFO] Gemini monitor failed", error.message); }
    } finally { busyMonitor = false; }
  }
  function start() {
    if (session) return;
    const reset = trader.resetPaperAccount?.({
      startingBalanceUsd: 17,
      resetId: "gemini-live-auto-reset17-2026-11-02"
    });
    if (reset && !reset.success) console.warn("[INFO] Gemini account reset skipped:", reset.reason || "active live position protected");
    geminiLiveControl.stop();
    trader.getState();
    lastError = null;
    const s = { controller: new AbortController() };
    session = s;
    console.log("[INFO] Gemini Bot started in PAPER mode; fixed $2 entries; live entries are off; exits are 90% at +30%, a 10% runner with a 10% trailing stop and breakeven floor, initial hard stop -15%, liquidity exit at a 25% pool-liquidity drop (minimum $3,000 floor), and two consecutive qualifying scans before entry.");
    scanInterval = timers.setInterval(() => void scan(s), SCAN_MS);
    monitorInterval = timers.setInterval(() => void monitor(s), MONITOR_MS);
    void scan(s); void monitor(s);
  }
  function stop() {
    if (!session) return;
    session.controller.abort(); session = null;
    geminiLiveControl.stop();
    timers.clearInterval(scanInterval); timers.clearInterval(monitorInterval);
    scanInterval = monitorInterval = null;
    console.log("[INFO] Gemini Bot stopped; saved paper position retained.");
  }
  return { start, stop, startTelegramBuyAlerts, stopTelegramBuyAlerts, handleTelegramBuy, getStatus: () => !!session, getLastError: () => lastError, lastKnownPrice: positionId => lastPriceByPositionId.get(positionId) || 0, getDiagnostics: () => ({ lastMonitorAt, lastQuoteAt, lastQuoteFailureAt, lastScanAt: trader.getState().lastScanAt, activity: trader.getState().position ? "MONITORING POSITION" : "SCANNING" }), scan: () => scan(session), monitor: () => monitor(session) };
}
module.exports = { createGeminiBot, ...createGeminiBot() };
