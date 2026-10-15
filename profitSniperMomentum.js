const CONFIG = require("./profitSniperConfig");

// Historical candles establish pump/pullback context. Live snapshots confirm
// that price, volume and buy flow have resumed without requiring a fixed rebound percentage.
function createMomentumTracker() {
  const pools = new Map();

  function keyFor(coin) {
    return String(coin?.tokenAddress || "") + ":" + String(coin?.pairAddress || "");
  }

  function hydrate(coin, candles, now = Date.now()) {
    const key = keyFor(coin);
    const existing = pools.get(key);
    if (!key || key === ":" || existing?.historicalHydrated ||
        !Array.isArray(candles) || candles.length < 2) return false;
    const ordered = candles.filter(candle => Number(candle?.open) > 0 && Number(candle?.high) > 0 &&
      Number(candle?.low) > 0 && Number(candle?.close) > 0)
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    if (ordered.length < 2) return false;
    const basePrice = Number(ordered[0].open);
    let peakPrice = basePrice;
    let peakIndex = 0;
    ordered.forEach((candle, index) => {
      if (Number(candle.high) > peakPrice) {
        peakPrice = Number(candle.high);
        peakIndex = index;
      }
    });
    const afterPeak = ordered.slice(peakIndex);
    const candlesAfterPeak = ordered.slice(peakIndex + 1);
    const troughPrice = Math.min(...afterPeak.map(candle => Number(candle.low)));
    const lastPrice = Number(ordered.at(-1).close);
    pools.set(key, {
      firstAt: Number(ordered[0].timestamp) * 1000,
      basePrice, peakPrice, troughPrice, lastPrice, samples: [],
      pumpSeen: peakPrice >= basePrice * (1 + CONFIG.MIN_PUMP_PERCENT / 100),
      pullbackObserved: candlesAfterPeak.some(candle => Number(candle.low) < peakPrice),
      historicalHydrated: true, lastAt: now
    });
    return true;
  }

  function observe(coin, now = Date.now()) {
    const key = keyFor(coin);
    const price = Number(coin?.priceUsd);
    const change5m = Number(coin?.priceChange5m);
    const buys5m = Number(coin?.buys5m);
    const sells5m = Number(coin?.sells5m);
    const volume5m = Number(coin?.volume5m);
    const liquidity = Number(coin?.liquidityUsd);
    if (!key || key === ":" || !(price > 0)) return { ready: false, reason: "missing_price_history" };

    let state = pools.get(key);
    if (!state) {
      const inferredPump = Number.isFinite(change5m) && change5m >= CONFIG.MIN_PUMP_PERCENT;
      const basePrice = inferredPump ? price / (1 + change5m / 100) : price;
      state = { firstAt: now, basePrice, peakPrice: price, troughPrice: price, lastPrice: price,
        samples: [], pumpSeen: inferredPump,
        pullbackObserved: false,
        peakLiquidity: Number.isFinite(liquidity) && liquidity > 0 ? liquidity : null };
    }

    const previous = state.samples[state.samples.length - 1];
    const buyDelta = previous && Number.isFinite(buys5m) && Number.isFinite(previous.buys5m)
      ? Math.max(0, buys5m - previous.buys5m) : 0;
    const sellDelta = previous && Number.isFinite(sells5m) && Number.isFinite(previous.sells5m)
      ? Math.max(0, sells5m - previous.sells5m) : 0;
    state.samples.push({ at: now, price, buys5m, sells5m, volume5m, liquidity, buyDelta, sellDelta });
    state.samples = state.samples.filter(item => now - item.at <= CONFIG.RECOVERY_FLOW_WINDOW_MS + CONFIG.MAX_SNAPSHOT_INTERVAL_MS);
    const pumpWasSeen = state.pumpSeen;
    if (price > state.peakPrice) {
      state.peakPrice = price;
      state.troughPrice = price;
    }
    state.pumpSeen = state.pumpSeen || price >= state.basePrice * (1 + CONFIG.MIN_PUMP_PERCENT / 100);
    if (Number.isFinite(liquidity) && liquidity > 0)
      state.peakLiquidity = Math.max(Number(state.peakLiquidity) || liquidity, liquidity);
    if (!pumpWasSeen && state.pumpSeen) state.troughPrice = price;
    else if (state.pumpSeen) state.troughPrice = Math.min(state.troughPrice || price, price);
    if (state.pumpSeen && price < state.peakPrice) state.pullbackObserved = true;

    const retracePercent = state.peakPrice > 0
      ? (state.peakPrice - price) / state.peakPrice * 100 : 0;
    const flowSamples = state.samples.filter(item => now - item.at <= CONFIG.RECOVERY_FLOW_WINDOW_MS);
    const flowBuys = flowSamples.reduce((sum, item) => sum + item.buyDelta, 0);
    const flowSells = flowSamples.reduce((sum, item) => sum + item.sellDelta, 0);
    const flowSpanMs = flowSamples.length > 1 ? flowSamples.at(-1).at - flowSamples[0].at : 0;
    const recovering = price > state.lastPrice;
    const reboundFromLowPercent = state.troughPrice > 0
      ? (price / state.troughPrice - 1) * 100 : 0;
    const confirmationSamples = state.samples.slice(-3);
    const confirmationSpanMs = confirmationSamples.length > 1
      ? confirmationSamples.at(-1).at - confirmationSamples[0].at : 0;
    const risingSteps = confirmationSamples.slice(1).filter((sample, index) =>
      sample.price > confirmationSamples[index].price).length;
    const recoveryObserved = confirmationSamples.length >= 3 && risingSteps >= 1 &&
      price >= state.lastPrice &&
      confirmationSpanMs >= CONFIG.RECOVERY_CONFIRMATION_SPAN_MS;
    const currentBuyShare = buys5m + sells5m > 0 ? buys5m / (buys5m + sells5m) : 0;
    const liquidityRetained = Number.isFinite(liquidity) && liquidity > 0 &&
      Number(state.peakLiquidity) > 0 && liquidity >= state.peakLiquidity * CONFIG.RECOVERY_MIN_LIQUIDITY_RETENTION;
    const volumeIncreasing = confirmationSamples.length >= 3 &&
      Number.isFinite(confirmationSamples[0].volume5m) &&
      Number.isFinite(confirmationSamples.at(-1).volume5m) &&
      confirmationSamples.at(-1).volume5m > confirmationSamples[0].volume5m;
    const pumpPercent = state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : 0;
    const ready = state.pumpSeen && state.pullbackObserved &&
      retracePercent <= CONFIG.MAX_RETRACE_PERCENT && recoveryObserved &&
      currentBuyShare >= CONFIG.RECOVERY_MIN_BUY_SHARE && liquidityRetained &&
      volumeIncreasing && flowBuys > flowSells;
    const entryRoute = ready ? "confirmed_pullback_recovery" : null;
    const reason = retracePercent > CONFIG.MAX_RETRACE_PERCENT ? "retrace_over_45_percent"
      : !state.pumpSeen ? "pump_not_observed"
      : !state.pullbackObserved ? "pullback_not_observed"
      : !recoveryObserved ? "recovery_not_confirmed_60s"
      : currentBuyShare < CONFIG.RECOVERY_MIN_BUY_SHARE ? "recovery_buy_ratio_below_55_percent"
      : !liquidityRetained ? "recovery_liquidity_not_retained_90_percent"
      : !volumeIncreasing ? "recovery_volume_not_increasing"
      : flowBuys <= flowSells ? "recovery_recent_buy_flow_not_above_sells"
      : null;

    state.lastPrice = price;
    state.lastAt = now;
    pools.set(key, state);
    for (const [poolKey, item] of pools) if (now - item.lastAt > CONFIG.WATCHLIST_MAX_AGE_MS) pools.delete(poolKey);
    return { ready, reason, entryRoute, pumpSeen: state.pumpSeen, historicalHydrated: !!state.historicalHydrated,
      pumpPercent: state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : null,
      peakPrice: state.peakPrice, troughPrice: state.troughPrice, retracePercent, reboundFromLowPercent, recovering, flowBuys, flowSells,
      flowSpanMs, pullbackObserved: !!state.pullbackObserved, currentBuyShare, liquidityRetained, volumeIncreasing,
      confirmationSpanMs, risingSteps, flowIsApproximation: true };
  }

  function remove(coin) {
    pools.delete(keyFor(coin));
  }

  return { observe, hydrate,
    hasHistorical: coin => pools.get(keyFor(coin))?.historicalHydrated === true,
    remove, size: () => pools.size };
}

module.exports = { createMomentumTracker };

