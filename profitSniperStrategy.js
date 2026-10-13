const MAX_PAIR_AGE_MS = 30 * 60 * 1000;
const MIN_LIQUIDITY_USD = 15000;
const MIN_VOLUME_24H_USD = 0;
const MIN_VOLUME_5M_USD = 1500;
const MIN_TRANSACTIONS_5M = 12;
const MIN_BUY_RATIO_5M = 0.55;
const MIN_MOMENTUM_5M = 0.05;
const MAX_MOMENTUM_5M = 20;
const HARD_STOP_PERCENT = -8;
const MIN_EXIT_LIQUIDITY_USD = 1000;
const BLOCKED_TOKEN_ADDRESSES = new Set(["EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J"]);
const TAKE_PROFIT_1_PERCENT = 10;
const TAKE_PROFIT_1_SELL_PERCENT = 50;
const TAKE_PROFIT_2_PERCENT = 20;
const TAKE_PROFIT_2_SELL_PERCENT = 100;
const TRAILING_STOP_PERCENT = 0;
const PROFIT_FLOOR_AFTER_TP1_PERCENT = 2;
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

  if (!Number.isFinite(createdAt) || ageMs < 0 || ageMs > MAX_PAIR_AGE_MS) failures.push("age");
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) failures.push("liquidity");
  if (!Number.isFinite(volume24h) || volume24h < MIN_VOLUME_24H_USD) failures.push("volume24h");
  if (!Number.isFinite(volume5m) || volume5m < MIN_VOLUME_5M_USD) failures.push("volume5m");
  if (!Number.isFinite(transactions5m) || transactions5m < MIN_TRANSACTIONS_5M) failures.push("transactions5m");
  if (buyRatio < MIN_BUY_RATIO_5M) failures.push("buyRatio5m");
  if (!Number.isFinite(momentum5m) || momentum5m < MIN_MOMENTUM_5M || momentum5m > MAX_MOMENTUM_5M) failures.push("momentum5m");
  if (!coin.tokenAddress) failures.push("tokenAddress");
  if (BLOCKED_TOKEN_ADDRESSES.has(coin.tokenAddress)) failures.push("blockedTokenAddress");
  return failures;
}

function qualifiesMomentumCandidate(coin, now = Date.now()) {
  return getMomentumFailureReasons(coin, now).length === 0;
}

function getBuySizing(state) {
  const positions = Array.isArray(state.positions) ? state.positions : (state.position ? [state.position] : []);
  const equity = Number(state.cashBalance || 0) + positions.reduce((sum, position) => sum + Number(position.amountInvested || 0), 0);
  const successfulEntries = (Array.isArray(state.history) ? state.history : []).filter(row => row && row.type === "BUY").length;
  const compoundRate = COMPOUND_RATES[successfulEntries % COMPOUND_RATES.length];
  return { amountInvested: Math.max(MINIMUM_TRADE_USD, equity * compoundRate), compoundRate };
}

function chooseExit({ position, currentPrice, freshData }) {
  const liquidityRaw = freshData?.liquidityUsd;
  const currentLiquidity = Number(liquidityRaw);
  if (liquidityRaw !== null && liquidityRaw !== undefined &&
      Number.isFinite(currentLiquidity) && currentLiquidity <= MIN_EXIT_LIQUIDITY_USD) {
    return { percent: 100, writeOff: true, reason: "EMERGENCY WRITE-OFF: NO EXECUTABLE LIQUIDITY" };
  }
  const entryPrice = Number(position && position.entryPrice);
  const price = Number(currentPrice);
  if (!(entryPrice > 0) || !(price > 0)) return null;
  if (Number.isFinite(currentLiquidity) && currentLiquidity > 0 &&
      Number(position.quantity) * price >= currentLiquidity / 2) {
    return { percent: 100, writeOff: true, reason: "UNEXECUTABLE QUOTE: POSITION EXCEEDS POOL CAPACITY" };
  }
  const profitPercent = (price - entryPrice) / entryPrice * 100;

  // A position carrying the former second-target flag already passed +20%.
  // Exit all remaining units under the restored strategy instead of leaving a runner.
  if (position.secondTakeProfitDone) {
    return { percent: 100, reason: "ORIGINAL TAKE PROFIT 2 - EXIT REMAINDER" };
  }

  if (position.firstTakeProfitDone) {
    if (profitPercent <= PROFIT_FLOOR_AFTER_TP1_PERCENT) {
      return { percent: 100, reason: "PROFIT FLOOR AFTER TP1 +2%" };
    }
    if (profitPercent + 1e-9 >= TAKE_PROFIT_2_PERCENT) {
      return { percent: 100, reason: "TAKE PROFIT 2 - EXIT REMAINDER AT +20%" };
    }
    return null;
  }

  if (profitPercent <= HARD_STOP_PERCENT) return { percent: 100, reason: "HARD STOP -8%" };
  if (profitPercent + 1e-9 >= TAKE_PROFIT_1_PERCENT) {
    return {
      percent: TAKE_PROFIT_1_SELL_PERCENT,
      reason: "TAKE PROFIT 1 - SELL 50% OF ORIGINAL POSITION",
      takeProfit: "firstTakeProfitDone"
    };
  }
  return null;
}

module.exports = {
  constants: { MAX_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, MIN_VOLUME_5M_USD,
    MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MIN_MOMENTUM_5M, MAX_MOMENTUM_5M, HARD_STOP_PERCENT, MIN_EXIT_LIQUIDITY_USD,
    TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
    TAKE_PROFIT_2_SELL_PERCENT, TRAILING_STOP_PERCENT, PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD },
  qualifiesMomentumCandidate,
  getMomentumFailureReasons,
  getBuySizing,
  chooseExit
};
