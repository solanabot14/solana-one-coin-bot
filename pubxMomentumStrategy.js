const MIN_LIQUIDITY_USD = 30000;
const MIN_VOLUME_5M_USD = 5000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.04;
const MIN_TRANSACTIONS_5M = 20;
const MIN_BUY_RATIO = 0.58;
const MIN_PRICE_CHANGE_5M = 0.75;
const MAX_PRICE_CHANGE_5M = 22;
const MAX_QUOTE_EXTENSION_PERCENT = 3;

function activity(coin) {
  const buys = Number(coin?.buys5m) || 0;
  const sells = Number(coin?.sells5m) || 0;
  const transactions = buys + sells;
  return { buys, sells, transactions, buyRatio: transactions ? buys / transactions : 0 };
}

function evaluateCandidate(coin) {
  const price = Number(coin?.priceUsd);
  const liquidity = Number(coin?.liquidityUsd) || 0;
  const volume5m = Number(coin?.volume5m) || 0;
  const change5m = Number(coin?.priceChange5m) || 0;
  const flow = activity(coin);
  const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
  const reject = reason => ({ eligible: false, reason, flow, requiredVolume });
  if (!coin?.tokenAddress || !coin?.pairAddress || !(price > 0)) return reject("MISSING_PAIR_OR_PRICE");
  if (liquidity < MIN_LIQUIDITY_USD) return reject("LIQUIDITY_TOO_LOW");
  if (volume5m < requiredVolume) return reject("5M_VOLUME_TOO_LOW");
  if (flow.transactions < MIN_TRANSACTIONS_5M) return reject("NOT_ENOUGH_5M_TRANSACTIONS");
  if (flow.buyRatio < MIN_BUY_RATIO) return reject("SELL_PRESSURE");
  if (change5m < MIN_PRICE_CHANGE_5M) return reject("MOMENTUM_NOT_ACTIVE");
  if (change5m > MAX_PRICE_CHANGE_5M) return reject("MOVE_TOO_EXTENDED");
  const reasons = [
    `5m volume $${volume5m.toFixed(0)} (${(volume5m / liquidity * 100).toFixed(1)}% of liquidity)`,
    `${flow.buys}/${flow.sells} 5m buy/sell transactions (${(flow.buyRatio * 100).toFixed(1)}% buys)`,
    `5m price momentum +${change5m.toFixed(2)}%`,
    "Transaction counts are used as flow proxy; unique buyer wallets are not available from this feed."
  ];
  return {
    eligible: true,
    rank: Math.log1p(volume5m) * 2 + flow.buyRatio * 8 + Math.min(change5m, 12) * 0.3 +
      Math.min(volume5m / liquidity, 1) * 4,
    reasons,
    flow,
    requiredVolume,
    change5m,
    volume5m
  };
}

function createPubxMomentumStrategy() {
  const priorSnapshots = new Map();
  let lastStats = { scanned: 0, qualified: 0, rejected: 0, strongestReason: null };

  function observe(candidates = [], now = Date.now()) {
    const unique = new Map();
    for (const coin of Array.isArray(candidates) ? candidates : []) {
      const key = coin?.tokenAddress;
      if (!key) continue;
      const current = evaluateCandidate(coin);
      const previous = priorSnapshots.get(key);
      if (current.eligible && previous && now > previous.at) {
        current.volumeGrowing = current.volume5m > previous.volume5m;
        current.rank += current.volumeGrowing ? 1 : 0;
      }
      if (Number.isFinite(Number(coin?.volume5m)) && Number.isFinite(Number(coin?.priceUsd))) {
        priorSnapshots.set(key, { at: now, volume5m: Number(coin.volume5m), priceUsd: Number(coin.priceUsd) });
      }
      if (!current.eligible) continue;
      const candidate = {
        ...coin,
        signal: "STRONG BUY",
        score: Math.round(current.rank * 10) / 10,
        reasons: [...(Array.isArray(coin.reasons) ? coin.reasons : []), ...current.reasons],
        experimentEntry: {
          model: "PUBX_FAST_MOMENTUM_V1",
          volume5mUsd: current.volume5m,
          volumeLiquidityRatio: current.volume5m / Number(coin.liquidityUsd),
          buys5m: current.flow.buys,
          sells5m: current.flow.sells,
          buyRatio: current.flow.buyRatio,
          priceChange5m: current.change5m,
          volumeGrowingSinceLastScan: !!current.volumeGrowing,
          observedAt: new Date(now).toISOString()
        }
      };
      const old = unique.get(key);
      if (!old || candidate.score > old.score) unique.set(key, candidate);
    }
    const ready = [...unique.values()].sort((a, b) => b.score - a.score);
    lastStats = { scanned: candidates.length, qualified: ready.length, rejected: Math.max(0, candidates.length - ready.length),
      strongestReason: ready[0]?.experimentEntry?.volumeGrowingSinceLastScan ? "5M_VOLUME_RISING" : "LIVE_MOMENTUM" };
    for (const [key, value] of priorSnapshots) if (now - value.at > 10 * 60 * 1000) priorSnapshots.delete(key);
    return ready;
  }

  return { observe, getStatus: () => ({ ...lastStats }), getTrackedTokens: () => [...priorSnapshots.keys()] };
}

module.exports = {
  MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD, MIN_VOLUME_LIQUIDITY_RATIO,
  MIN_TRANSACTIONS_5M, MIN_BUY_RATIO, MIN_PRICE_CHANGE_5M, MAX_PRICE_CHANGE_5M,
  MAX_QUOTE_EXTENSION_PERCENT, activity, evaluateCandidate, createPubxMomentumStrategy
};
