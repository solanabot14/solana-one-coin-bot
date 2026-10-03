const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_5M_USD = 1000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.01;
const MIN_TRANSACTIONS_5M = 4;
const MIN_BUY_RATIO = 0.52;
const MIN_CHANGE_5M = -1;
const MAX_CHANGE_5M = 18;
const MIN_CHANGE_1H = -15;
const MAX_CHANGE_1H = 75;
const MIN_STEP_CHANGE_PCT = 0.25;
const MAX_STEP_CHANGE_PCT = 6;
const REQUIRED_OBSERVATIONS = 3;
const MAX_OBSERVATION_GAP_MS = 90000;
const OBSERVATION_TTL_MS = 120000;

function createPullbackStrategy() {
  let rejectedByFilter = {};
  const observations = new Map();

  function observe(candidates = [], now = Date.now()) {
    const ready = [];
    const rejected = {};
    const seen = new Set();
    const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };

    for (const [tokenAddress, samples] of observations) {
      if (!samples.length || now - samples[samples.length - 1].at > OBSERVATION_TTL_MS) {
        observations.delete(tokenAddress);
      }
    }

    for (const coin of candidates) {
      const tokenAddress = coin?.tokenAddress;
      if (!tokenAddress || seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);

      const price = Number(coin?.priceUsd);
      const liquidity = Number(coin?.liquidityUsd) || 0;
      const volume5m = Number(coin?.volume5m) || 0;
      const buys = Number(coin?.buys5m) || 0;
      const sells = Number(coin?.sells5m) || 0;
      const totalTransactions = buys + sells;
      const buyRatio = totalTransactions ? buys / totalTransactions : 0;
      const change5m = Number(coin?.priceChange5m) || 0;
      const change1h = Number(coin?.priceChange1h) || 0;
      const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
      let reason = null;

      if (!coin?.pairAddress || !(price > 0)) reason = "MISSING_MARKET_DATA";
      else if (liquidity < MIN_LIQUIDITY_USD) reason = "LIQUIDITY_BELOW_20000";
      else if (totalTransactions < MIN_TRANSACTIONS_5M) reason = "FEWER_THAN_4_TRANSACTIONS";
      else if (buyRatio < MIN_BUY_RATIO) reason = "BUY_RATIO_BELOW_52_PERCENT";
      else if (volume5m < requiredVolume) reason = "FIVE_MINUTE_VOLUME_TOO_LOW";
      else if (change5m < MIN_CHANGE_5M || change5m > MAX_CHANGE_5M) reason = "FIVE_MINUTE_MOMENTUM_OUT_OF_RANGE";
      else if (change1h < MIN_CHANGE_1H || change1h > MAX_CHANGE_1H) reason = "ONE_HOUR_MOMENTUM_OUT_OF_RANGE";

      if (reason) {
        observations.delete(tokenAddress);
        reject(reason);
        continue;
      }

      let samples = observations.get(tokenAddress) || [];
      const previous = samples[samples.length - 1];
      if (previous && now - previous.at > MAX_OBSERVATION_GAP_MS) samples = [];

      let stepChangePct = null;
      const last = samples[samples.length - 1];
      if (last) {
        stepChangePct = ((price - last.price) / last.price) * 100;
        if (stepChangePct < MIN_STEP_CHANGE_PCT) {
          samples = [];
          reject("SOFT_PUMP_SEQUENCE_RESET");
        } else if (stepChangePct > MAX_STEP_CHANGE_PCT) {
          samples = [];
          reject("SINGLE_STEP_MOVE_TOO_SHARP");
          observations.set(tokenAddress, [{ at: now, price }]);
          continue;
        }
      }

      samples.push({ at: now, price });
      samples = samples.slice(-(REQUIRED_OBSERVATIONS));
      observations.set(tokenAddress, samples);

      if (samples.length < REQUIRED_OBSERVATIONS) {
        reject("WAITING_FOR_TWO_RISING_STEPS");
        continue;
      }

      const firstStepPct = ((samples[1].price - samples[0].price) / samples[0].price) * 100;
      const secondStepPct = ((samples[2].price - samples[1].price) / samples[1].price) * 100;
      if (firstStepPct < MIN_STEP_CHANGE_PCT || secondStepPct < MIN_STEP_CHANGE_PCT ||
          firstStepPct > MAX_STEP_CHANGE_PCT || secondStepPct > MAX_STEP_CHANGE_PCT) {
        reject("SOFT_PUMP_SEQUENCE_NOT_CONFIRMED");
        continue;
      }

      const sequenceGainPct = ((samples[2].price - samples[0].price) / samples[0].price) * 100;
      ready.push({
        ...coin,
        signal: "STRONG BUY",
        reasons: [
          "FAST MOMENTUM STEP-3: three live price checks confirmed two small upward steps; no candle wait",
          "FAST MOMENTUM STEP-3: liquidity $" + Math.round(liquidity).toLocaleString() +
            ", " + totalTransactions + " five-minute transactions, " + (buyRatio * 100).toFixed(0) + "% buys",
          "FAST MOMENTUM STEP-3: five-minute volume $" + Math.round(volume5m).toLocaleString() +
            ", step moves +" + firstStepPct.toFixed(2) + "% / +" + secondStepPct.toFixed(2) +
            "%; total " + sequenceGainPct.toFixed(2) + "% in confirmation",
          "FAST MOMENTUM STEP-3: anti-chase limits ≤18% / 5m and ≤75% / 1h"
        ],
        experimentEntry: {
          model: "FAST_MOMENTUM_STEP3_V1_5",
          discoverySource: "DexScreener latest profiles, community takeovers, latest/top boosts",
          liquidityUsd: liquidity,
          volume5mUsd: volume5m,
          transactions5m: totalTransactions,
          buyRatio,
          priceChange5m: change5m,
          priceChange1h: change1h,
          stepChangesPct: [firstStepPct, secondStepPct],
          sequenceGainPct,
          maxEntryChange5m: MAX_CHANGE_5M,
          maxEntryChange1h: MAX_CHANGE_1H,
          observedAt: new Date(now).toISOString()
        }
      });
      observations.delete(tokenAddress);
    }

    rejectedByFilter = rejected;
    return ready;
  }

  return {
    observe,
    release: tokenAddress => { if (tokenAddress) observations.delete(tokenAddress); },
    getStatus: () => ({ rejectedByFilter: { ...rejectedByFilter } })
  };
}

module.exports = {
  createPullbackStrategy,
  constants: {
    MIN_LIQUIDITY_USD,
    MIN_VOLUME_5M_USD,
    MIN_VOLUME_LIQUIDITY_RATIO,
    MIN_TRANSACTIONS_5M,
    MIN_BUY_RATIO,
    MIN_CHANGE_5M,
    MAX_CHANGE_5M,
    MIN_CHANGE_1H,
    MAX_CHANGE_1H,
    MIN_STEP_CHANGE_PCT,
    MAX_STEP_CHANGE_PCT,
    REQUIRED_OBSERVATIONS,
    MAX_OBSERVATION_GAP_MS,
    OBSERVATION_TTL_MS
  }
};
