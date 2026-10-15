const CONFIG = require("./profitSniperConfig");

// Uses only the existing 30-second DexScreener snapshots. Buy/sell flow is an
// approximation derived from rolling 5-minute counters; no candle/API calls are added.
function createMomentumTracker() {
  const pools = new Map();

  function observe(coin, now = Date.now()) {
    const key = String(coin?.tokenAddress || "") + ":" + String(coin?.pairAddress || "");
    const price = Number(coin?.priceUsd);
    const change5m = Number(coin?.priceChange5m);
    const buys5m = Number(coin?.buys5m);
    const sells5m = Number(coin?.sells5m);
    if (!key || key === ":" || !(price > 0)) return { ready: false, reason: "missing_price_history" };

    let state = pools.get(key);
    if (!state) {
      const inferredPump = Number.isFinite(change5m) && change5m >= CONFIG.MIN_PUMP_PERCENT;
      const basePrice = inferredPump ? price / (1 + change5m / 100) : price;
      state = { firstAt: now, basePrice, peakPrice: price, troughPrice: price, lastPrice: price,
        samples: [], pumpSeen: inferredPump };
    }

    const previous = state.samples[state.samples.length - 1];
    const buyDelta = previous && Number.isFinite(buys5m) && Number.isFinite(previous.buys5m)
      ? Math.max(0, buys5m - previous.buys5m) : 0;
    const sellDelta = previous && Number.isFinite(sells5m) && Number.isFinite(previous.sells5m)
      ? Math.max(0, sells5m - previous.sells5m) : 0;
    state.samples.push({ at: now, price, buys5m, sells5m, buyDelta, sellDelta });
    state.samples = state.samples.filter(item => now - item.at <= CONFIG.RECOVERY_FLOW_WINDOW_MS + CONFIG.MAX_SNAPSHOT_INTERVAL_MS);
    const pumpWasSeen = state.pumpSeen;
    if (price > state.peakPrice) {
      state.peakPrice = price;
      state.troughPrice = price;
    }
    state.pumpSeen = state.pumpSeen || price >= state.basePrice * (1 + CONFIG.MIN_PUMP_PERCENT / 100);
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
    const ready = state.pumpSeen &&
      retracePercent >= CONFIG.MIN_RETRACE_PERCENT &&
      retracePercent <= CONFIG.MAX_ENTRY_RETRACE_PERCENT &&
      reboundFromLowPercent >= CONFIG.MIN_REBOUND_FROM_LOW_PERCENT &&
      recovering && flowSpanMs >= CONFIG.MIN_RECOVERY_FLOW_SPAN_MS && flowBuys > flowSells;
    const reason = retracePercent > CONFIG.MAX_RETRACE_PERCENT ? "retrace_over_35_percent"
      : !state.pumpSeen ? "pump_not_observed"
      : retracePercent < CONFIG.MIN_RETRACE_PERCENT ? "retrace_below_15_percent"
      : retracePercent > CONFIG.MAX_ENTRY_RETRACE_PERCENT ? "retrace_outside_15_to_30_percent"
      : reboundFromLowPercent < CONFIG.MIN_REBOUND_FROM_LOW_PERCENT ? "rebound_below_5_percent"
      : !recovering ? "recovery_not_confirmed"
      : flowSpanMs < 20_000 ? "recent_flow_warming_up"
      : flowBuys <= flowSells ? "recent_buy_flow_not_above_sells"
      : null;

    state.lastPrice = price;
    state.lastAt = now;
    pools.set(key, state);
    for (const [poolKey, item] of pools) if (now - item.lastAt > CONFIG.WATCHLIST_MAX_AGE_MS) pools.delete(poolKey);
    return { ready, reason, pumpSeen: state.pumpSeen,
      pumpPercent: state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : null,
      peakPrice: state.peakPrice, troughPrice: state.troughPrice, retracePercent, reboundFromLowPercent, recovering, flowBuys, flowSells,
      flowSpanMs, flowIsApproximation: true };
  }

  function remove(coin) {
    pools.delete(String(coin?.tokenAddress || "") + ":" + String(coin?.pairAddress || ""));
  }

  return { observe, remove, size: () => pools.size };
}

module.exports = { createMomentumTracker };

