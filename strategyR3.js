// R3 Early Runner strategy.
// Experimental paper-only strategy. V3.1R2 remains untouched on main.
//
// R3 focuses on what is happening NOW:
// short-term volume acceleration + liquidity expansion + buyer participation.
// 24h volume is retained only as context/telemetry, never as an entry gate.
const CONFIG = Object.freeze({
  minObservations: 3,
  minLiquidityToEnter: 50000,
  minVolume5mToEnter: 3000,
  minTransactions5m: 20,
  minBuyRatio: 0.52,
  maxBuyRatio: 0.80,
  minChange5m: 0.25,
  maxChange5m: 4,
  maxChange1h: 40,
  minLiquidityGrowthPct: 5,
  minVolume5mGrowthPct: 25,
  supportVolume1hGrowthPct: 5,
  minVolume5mLiquidityPct: 2.5,
  maxLiquidityDrawdownPct: 12
});

function pctChange(current, previous) {
  current = Number(current);
  previous = Number(previous);
  if (!(previous > 0) || !Number.isFinite(current)) return null;
  return ((current - previous) / previous) * 100;
}

function ratio(numerator, denominator) {
  numerator = Number(numerator) || 0;
  denominator = Number(denominator) || 0;
  return denominator > 0 ? numerator / denominator : 0;
}

function analyzeEarlyRunner(history, data, config = CONFIG) {
  const observations = Array.isArray(history) ? history.filter(Boolean) : [];
  const current = data || {};
  const liquidity = Number(current.liquidityUsd) || 0;
  const volume5m = Number(current.volume5m) || 0;
  const volume1h = Number(current.volume1h) || 0;
  const volume24h = Number(current.volume24h) || 0; // context only
  const change5m = Number(current.priceChange5m) || 0;
  const change1h = Number(current.priceChange1h) || 0;
  const buys = Number(current.buys5m) || 0;
  const sells = Number(current.sells5m) || 0;
  const tx = buys + sells;
  const buyRatio = ratio(buys, tx);

  if (observations.length < config.minObservations) {
    return {
      signal: "WATCH",
      score: 0,
      reasons: ["Building short-term history"],
      metrics: { observations: observations.length, buyRatio }
    };
  }

  const window = observations.slice(-5);
  const first = window[0];
  const maxLiquidity = Math.max(...window.map(x => Number(x.liquidityUsd) || 0), liquidity);
  const liquidityGrowthPct = pctChange(liquidity, first.liquidityUsd);
  const volume5mGrowthPct = pctChange(volume5m, first.volume5m);
  const volume1hGrowthPct = pctChange(volume1h, first.volume1h);
  const volume24hGrowthPct = pctChange(volume24h, first.volume24h); // telemetry only
  const liquidityDrawdownPct = maxLiquidity > 0
    ? ((maxLiquidity - liquidity) / maxLiquidity) * 100
    : 0;
  const volume5mLiquidityPct = liquidity > 0 ? (volume5m / liquidity) * 100 : 0;

  const reasons = [];
  let score = 0;

  if (liquidityGrowthPct !== null && liquidityGrowthPct >= config.minLiquidityGrowthPct) {
    score += 3;
    reasons.push("Liquidity expanding across scans");
  } else {
    reasons.push("Liquidity not accelerating enough");
  }

  if (volume5mGrowthPct !== null && volume5mGrowthPct >= config.minVolume5mGrowthPct) {
    score += 4;
    reasons.push("5m volume accelerating across scans");
  } else {
    reasons.push("5m volume not accelerating enough");
  }

  if (volume1hGrowthPct !== null && volume1hGrowthPct >= config.supportVolume1hGrowthPct) {
    score += 1;
    reasons.push("1h activity confirms short-term expansion");
  }

  if (volume5mLiquidityPct >= config.minVolume5mLiquidityPct) {
    score += 2;
    reasons.push("Current 5m activity is meaningful versus liquidity");
  } else {
    reasons.push("Current 5m activity is weak versus liquidity");
  }

  if (tx >= config.minTransactions5m) {
    score += 1;
    reasons.push("Recent transaction count confirmed");
  } else {
    reasons.push("Insufficient recent transactions");
  }

  if (buyRatio >= config.minBuyRatio && buyRatio <= config.maxBuyRatio) {
    score += 2;
    reasons.push("Sustainable buy pressure");
  } else if (buyRatio > config.maxBuyRatio) {
    reasons.push("Possible buying frenzy");
  } else {
    reasons.push("Buy pressure too weak");
  }

  const shortTermExtended = change5m >= config.maxChange5m;
  const hourExtended = change1h > config.maxChange1h;

  if (change5m >= config.minChange5m && change5m < config.maxChange5m) {
    score += 2;
    reasons.push("Early price acceleration without chase");
  } else if (shortTermExtended) {
    reasons.push("Price is hot: wait for reset instead of chasing");
  } else {
    reasons.push("Price acceleration not confirmed");
  }

  const metrics = {
    observations: window.length,
    liquidityGrowthPct,
    volume5mGrowthPct,
    volume1hGrowthPct,
    volume24hGrowthPct,
    liquidityDrawdownPct,
    volume5mLiquidityPct,
    buyRatio,
    tx
  };

  if (liquidityDrawdownPct > config.maxLiquidityDrawdownPct) {
    return {
      signal: "AVOID",
      score,
      reasons: [...reasons, "Liquidity is draining from the recent high"],
      metrics
    };
  }

  const strongLiveExpansion =
    liquidityGrowthPct !== null &&
    liquidityGrowthPct >= config.minLiquidityGrowthPct &&
    volume5mGrowthPct !== null &&
    volume5mGrowthPct >= config.minVolume5mGrowthPct &&
    volume5m >= config.minVolume5mToEnter &&
    volume5mLiquidityPct >= config.minVolume5mLiquidityPct &&
    tx >= config.minTransactions5m &&
    buyRatio >= config.minBuyRatio &&
    buyRatio <= config.maxBuyRatio;

  // Do not erase a strong runner just because price is already hot.
  // Keep tracking it and allow a later entry only after it cools back under
  // the normal non-chase threshold while the live expansion still exists.
  if ((shortTermExtended || hourExtended) && strongLiveExpansion) {
    return {
      signal: "EXTENDED-WATCH",
      score,
      reasons: [...reasons, "Strong live expansion detected; waiting for a non-chasing reset"],
      metrics
    };
  }

  if (shortTermExtended || hourExtended) {
    return {
      signal: "EXTENDED",
      score,
      reasons: [...reasons, "Move is extended without enough live expansion for a runner watch"],
      metrics
    };
  }

  const entryReady =
    liquidity >= config.minLiquidityToEnter &&
    volume5m >= config.minVolume5mToEnter &&
    tx >= config.minTransactions5m &&
    buyRatio >= config.minBuyRatio &&
    buyRatio <= config.maxBuyRatio &&
    change5m >= config.minChange5m &&
    change5m < config.maxChange5m &&
    change1h > 0 &&
    change1h <= config.maxChange1h &&
    liquidityGrowthPct !== null &&
    liquidityGrowthPct >= config.minLiquidityGrowthPct &&
    volume5mGrowthPct !== null &&
    volume5mGrowthPct >= config.minVolume5mGrowthPct &&
    volume5mLiquidityPct >= config.minVolume5mLiquidityPct &&
    liquidityDrawdownPct <= config.maxLiquidityDrawdownPct;

  return {
    signal: entryReady ? "EARLY RUNNER" : "WATCH",
    score,
    reasons,
    metrics
  };
}

module.exports = { CONFIG, analyzeEarlyRunner };
