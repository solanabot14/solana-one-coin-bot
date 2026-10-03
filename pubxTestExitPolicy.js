const HARD_STOP_PERCENT = -6;
const FLOW_FADE_LOSS_PERCENT = -2.5;
const FLOW_FADE_5M_PERCENT = -2;
const FLOW_FADE_MIN_TRANSACTIONS = 8;
const FLOW_FADE_MAX_BUY_RATIO = 0.45;
const TAKE_PROFIT_PERCENT = 8;
const TAKE_PROFIT_SELL_PERCENT = 50;
const RUNNER_TRAIL_PERCENT = 5;
const RUNNER_PROTECTED_GAIN_PERCENT = 2;
const MAX_STALE_HOLD_MS = 8 * 60 * 1000;
const STALE_EXIT_MAX_GAIN_PERCENT = 2;
const STALE_EXIT_MAX_PEAK_GAIN_PERCENT = 5;
const MAX_HOLD_MS = 15 * 60 * 1000;

function createFastMomentumExitPolicy() {
  return ({ position, profitPercent, dropFromHigh, highestProfitPercent, freshData, now = Date.now() }) => {
    if (profitPercent <= HARD_STOP_PERCENT) {
      return { percent: 100, reason: "FAST MOMENTUM HARD STOP (-6% target)" };
    }

    const buys = Number(freshData?.buys5m) || 0;
    const sells = Number(freshData?.sells5m) || 0;
    const total = buys + sells;
    const buyRatio = total ? buys / total : 0;
    if (profitPercent <= FLOW_FADE_LOSS_PERCENT &&
        Number(freshData?.priceChange5m) <= FLOW_FADE_5M_PERCENT &&
        total >= FLOW_FADE_MIN_TRANSACTIONS &&
        buyRatio <= FLOW_FADE_MAX_BUY_RATIO) {
      return { percent: 100, reason: "FAST MOMENTUM FLOW FADE" };
    }

    const heldMs = Math.max(0, now - (Date.parse(position?.entryTime) || now));
    if (heldMs >= MAX_HOLD_MS) {
      return { percent: 100, reason: "FAST MOMENTUM MAX HOLD (15 MINUTES)" };
    }

    if (position?.firstTakeProfitDone && highestProfitPercent >= TAKE_PROFIT_PERCENT &&
        (dropFromHigh >= RUNNER_TRAIL_PERCENT || profitPercent <= RUNNER_PROTECTED_GAIN_PERCENT)) {
      return { percent: 100, reason: "FAST MOMENTUM RUNNER TRAIL" };
    }

    if (!position?.firstTakeProfitDone && profitPercent >= TAKE_PROFIT_PERCENT) {
      return { percent: TAKE_PROFIT_SELL_PERCENT, reason: "FAST MOMENTUM TAKE PROFIT 1",
        takeProfit: "firstTakeProfitDone" };
    }

    if (heldMs >= MAX_STALE_HOLD_MS && profitPercent < STALE_EXIT_MAX_GAIN_PERCENT &&
        highestProfitPercent < STALE_EXIT_MAX_PEAK_GAIN_PERCENT) {
      return { percent: 100, reason: "FAST MOMENTUM STALE EXIT (8 MINUTES)" };
    }

    return null;
  };
}

module.exports = {
  HARD_STOP_PERCENT,
  FLOW_FADE_LOSS_PERCENT,
  TAKE_PROFIT_PERCENT,
  TAKE_PROFIT_SELL_PERCENT,
  RUNNER_TRAIL_PERCENT,
  RUNNER_PROTECTED_GAIN_PERCENT,
  MAX_STALE_HOLD_MS,
  MAX_HOLD_MS,
  createFastMomentumExitPolicy
};
