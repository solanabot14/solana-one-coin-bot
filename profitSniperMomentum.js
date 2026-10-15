const CONFIG = require("./profitSniperConfig");

// Historical candles establish pump/pullback context. Live 30-second
// DexScreener snapshots still provide the required rebound and buy-flow confirmation.
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
    const troughPrice = Math.min(...afterPeak.map(candle => Number(candle.low)));
    const lastPrice = Number(ordered.at(-1).close);
    pools.set(key, {
      firstAt: Number(ordered[0].timestamp) * 1000,
      basePrice, peakPrice, troughPrice, lastPrice, samples: [],
      pumpSeen: peakPrice >= basePrice * (1 + CONFIG.MIN_PUMP_PERCENT / 100),
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

    const retracePercent = state.peakPrice > 0
      ? (state.peakPrice - price) / state.peakPrice * 100 : 0;
    const flowSamples = state.samples.filter(item => now - item.at <= CONFIG.RECOVERY_FLOW_WINDOW_MS);
    const flowBuys = flowSamples.reduce((sum, item) => sum + item.buyDelta, 0);
    const flowSells = flowSamples.reduce((sum, item) => sum + item.sellDelta, 0);
    const flowSpanMs = flowSamples.length > 1 ? flowSamples.at(-1).at - flowSamples[0].at : 0;
    const recovering = price > state.lastPrice;
    const reboundFromLowPercent = state.troughPrice > 0
      ? (price / state.troughPrice - 1) * 100 : 0;
    const normalReady = state.pumpSeen &&
      retracePercent >= CONFIG.MIN_RETRACE_PERCENT &&
      retracePercent <= CONFIG.MAX_ENTRY_RETRACE_PERCENT &&
      reboundFromLowPercent >= CONFIG.MIN_REBOUND_FROM_LOW_PERCENT &&
      recovering && flowSpanMs >= CONFIG.MIN_RECOVERY_FLOW_SPAN_MS && flowBuys > flowSells;
    const confirmationSamples = state.samples.slice(-3);
    const confirmationSpanMs = confirmationSamples.length > 1
      ? confirmationSamples.at(-1).at - confirmationSamples[0].at : 0;
    const risingSteps = confirmationSamples.slice(1).filter((sample, index) =>
      sample.price > confirmationSamples[index].price).length;
    const twoRisingObservations = confirmationSamples.length >= 3 && risingSteps >= 2 &&
      confirmationSpanMs >= CONFIG.DEEP_MIN_CONFIRMATION_SPAN_MS;
    const currentBuyShare = buys5m + sells5m > 0 ? buys5m / (buys5m + sells5m) : 0;
    const liquidityRetained = Number.isFinite(liquidity) && liquidity > 0 &&
      Number(state.peakLiquidity) > 0 && liquidity >= state.peakLiquidity * CONFIG.DEEP_MIN_LIQUIDITY_RETENTION;
    const volumeIncreasing = confirmationSamples.length >= 3 &&
      Number.isFinite(confirmationSamples[0].volume5m) &&
      Number.isFinite(confirmationSamples.at(-1).volume5m) &&
      confirmationSamples.at(-1).volume5m > confirmationSamples[0].volume5m;
    const pumpPercent = state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : 0;
    const deepReady = pumpPercent >= CONFIG.DEEP_MIN_PUMP_PERCENT &&
      retracePercent > CONFIG.DEEP_PULLBACK_MIN_PERCENT &&
      retracePercent <= CONFIG.DEEP_PULLBACK_MAX_PERCENT &&
      reboundFromLowPercent >= CONFIG.DEEP_MIN_REBOUND_PERCENT && twoRisingObservations &&
      currentBuyShare >= CONFIG.DEEP_MIN_BUY_SHARE && liquidityRetained && volumeIncreasing &&
      flowBuys > flowSells;
    const ready = normalReady || deepReady;
    const entryRoute = normalReady ? "normal_pullback" : deepReady ? "deep_pullback" : null;
    const deepRange = retracePercent > CONFIG.DEEP_PULLBACK_MIN_PERCENT &&
      retracePercent <= CONFIG.DEEP_PULLBACK_MAX_PERCENT;
    const reason = retracePercent > CONFIG.MAX_RETRACE_PERCENT ? "retrace_over_45_percent"
      : !state.pumpSeen ? "pump_not_observed"
      : retracePercent < CONFIG.MIN_RETRACE_PERCENT ? "retrace_below_10_percent"
      : deepRange && pumpPercent < CONFIG.DEEP_MIN_PUMP_PERCENT ? "deep_pump_below_50_percent"
      : deepRange && reboundFromLowPercent < CONFIG.DEEP_MIN_REBOUND_PERCENT ? "deep_rebound_below_12_percent"
      : deepRange && !twoRisingObservations ? "deep_rise_not_confirmed_60s"
      : deepRange && currentBuyShare < CONFIG.DEEP_MIN_BUY_SHARE ? "deep_buy_ratio_below_60_percent"
      : deepRange && !liquidityRetained ? "deep_liquidity_not_retained_90_percent"
      : deepRange && !volumeIncreasing ? "deep_volume_not_increasing"
      : deepRange && flowBuys <= flowSells ? "deep_recent_buy_flow_not_above_sells"
      : retracePercent > CONFIG.MAX_ENTRY_RETRACE_PERCENT ? "retrace_outside_10_to_30_percent"
      : reboundFromLowPercent < CONFIG.MIN_REBOUND_FROM_LOW_PERCENT ? "rebound_below_5_percent"
      : !recovering ? "recovery_not_confirmed"
      : flowSpanMs < 20_000 ? "recent_flow_warming_up"
      : flowBuys <= flowSells ? "recent_buy_flow_not_above_sells"
      : null;

    state.lastPrice = price;
    state.lastAt = now;
    pools.set(key, state);
    for (const [poolKey, item] of pools) if (now - item.lastAt > CONFIG.WATCHLIST_MAX_AGE_MS) pools.delete(poolKey);
    return { ready, reason, entryRoute, pumpSeen: state.pumpSeen, historicalHydrated: !!state.historicalHydrated,
      pumpPercent: state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : null,
      peakPrice: state.peakPrice, troughPrice: state.troughPrice, retracePercent, reboundFromLowPercent, recovering, flowBuys, flowSells,
      flowSpanMs, currentBuyShare, liquidityRetained, volumeIncreasing,
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

