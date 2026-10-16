const CONFIG = require("./profitSniperConfig");

// Confirm recent direction and activity. Session highs and old pumps are
// informational; security and executable quotes are independent pre-buy checks.
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
      basePrice, peakPrice: Math.max(peakPrice, existing?.peakPrice || 0),
      troughPrice: Math.min(troughPrice, existing?.troughPrice || troughPrice),
      lastPrice: existing?.lastPrice || lastPrice, samples: existing?.samples || [],
      peakLiquidity: existing?.peakLiquidity,
      pumpSeen: !!existing?.pumpSeen || peakPrice > basePrice,
      pullbackObserved: !!existing?.pullbackObserved || candlesAfterPeak.some(candle => Number(candle.low) < peakPrice),
      historicalHydrated: true, lastAt: existing?.lastAt ?? now
    });
    return true;
  }

  function observe(coin, now = Date.now()) {
    const key = keyFor(coin);
    const price = Number(coin?.priceUsd);
    const buys5m = Number(coin?.buys5m);
    const sells5m = Number(coin?.sells5m);
    const volume5m = Number(coin?.volume5m);
    const liquidity = Number(coin?.liquidityUsd);
    if (!key || key === ":" || !(price > 0)) return { ready: false, reason: "missing_price_history" };

    let state = pools.get(key);
    if (!state) {
      const basePrice = price;
      state = { firstAt: now, basePrice, peakPrice: price, troughPrice: price, lastPrice: price,
        samples: [], pumpSeen: false,
        pullbackObserved: false,
        peakLiquidity: Number.isFinite(liquidity) && liquidity > 0 ? liquidity : null };
    }

    const previous = state.samples.at(-1);
    if (previous && now - previous.at > 75000) state.samples = [];
    if (!previous || now > previous.at)
      state.samples.push({at:now,price,buys5m,sells5m,volume5m,liquidity});
    state.samples = state.samples.filter(item => now-item.at <= CONFIG.RECOVERY_CONFIRMATION_SPAN_MS+75000);
    const anchor = state.samples.findLastIndex(item => item.at <= now-CONFIG.RECOVERY_CONFIRMATION_SPAN_MS);
    const samples = anchor >= 0 ? state.samples.slice(anchor) : state.samples;
    const span = samples.length > 1 ? now-samples[0].at : 0;
    const risingSteps = samples.slice(1).filter((item,index)=>item.price>samples[index].price).length;
    const noGap = samples.slice(1).every((item,index)=>item.at-samples[index].at<=75000);
    const freshWindow = samples.length>=3 && span>=CONFIG.RECOVERY_CONFIRMATION_SPAN_MS && noGap;
    const lows = samples.map(item=>item.price);
    const low = Math.min(...lows);
    const lowIndex = lows.lastIndexOf(low);
    const afterLow = samples.slice(lowIndex);
    const recoverySteps = afterLow.slice(1).filter((item,index)=>item.price>afterLow[index].price).length;
    const notFalling = previous && price>=previous.price;
    const ordinaryContinuation = freshWindow && notFalling && price>samples[0].price && risingSteps>=2;
    const recovery = freshWindow && notFalling && price>low && recoverySteps>=2;
    const transactions = buys5m+sells5m;
    const currentBuyShare = transactions>0 ? buys5m/transactions : 0;
    const volumeIncreasing = samples.length>=3 && Number.isFinite(volume5m) && volume5m>samples[0].volume5m;
    const highVolume = volume5m>=CONFIG.HIGH_VOLUME_5M_USD && transactions>=CONFIG.HIGH_TRANSACTIONS_5M;
    // A cached flat snapshot should not demand a second uptick after a genuine
    // upward move. Keep the full window, net upward direction and strong flow.
    const strongActivityContinuation = freshWindow && !!previous && price>previous.price &&
      price>samples[0].price && risingSteps>=1 && highVolume &&
      currentBuyShare>=CONFIG.STRONG_ACTIVITY_MIN_BUY_SHARE;
    const continuation = ordinaryContinuation || strongActivityContinuation;
    const activitySufficient = volume5m>=CONFIG.MIN_VOLUME_5M_USD && transactions>=CONFIG.MIN_TRANSACTIONS_5M &&
      (volumeIncreasing || highVolume);
    // Price patterns are opportunities, not security attestations. Recent pool
    // changes and executable quotes are independently checked immediately pre-buy.
    const liquidityRetained = Number.isFinite(liquidity) && liquidity>=CONFIG.MIN_LIQUIDITY_USD;
    state.peakPrice = Math.max(state.peakPrice,price);
    state.troughPrice = Math.min(state.troughPrice,price);
    state.pullbackObserved = state.pullbackObserved || price<state.peakPrice;
    const ready = (continuation || recovery) && activitySufficient && liquidityRetained &&
      currentBuyShare>=CONFIG.MIN_BUY_SHARE_5M;
    const entryRoute = ready ? (continuation ? "activity_continuation" : "local_recovery") : null;
    const reason = !freshWindow ? "waiting_for_fresh_60s_window"
      : !(continuation || recovery) ? "recent_price_not_confirmed_upward"
      : !liquidityRetained ? "liquidity_below_floor"
      : currentBuyShare<CONFIG.MIN_BUY_SHARE_5M ? "buy_share_below_55_percent"
      : !activitySufficient ? "volume_neither_growing_nor_sufficiently_high" : null;
    const retracePercent = state.peakPrice>0 ? (state.peakPrice-price)/state.peakPrice*100 : 0;
    const reboundFromLowPercent = low>0 ? (price/low-1)*100 : 0;
    const pumpPercent = state.basePrice>0 ? (state.peakPrice/state.basePrice-1)*100 : 0;
    const recovering = !!previous && price>previous.price;
    const confirmationSpanMs = span;
    const flowSpanMs = span;
    const flowBuys = null, flowSells = null;
    state.pumpSeen = state.pumpSeen || price>state.basePrice;

    state.lastPrice = price;
    state.lastAt = now;
    pools.set(key, state);
    for (const [poolKey, item] of pools) if (now - item.lastAt > CONFIG.WATCHLIST_MAX_AGE_MS) pools.delete(poolKey);
    return { ready, reason, entryRoute, pumpSeen: state.pumpSeen, historicalHydrated: !!state.historicalHydrated,
      pumpPercent: state.basePrice > 0 ? (state.peakPrice / state.basePrice - 1) * 100 : null,
      peakPrice: state.peakPrice, troughPrice: state.troughPrice, retracePercent, reboundFromLowPercent, recovering, flowBuys, flowSells,
      flowSpanMs, pullbackObserved: !!state.pullbackObserved, currentBuyShare, liquidityRetained, volumeIncreasing,
      confirmationSpanMs, risingSteps, activitySufficient, highVolume, strongActivityContinuation, observedAt:now,
      volumeBasis: highVolume ? "high_absolute_5m" : volumeIncreasing ? "growing_rolling_5m" : "insufficient",
      flowMeasurement: "rolling_5m_counts_not_new_trades", flowIsApproximation: true };
  }

  function remove(coin) {
    pools.delete(keyFor(coin));
  }

  return { observe, hydrate,
    hasHistorical: coin => pools.get(keyFor(coin))?.historicalHydrated === true,
    remove, size: () => pools.size };
}

module.exports = { createMomentumTracker };


