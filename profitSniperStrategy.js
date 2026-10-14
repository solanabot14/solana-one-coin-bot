const MAX_PAIR_AGE_MS = 6 * 60 * 60 * 1000;
const MIN_PAIR_AGE_MS = 0;
const MIN_LIQUIDITY_USD = 3000;
const MIN_VOLUME_24H_USD = 500;
const MAX_VOLUME_TO_LIQUIDITY = 100;
const MIN_VOLUME_5M_USD = 300;
const MIN_TRANSACTIONS_5M = 6;
const MIN_BUY_RATIO_5M = 0.15;
const MIN_MOMENTUM_5M = 0.05;
const MAX_MOMENTUM_5M = 35;
const HARD_STOP_PERCENT = -8;
const MIN_EXIT_LIQUIDITY_USD = 1000;
const MAX_EXIT_LIQUIDITY_DRAWDOWN = 0.25;
const BLOCKED_TOKEN_ADDRESSES = new Set(["EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J"]);
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 40;
const TAKE_PROFIT_2_PERCENT = 25;
const TAKE_PROFIT_2_SELL_PERCENT = (40 / 60) * 100;
const TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT = 80;
const TRAILING_STOP_PERCENT = 12;
const PROFIT_FLOOR_AFTER_TP1_PERCENT = 0;
const COMPOUND_RATES = [0.10, 0.125, 0.15];
const MINIMUM_TRADE_USD = 10;

function getMomentumFailureReasons(coin, now = Date.now()) {
  if (!coin || typeof coin !== "object") return ["missing_candidate"];
  const failures = [];
  const createdAt = Number(coin.pairCreatedAt);
  const ageMs = now - createdAt;
  const liquidity = Number(coin.liquidityUsd);
  const volume24h = Number(coin.volume24h);
  const volume5m = Number(coin.volume5m);
  const buys5m = Number(coin.buys5m);
  const sells5m = Number(coin.sells5m);
  const transactions5m = buys5m + sells5m;
  const buyRatio = transactions5m > 0 ? buys5m / transactions5m : 0;
  const momentum5m = Number(coin.priceChange5m);

  if (!Number.isFinite(createdAt) || ageMs < MIN_PAIR_AGE_MS || ageMs > MAX_PAIR_AGE_MS) failures.push("age");
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) failures.push("liquidity");
  if (!Number.isFinite(volume24h) || volume24h < MIN_VOLUME_24H_USD) failures.push("volume24h");
  if (Number.isFinite(volume24h) && Number.isFinite(liquidity) && liquidity > 0 &&
      volume24h / liquidity > MAX_VOLUME_TO_LIQUIDITY) failures.push("volumeToLiquidity");
  if (!Number.isFinite(volume5m) || volume5m < MIN_VOLUME_5M_USD) failures.push("volume5m");
  if (!Number.isFinite(transactions5m) || transactions5m < MIN_TRANSACTIONS_5M) failures.push("transactions5m");
  if (buyRatio < MIN_BUY_RATIO_5M) failures.push("buyRatio5m");
  if (!Number.isFinite(momentum5m) || momentum5m < MIN_MOMENTUM_5M || momentum5m > MAX_MOMENTUM_5M) failures.push("momentum5m");
  if (!coin.tokenAddress) failures.push("tokenAddress");
  if (coin.chainId !== "solana") failures.push("chainId");
  if (!coin.pairAddress) failures.push("pairAddress");
  if (BLOCKED_TOKEN_ADDRESSES.has(coin.tokenAddress)) failures.push("blockedTokenAddress");
  return failures;
}

function qualifiesMomentumCandidate(coin, now = Date.now()) {
  return getMomentumFailureReasons(coin, now).length === 0;
}

function selectUniqueMintCandidates(candidates = []) {
  const bestByMint = new Map();
  for (const coin of candidates) {
    if (!coin || coin.chainId !== "solana" || !coin.tokenAddress || !coin.pairAddress) continue;
    const mint = String(coin.tokenAddress);
    const current = bestByMint.get(mint);
    const score = Number(coin.score) || 0;
    const volume = Number(coin.volume5m) || 0;
    if (!current || score > (Number(current.score) || 0) ||
        (score === (Number(current.score) || 0) && volume > (Number(current.volume5m) || 0))) {
      bestByMint.set(mint, coin);
    }
  }
  return [...bestByMint.values()];
}

function getBuySizing(state = {}) {
  const positions = Array.isArray(state.positions) ? state.positions : (state.position ? [state.position] : []);
  const equity = Number(state.cashBalance || 0) +
    positions.reduce((sum, position) => sum + Number(position.amountInvested || 0), 0);
  const successfulEntries = (Array.isArray(state.history) ? state.history : [])
    .filter(row => row && row.type === "BUY").length;
  const compoundRate = COMPOUND_RATES[successfulEntries % COMPOUND_RATES.length];
  return { amountInvested: Math.max(MINIMUM_TRADE_USD, equity * compoundRate), compoundRate };
}

function chooseExit({ position, currentPrice, freshData, exitProgress }) {
  const liquidityRaw = freshData?.liquidityUsd;
  const currentLiquidity = Number(liquidityRaw);
  if (liquidityRaw !== null && liquidityRaw !== undefined &&
      Number.isFinite(currentLiquidity) && currentLiquidity <= MIN_EXIT_LIQUIDITY_USD)
    return { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" };
  const entryLiquidity = Number(position?.entryLiquidityUsd);
  if (Number.isFinite(currentLiquidity) && currentLiquidity > MIN_EXIT_LIQUIDITY_USD &&
      entryLiquidity > 0 && currentLiquidity < entryLiquidity * (1 - MAX_EXIT_LIQUIDITY_DRAWDOWN))
    return { percent: 100, reason: "EMERGENCY EXIT: POOL LIQUIDITY DOWN 25%" };
  const entryPrice = Number(position?.entryPrice), price = Number(currentPrice);
  if (!(entryPrice > 0) || !(price > 0)) return null;
  if (Number.isFinite(currentLiquidity) && currentLiquidity > 0 &&
      Number(position.quantity) * price >= currentLiquidity / 2)
    return { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" };
  const profitPercent = (price - entryPrice) / entryPrice * 100;
  const soldPercent = Number.isFinite(Number(exitProgress?.soldPercent))
    ? Number(exitProgress.soldPercent)
    : (position.secondTakeProfitDone ? 80 : position.firstTakeProfitDone ? 40 : 0);
  if (soldPercent + 1e-6 >= TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT) {
    const high = Number(position.highestPrice);
    const pullback = high > 0 ? (high - price) / high * 100 : 0;
    return pullback >= TRAILING_STOP_PERCENT ? { percent: 100, reason: "TRAILING STOP -12% FROM HIGH" } : null;
  }
  if (profitPercent <= HARD_STOP_PERCENT) return { percent: 100, reason: "HARD STOP -8%" };
  if (soldPercent + 1e-6 < TAKE_PROFIT_1_SELL_PERCENT && profitPercent + 1e-9 >= TAKE_PROFIT_1_PERCENT)
    return { targetOriginalPositionPercent: 40, reason: "TAKE PROFIT 1 - SELL 40% OF ORIGINAL POSITION AT +15%", takeProfit: "firstTakeProfitDone" };
  if (soldPercent + 1e-6 < TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT && profitPercent + 1e-9 >= TAKE_PROFIT_2_PERCENT)
    return { targetOriginalPositionPercent: 80, reason: "TAKE PROFIT 2 - SELL ANOTHER 40% OF ORIGINAL POSITION AT +25%", takeProfit: "secondTakeProfitDone" };
  return null;
}

module.exports = {
  constants: { MAX_PAIR_AGE_MS, MIN_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MAX_VOLUME_TO_LIQUIDITY, MIN_VOLUME_5M_USD,
    MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MIN_MOMENTUM_5M, MAX_MOMENTUM_5M,
    HARD_STOP_PERCENT, MIN_EXIT_LIQUIDITY_USD,
    MAX_EXIT_LIQUIDITY_DRAWDOWN,
    TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
    TAKE_PROFIT_2_SELL_PERCENT, TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT, TRAILING_STOP_PERCENT, PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD },
  qualifiesMomentumCandidate,
  selectUniqueMintCandidates,
  getMomentumFailureReasons,
  getBuySizing,
  chooseExit
};

