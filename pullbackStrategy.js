const MIN_LIQUIDITY_USD = 40000;
const MIN_VOLUME_24H_USD = 50000;
const MIN_VOLUME_5M_USD = 5000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.04;
const MIN_TRANSACTIONS_5M = 20;
const MIN_BUY_RATIO = 0.55;
const MAX_BUY_RATIO = 0.80;
const MIN_SPIKE_5M_PCT = 8;
const MAX_SPIKE_5M_PCT = 120;
const MIN_PULLBACK_PCT = 3;
const MAX_PULLBACK_PCT = 12;
const MAX_RECLAIM_EXTENSION_PCT = 3;
const MIN_RECLAIM_VOLUME_GROWTH = 1.25;
const REQUIRED_RECLAIM_OBSERVATIONS = 2;
const MAX_OBSERVATION_GAP_MS = 90000;
const WATCH_TTL_MS = 20 * 60 * 1000;

function createPullbackStrategy() {
  let rejectedByFilter = {};
  const watches = new Map();

  function observe(candidates = [], now = Date.now()) {
    const ready = [];
    const rejected = {};
    const seen = new Set();
    const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
    for (const [address, watch] of watches) {
      if (now - watch.updatedAt > WATCH_TTL_MS) watches.delete(address);
    }
    for (const coin of candidates) {
      const tokenAddress = coin?.tokenAddress;
      if (!tokenAddress || seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);
      const price = Number(coin.priceUsd);
      const liquidity = Number(coin.liquidityUsd) || 0;
      const volume24h = Number(coin.volume24h) || 0;
      const volume5m = Number(coin.volume5m) || 0;
      const buys = Number(coin.buys5m) || 0;
      const sells = Number(coin.sells5m) || 0;
      const transactions = buys + sells;
      const buyRatio = transactions ? buys / transactions : 0;
      const change5m = Number(coin.priceChange5m) || 0;
      let reason = null;
      if (!coin.pairAddress || !(price > 0)) reason = "MISSING_MARKET_DATA";
      else if (liquidity < MIN_LIQUIDITY_USD) reason = "LIQUIDITY_BELOW_40000";
      else if (volume24h < MIN_VOLUME_24H_USD) reason = "VOLUME_24H_BELOW_50000";
      if (reason) { watches.delete(tokenAddress); reject(reason); continue; }

      let watch = watches.get(tokenAddress);
      if (!watch) {
        if (change5m < MIN_SPIKE_5M_PCT || change5m > MAX_SPIKE_5M_PCT) {
          reject("WAITING_FOR_5M_SPIKE");
          continue;
        }
        watch = { stage: "SPIKE", highPrice: price, pullbackLow: null, pullbackVolume5m: 0,
          reclaimObservations: 0, updatedAt: now, lastObservedAt: now };
        watches.set(tokenAddress, watch);
        reject("WAITING_FOR_PULLBACK");
        continue;
      }

      if (now - watch.lastObservedAt > MAX_OBSERVATION_GAP_MS) {
        watch.stage = "SPIKE";
        watch.highPrice = price;
        watch.pullbackLow = null;
        watch.pullbackVolume5m = 0;
        watch.reclaimObservations = 0;
      }
      watch.lastObservedAt = now;
      watch.updatedAt = now;
      if (watch.stage === "SPIKE") {
        watch.highPrice = Math.max(watch.highPrice, price);
        const pullbackPct = ((watch.highPrice - price) / watch.highPrice) * 100;
        if (pullbackPct > MAX_PULLBACK_PCT) {
          watches.delete(tokenAddress);
          reject("PULLBACK_EXCEEDED_12_PERCENT");
          continue;
        }
        if (pullbackPct < MIN_PULLBACK_PCT) {
          reject("WAITING_FOR_3_TO_12_PERCENT_PULLBACK");
          continue;
        }
        watch.stage = "RECLAIM";
        watch.pullbackLow = price;
        watch.pullbackVolume5m = volume5m;
        watch.reclaimPrice = watch.highPrice;
        watch.reclaimObservations = 0;
        reject("WAITING_FOR_RECLAIM");
        continue;
      }

      const drawdownPct = ((watch.highPrice - price) / watch.highPrice) * 100;
      if (price < watch.reclaimPrice) {
        if (drawdownPct > MAX_PULLBACK_PCT) {
          watches.delete(tokenAddress);
          reject("PULLBACK_EXCEEDED_12_PERCENT");
          continue;
        }
        watch.pullbackLow = Math.min(watch.pullbackLow, price);
        watch.pullbackVolume5m = Math.max(watch.pullbackVolume5m, volume5m);
        watch.reclaimObservations = 0;
        reject("WAITING_FOR_RECLAIM");
        continue;
      }
      const reclaimExtensionPct = ((price - watch.reclaimPrice) / watch.reclaimPrice) * 100;
      if (reclaimExtensionPct > MAX_RECLAIM_EXTENSION_PCT) {
        watch.reclaimObservations = 0;
        reject("RECLAIM_TOO_EXTENDED");
        continue;
      }
      if (transactions < MIN_TRANSACTIONS_5M) {
        watch.reclaimObservations = 0;
        reject("FEWER_THAN_20_TRANSACTIONS");
        continue;
      }
      if (buyRatio < MIN_BUY_RATIO) {
        watch.reclaimObservations = 0;
        reject("BUY_RATIO_BELOW_55_PERCENT");
        continue;
      }
      if (buyRatio > MAX_BUY_RATIO) {
        watch.reclaimObservations = 0;
        reject("BUY_RATIO_ABOVE_80_PERCENT");
        continue;
      }
      const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
      if (volume5m < requiredVolume) {
        watch.reclaimObservations = 0;
        reject("FIVE_MINUTE_VOLUME_TOO_LOW");
        continue;
      }
      if (watch.pullbackVolume5m && volume5m < watch.pullbackVolume5m * MIN_RECLAIM_VOLUME_GROWTH) {
        watch.reclaimObservations = 0;
        reject("RECLAIM_VOLUME_NOT_EXPANDING");
        continue;
      }

      watch.reclaimObservations += 1;
      if (watch.reclaimObservations < REQUIRED_RECLAIM_OBSERVATIONS) {
        reject("WAITING_FOR_SECOND_RECLAIM_OBSERVATION");
        continue;
      }

      const pullbackPct = ((watch.highPrice - watch.pullbackLow) / watch.highPrice) * 100;
      ready.push({
        ...coin,
        signal: "STRONG BUY",
        reasons: [
          "PUBX continuation: waited for a 3%–12% pullback after a +8% or greater five-minute move.",
          "PUBX continuation: price reclaimed the local high in two consecutive live checks.",
          "PUBX continuation: renewed five-minute volume, at least 20 transactions, and 55%–80% buys confirmed.",
          "PUBX continuation: liquidity ≥$40,000, 24-hour volume ≥$50,000, and RugCheck LP lock ≥90% required."
        ],
        experimentEntry: {
          model: "PUBX_MOMENTUM_CONTINUATION_PULLBACK_RECLAIM_V1",
          discoverySource: "DexScreener latest profiles, community takeovers, latest/top boosts",
          liquidityUsd: liquidity, volume24hUsd: volume24h, volume5mUsd: volume5m,
          transactions5m: transactions, buyRatio, priceChange5m: change5m,
          localHighUsd: watch.highPrice, pullbackLowUsd: watch.pullbackLow,
          pullbackPercent: pullbackPct, reclaimExtensionPercent: reclaimExtensionPct,
          observedAt: new Date(now).toISOString()
        }
      });
      watches.delete(tokenAddress);
    }
    rejectedByFilter = rejected;
    return ready;
  }

  return {
    observe,
    release: tokenAddress => {
      const watch = tokenAddress && watches.get(tokenAddress);
      if (watch) watch.reclaimObservations = 0;
    },
    getStatus: () => ({
      rejectedByFilter: { ...rejectedByFilter },
      watchingTokens: watches.size,
      watchingPullbacks: [...watches.values()].filter(w => w.stage === "PULLBACK").length
    })
  };
}

module.exports = {
  createPullbackStrategy,
  constants: {
    MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MIN_VOLUME_5M_USD,
    MIN_VOLUME_LIQUIDITY_RATIO, MIN_TRANSACTIONS_5M, MIN_BUY_RATIO,
    MAX_BUY_RATIO, MIN_SPIKE_5M_PCT, MAX_SPIKE_5M_PCT,
    MIN_PULLBACK_PCT, MAX_PULLBACK_PCT, MAX_RECLAIM_EXTENSION_PCT,
    MIN_RECLAIM_VOLUME_GROWTH, REQUIRED_RECLAIM_OBSERVATIONS,
    MAX_OBSERVATION_GAP_MS, WATCH_TTL_MS
  }
};
