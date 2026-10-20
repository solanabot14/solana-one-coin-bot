const CONFIG = require("./profitSniperConfig");
const MAX_PAIR_AGE_MS = CONFIG.MAX_PAIR_AGE_MS;
const MIN_PAIR_AGE_MS = CONFIG.MIN_PAIR_AGE_MS;
const MIN_LIQUIDITY_USD = CONFIG.MIN_LIQUIDITY_USD;
const MIN_VOLUME_5M_USD = CONFIG.MIN_VOLUME_5M_USD;
const MIN_TRANSACTIONS_5M = CONFIG.MIN_TRANSACTIONS_5M;
const MIN_BUY_RATIO_5M = CONFIG.MIN_BUY_SHARE_5M;
const MAX_ENTRY_MOMENTUM_5M_PERCENT = CONFIG.MAX_ENTRY_MOMENTUM_5M_PERCENT;
const MAX_ENTRY_MOMENTUM_1H_PERCENT = CONFIG.MAX_ENTRY_MOMENTUM_1H_PERCENT;
const RECOVERY_REENTRY_MIN_PULLBACK_PERCENT = CONFIG.RECOVERY_REENTRY_MIN_PULLBACK_PERCENT;
const RECOVERY_REENTRY_MIN_BUY_SHARE = CONFIG.RECOVERY_REENTRY_MIN_BUY_SHARE;
const HARD_STOP_PERCENT = -6;
const MIN_EXIT_LIQUIDITY_USD = 1000;
const MAX_EXIT_LIQUIDITY_DRAWDOWN = 0.25;
const BLOCKED_TOKEN_ADDRESSES = new Set(["EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J"]);
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 60;
const TAKE_PROFIT_2_PERCENT = 20;
const TAKE_PROFIT_2_SELL_PERCENT = 30;
const TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT = TAKE_PROFIT_1_SELL_PERCENT + TAKE_PROFIT_2_SELL_PERCENT;
const TRAILING_STOP_PERCENT = 6;
const EARLY_PROFIT_PROTECTION_ACTIVATION_PERCENT = 8;
const EARLY_PROFIT_PROTECTION_PULLBACK_PERCENT = 6;
const STRATEGY_CHANGE_ACTIVATED_AT = "2026-10-20T18:12:00-04:00";
const PROFIT_FLOOR_AFTER_TP1_PERCENT = 0;
const COMPOUND_RATES = [0.10];
const MINIMUM_TRADE_USD = 10;

// Deep-pullback recovery positions are managed as momentum runners: keep 100%
// while they are still making progress, then sell all when the advance stalls.
const RECOVERY_EXHAUSTION_ARM_PROFIT_PERCENT = 10;
const RECOVERY_EXHAUSTION_STALL_MS = 45 * 1000;
const RECOVERY_EXHAUSTION_SAMPLE_MS = 20 * 1000;
const RECOVERY_EXHAUSTION_MAX_RECENT_GAIN_PERCENT = 0.20;
const RECOVERY_EXHAUSTION_MEANINGFUL_NEW_HIGH_PERCENT = 0.20;
const recoveryExitState = new Map();

function isConfirmedRecoveryEntry(coin, buyRatio) {
  const pattern = coin?.momentumPattern;
  const retracePercent = Number(pattern?.retracePercent);
  return pattern?.ready === true &&
    pattern?.recovering === true &&
    pattern?.pullbackObserved === true &&
    pattern?.strongActivityContinuation === true &&
    pattern?.liquidityRetained === true &&
    Number.isFinite(retracePercent) && retracePercent >= RECOVERY_REENTRY_MIN_PULLBACK_PERCENT &&
    buyRatio >= RECOVERY_REENTRY_MIN_BUY_SHARE;
}

function isRecoveryRunnerPosition(position) {
  const reasons = Array.isArray(position?.entryReasons) ? position.entryReasons : [];
  const localRecovery = reasons.some(reason => /CONFIRMED ACTIVITY ENTRY:\s*local_recovery/i.test(String(reason)));
  const overextendedRecovery = Number(position?.entryPriceChange5m) > MAX_ENTRY_MOMENTUM_5M_PERCENT ||
    Number(position?.entryPriceChange1h) > MAX_ENTRY_MOMENTUM_1H_PERCENT;
  return localRecovery || overextendedRecovery;
}

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
  const confirmedRecoveryEntry = isConfirmedRecoveryEntry(coin, buyRatio);

  const ageValid = Number.isFinite(createdAt) && ageMs >= MIN_PAIR_AGE_MS && ageMs <= MAX_PAIR_AGE_MS;
  if (!ageValid) failures.push("age");
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) failures.push("liquidity");
  if (!Number.isFinite(volume5m) || volume5m < MIN_VOLUME_5M_USD) failures.push("volume5m");
  if (!Number.isFinite(transactions5m) || transactions5m < MIN_TRANSACTIONS_5M) failures.push("transactions5m");
  if (buyRatio < MIN_BUY_RATIO_5M) failures.push("buyRatio5m");
  if (!Number.isFinite(momentum5m)) failures.push("momentum5m");
  if (!confirmedRecoveryEntry && Number.isFinite(momentum5m) && momentum5m > MAX_ENTRY_MOMENTUM_5M_PERCENT)
    failures.push("overextendedMomentum5m");
  if (!confirmedRecoveryEntry && Number.isFinite(momentum1h) && momentum1h > MAX_ENTRY_MOMENTUM_1H_PERCENT)
    failures.push("overextendedMomentum1h");
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
  const compoundRate = COMPOUND_RATES[0];
  return { amountInvested: Math.max(MINIMUM_TRADE_USD, equity * compoundRate), compoundRate };
}

function getRecoveryExhaustionExit(position, price, high, highProfitPercent, freshData, now) {
  if (!isRecoveryRunnerPosition(position)) return null;
  const key = String(position?.id || position?.positionId || position?.tokenAddress || "");
  if (!key) return null;

  let state = recoveryExitState.get(key);
  if (!state) {
    state = { trackedHigh: high > 0 ? high : price, lastMeaningfulHighAt: now, samples: [] };
  }
  if (price >= state.trackedHigh * (1 + RECOVERY_EXHAUSTION_MEANINGFUL_NEW_HIGH_PERCENT / 100)) {
    state.trackedHigh = price;
    state.lastMeaningfulHighAt = now;
  } else if (high > state.trackedHigh * (1 + RECOVERY_EXHAUSTION_MEANINGFUL_NEW_HIGH_PERCENT / 100)) {
    state.trackedHigh = high;
    state.lastMeaningfulHighAt = now;
  }

  state.samples.push({ at: now, price });
  state.samples = state.samples.filter(sample => now - sample.at <= RECOVERY_EXHAUSTION_SAMPLE_MS);
  recoveryExitState.set(key, state);

  if (highProfitPercent < RECOVERY_EXHAUSTION_ARM_PROFIT_PERCENT) return null;
  const stalledMs = now - state.lastMeaningfulHighAt;
  if (stalledMs < RECOVERY_EXHAUSTION_STALL_MS) return null;

  const oldest = state.samples[0];
  const recentGainPercent = oldest?.price > 0 ? (price / oldest.price - 1) * 100 : 0;
  const buys5m = Number(freshData?.buys5m) || 0;
  const sells5m = Number(freshData?.sells5m) || 0;
  const transactions5m = buys5m + sells5m;
  const buyRatio = transactions5m > 0 ? buys5m / transactions5m : 0;
  const momentum5m = Number(freshData?.priceChange5m);
  const slowing = recentGainPercent <= RECOVERY_EXHAUSTION_MAX_RECENT_GAIN_PERCENT ||
    (Number.isFinite(momentum5m) && momentum5m <= 0) ||
    (transactions5m >= MIN_TRANSACTIONS_5M && buyRatio < RECOVERY_REENTRY_MIN_BUY_SHARE);

  if (!slowing) return null;
  recoveryExitState.delete(key);
  return {
    percent: 100,
    reason: `RECOVERY MOMENTUM EXHAUSTION - SELL 100% AFTER ${Math.round(stalledMs / 1000)}s WITHOUT NEW HIGH`
  };
}

function chooseExit({ position, currentPrice, freshData, exitProgress, now = Date.now() }) {
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
    : (position.secondTakeProfitDone ? TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT : position.firstTakeProfitDone ? TAKE_PROFIT_1_SELL_PERCENT : 0);
  const high = Number(position.highestPrice);
  const highProfitPercent = high > 0 ? (high - entryPrice) / entryPrice * 100 : profitPercent;
  const pullbackFromHighPercent = high > 0 ? (high - price) / high * 100 : 0;
  const recoveryRunner = isRecoveryRunnerPosition(position);

  // Recovery-wave entries keep the entire position while price is still advancing.
  // Once the move has produced at least +10%, 45 seconds without a meaningful
  // new high plus flat/weakening short-term action is treated as exhaustion.
  if (recoveryRunner) {
    const exhaustionExit = getRecoveryExhaustionExit(position, price, high, highProfitPercent, freshData, now);
    if (exhaustionExit) return exhaustionExit;
  }

  if (!recoveryRunner && soldPercent + 1e-6 >= TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT) {
    return pullbackFromHighPercent >= TRAILING_STOP_PERCENT
      ? { percent: 100, triggerPrice: high * (1 - TRAILING_STOP_PERCENT / 100), reason: `TRAILING STOP -${TRAILING_STOP_PERCENT}% FROM HIGH` }
      : null;
  }

  // Keep the existing crash protection for both normal and recovery positions.
  if (highProfitPercent + 1e-9 >= EARLY_PROFIT_PROTECTION_ACTIVATION_PERCENT &&
      pullbackFromHighPercent + 1e-9 >= EARLY_PROFIT_PROTECTION_PULLBACK_PERCENT) {
    recoveryExitState.delete(String(position?.id || position?.positionId || position?.tokenAddress || ""));
    return {
      percent: 100,
      triggerPrice: high * (1 - EARLY_PROFIT_PROTECTION_PULLBACK_PERCENT / 100),
      reason: `EARLY PROFIT PROTECTION -${EARLY_PROFIT_PROTECTION_PULLBACK_PERCENT}% FROM HIGH AFTER +${EARLY_PROFIT_PROTECTION_ACTIVATION_PERCENT}% PEAK`
    };
  }

  if (profitPercent <= HARD_STOP_PERCENT) {
    recoveryExitState.delete(String(position?.id || position?.positionId || position?.tokenAddress || ""));
    return { percent: 100, triggerPrice: entryPrice * (1 + HARD_STOP_PERCENT / 100), reason: "HARD STOP -6%" };
  }

  // Normal entries keep the established 60% / 30% / 10% exit ladder.
  if (!recoveryRunner && soldPercent + 1e-6 < TAKE_PROFIT_1_SELL_PERCENT && profitPercent + 1e-9 >= TAKE_PROFIT_1_PERCENT)
    return { targetOriginalPositionPercent: TAKE_PROFIT_1_SELL_PERCENT, triggerPrice: entryPrice * (1 + TAKE_PROFIT_1_PERCENT / 100), reason: "TAKE PROFIT 1 - SELL 60% OF ORIGINAL POSITION AT +15%", takeProfit: "firstTakeProfitDone" };
  if (!recoveryRunner && soldPercent + 1e-6 >= TAKE_PROFIT_1_SELL_PERCENT &&
      soldPercent + 1e-6 < TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT &&
      profitPercent + 1e-9 >= TAKE_PROFIT_2_PERCENT)
    return { targetOriginalPositionPercent: TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT, triggerPrice: entryPrice * (1 + TAKE_PROFIT_2_PERCENT / 100), reason: "TAKE PROFIT 2 - SELL 30% OF ORIGINAL POSITION AT +20%", takeProfit: "secondTakeProfitDone" };
  return null;
}

module.exports = {
  constants: { MAX_PAIR_AGE_MS, MIN_PAIR_AGE_MS, MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD,
    MIN_TRANSACTIONS_5M, MIN_BUY_RATIO_5M, MAX_ENTRY_MOMENTUM_5M_PERCENT, MAX_ENTRY_MOMENTUM_1H_PERCENT,
    RECOVERY_REENTRY_MIN_PULLBACK_PERCENT, RECOVERY_REENTRY_MIN_BUY_SHARE,
    HARD_STOP_PERCENT, MIN_EXIT_LIQUIDITY_USD,
    MAX_EXIT_LIQUIDITY_DRAWDOWN,
    TAKE_PROFIT_1_PERCENT, TAKE_PROFIT_1_SELL_PERCENT, TAKE_PROFIT_2_PERCENT,
    TAKE_PROFIT_2_SELL_PERCENT, TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT, TRAILING_STOP_PERCENT,
    EARLY_PROFIT_PROTECTION_ACTIVATION_PERCENT, EARLY_PROFIT_PROTECTION_PULLBACK_PERCENT,
    RECOVERY_EXHAUSTION_ARM_PROFIT_PERCENT, RECOVERY_EXHAUSTION_STALL_MS,
    RECOVERY_EXHAUSTION_SAMPLE_MS, RECOVERY_EXHAUSTION_MAX_RECENT_GAIN_PERCENT,
    STRATEGY_CHANGE_ACTIVATED_AT, PROFIT_FLOOR_AFTER_TP1_PERCENT, COMPOUND_RATES, MINIMUM_TRADE_USD },
  qualifiesMomentumCandidate,
  selectUniqueMintCandidates,
  getMomentumFailureReasons,
  getBuySizing,
  isConfirmedRecoveryEntry,
  isRecoveryRunnerPosition,
  chooseExit
};
