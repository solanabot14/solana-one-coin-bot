const CONFIG = require("./profitSniperConfig");
const MAX_PAIR_AGE_MS = CONFIG.MAX_PAIR_AGE_MS;
const MIN_PAIR_AGE_MS = CONFIG.MIN_PAIR_AGE_MS;
const MIN_LIQUIDITY_USD = CONFIG.MIN_LIQUIDITY_USD;
const MIN_VOLUME_5M_USD = CONFIG.MIN_VOLUME_5M_USD;
const MIN_TRANSACTIONS_5M = CONFIG.MIN_TRANSACTIONS_5M;
const MIN_BUY_RATIO_5M = CONFIG.MIN_BUY_SHARE_5M;
// Paper-test trend context gate. Historical Sniper entries with a negative
// 1h change were materially loss-making; do not infer a 5m trend filter from
// the same sample because negative-5m recovery entries also produced winners.
const MIN_ENTRY_PRICE_CHANGE_1H_PERCENT = 0;
const HARD_STOP_PERCENT = -5;
const MIN_EXIT_LIQUIDITY_USD = 1000;
const MAX_EXIT_LIQUIDITY_DRAWDOWN = 0.25;
const BLOCKED_TOKEN_ADDRESSES = new Set(["EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J"]);
const TAKE_PROFIT_1_PERCENT = 20;
const TAKE_PROFIT_1_SELL_PERCENT = 90;
// The single target sells 90% of the original position. The final 10% is
// managed as a runner once that sale is recorded.
const TAKE_PROFIT_2_PERCENT = null;
const TAKE_PROFIT_2_SELL_PERCENT = 0;
const TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT = 90;
const TRAILING_STOP_PERCENT = 10;

const COMPOUND_RATES = [0.10];
const MINIMUM_TRADE_USD = 20;

function getMomentumFailureReasons(coin, now = Date.now()) {
  if (!coin || typeof coin !== "object") return ["missing_candidate"];
  const failures = [];
  const createdAt = Number(coin.pairCreatedAt);
  const ageMs = now - createdAt;
  const liquidity = Number(coin.liquidityUsd);
  const volume5m = Number(coin.volume5m);
  const buys5m = Number(coin.buys5m);
  const sells5m = Number(coin.sells5m);
  const transactions5m = buys5m + sells5m;
  const buyRatio = transactions5m > 0 ? buys5m / transactions5m : 0;
  const momentum5m = Number(coin.priceChange5m);
  const momentum1h = Number(coin.priceChange1h);

  const ageValid = Number.isFinite(createdAt) && ageMs >= MIN_PAIR_AGE_MS && ageMs <= MAX_PAIR_AGE_MS;
  if (!ageValid) failures.push("age");
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) failures.push("liquidity");
  if (!Number.isFinite(volume5m) || volume5m < MIN_VOLUME_5M_USD) failures.push("volume5m");
  if (!Number.isFinite(transactions5m) || transactions5m < MIN_TRANSACTIONS_5M) failures.push("transactions5m");
  if (buyRatio < MIN_BUY_RATIO_5M) failures.push("buyRatio5m");
  if (!Number.isFinite(momentum5m)) failures.push("momentum5m");
  if (Number.isFinite(momentum1h) && momentum1h < MIN_ENTRY_PRICE_CHANGE_1H_PERCENT)
    failures.push("momentum1hDowntrend");
  if (ageValid && coin.momentumPattern?.ready !== true)
    failures.push("momentumPattern");
  if (coin.momentumPattern?.observedAt !== undefined &&
      (!Number.isFinite(Number(coin.momentumPattern.observedAt)) || now-Number(coin.momentumPattern.observedAt)>75000))
    failures.push("staleMomentumConfirmation");
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
  const completedAndOpenBuys = Array.isArray(state.history)
    ? state.history.filter(row => row?.type === "BUY").length
    : 0;
  const compoundRate = COMPOUND_RATES[completedAndOpenBuys % COMPOUND_RATES.length];
  return {
    amountInvested: Math.max(MINIMUM_TRADE_USD, equity * compoundRate),
    compoundRate,
    compoundStep: completedAndOpenBuys % COMPOUND_RATES.length
  };
}

function wholeTradeNetPnlAtExit(position, history, currentPrice, liquidityUsd, estimateExecutionCosts) {
  if (!position?.id || !Array.isArray(history) || typeof estimateExecutionCosts !== "function") return null;
  const buys = history.filter(row => row?.type === "BUY" && row.positionId === position.id);
  const sells = history.filter(row => row?.type === "SELL" && row.positionId === position.id);
  const initialBuy = buys[0];
  const originalCostBasis = Number(initialBuy?.amountInvested);
  if (!(originalCostBasis > 0)) return null;

  const realizedNetPnl = sells.reduce((sum, row) => sum + Number(row.netPnl ?? row.pnl ?? 0), 0);
  const remainingQuantity = Number(position.quantity);
  const remainingCostBasis = Number(position.amountInvested);
  if (!(remainingQuantity > 0) || !(remainingCostBasis >= 0)) return null;

  const remainingSaleValue = remainingQuantity * currentPrice;
  const exitCosts = estimateExecutionCosts({
    side: "SELL",
    amountUsd: remainingSaleValue,
    liquidityUsd: Number(liquidityUsd) || Number(position.entryLiquidityUsd),
    priceUsd: currentPrice,
    position
  });
  if (!exitCosts || !Number.isFinite(Number(exitCosts.feesUsd)) || !Number.isFinite(Number(exitCosts.slippageUsd))) return null;

  const initialCosts = initialBuy.entryExecutionCosts || {};
  const remainingCosts = position.remainingEntryCosts || {
    feesUsd: Number(initialCosts.feesUsd) * remainingQuantity / Number(initialBuy.quantity || remainingQuantity),
    slippageUsd: Number(initialCosts.slippageUsd) * remainingQuantity / Number(initialBuy.quantity || remainingQuantity)
  };
  const entryCosts = Number(remainingCosts.feesUsd || 0) + Number(remainingCosts.slippageUsd || 0);
  const saleCosts = Number(exitCosts.feesUsd) + Number(exitCosts.slippageUsd);
  const projectedNetPnl = realizedNetPnl + remainingSaleValue - remainingCostBasis - entryCosts - saleCosts;
  return Number.isFinite(projectedNetPnl) ? { projectedNetPnl, originalCostBasis } : null;
}

function chooseExit({ position, currentPrice, freshData, exitProgress, history, estimateExecutionCosts }) {
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
    : (position.secondTakeProfitDone ? 80 : position.firstTakeProfitDone ? 50 : 0);
  if (profitPercent <= HARD_STOP_PERCENT) return { percent: 100, triggerPrice: entryPrice * (1 + HARD_STOP_PERCENT / 100), reason: "HARD STOP -5%" };
  if (soldPercent + 1e-6 >= TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT) {
    const high = Number(position.highestPrice);
    const pullback = high > 0 ? (high - price) / high * 100 : 0;
    return pullback >= TRAILING_STOP_PERCENT
      ? { percent: 100, triggerPrice: high * (1 - TRAILING_STOP_PERCENT / 100), reason: `TRAILING STOP -${TRAILING_STOP_PERCENT}% FROM HIGH` } : null;
  }
  if (soldPercent + 1e-6 < TAKE_PROFIT_1_SELL_PERCENT && profitPercent + 1e-9 >= TAKE_PROFIT_1_PERCENT)
    return { targetOriginalPositionPercent: TAKE_PROFIT_1_SELL_PERCENT, triggerPrice: entryPrice * (1 + TAKE_PROFIT_1_PERCENT / 100), reason: "TAKE PROFIT - SELL 90% OF ORIGINAL POSITION AT +20%", takeProfit: "firstTakeProfitDone" };
  return null;
}

module.exports = {
  constants: { MAX_PAIR_AGE_MS, MIN_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD,
    MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M,
    HARD_STOP_PERCENT, MIN_EXIT_LIQUIDITY_USD, MIN_ENTRY_PRICE_CHANGE_1H_PERCENT,
    MAX_EXIT_LIQUIDITY_DRAWDOWN,
    TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
    TAKE_PROFIT_2_SELL_PERCENT, TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT, TRAILING_STOP_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD },
  qualifiesMomentumCandidate,
  selectUniqueMintCandidates,
  getMomentumFailureReasons,
  getBuySizing,
  chooseExit,
  wholeTradeNetPnlAtExit
};



