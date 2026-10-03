const HARD_STOP_PERCENT = -8;
const FLOW_FADE_LOSS_PERCENT = -2.5;
const FLOW_FADE_5M_PERCENT = -2;
const FLOW_FADE_MIN_TRANSACTIONS = 12;
const FLOW_FADE_MAX_BUY_RATIO = 0.48;
const TAKE_PROFIT_PERCENT = 10;
const TAKE_PROFIT_SELL_PERCENT = 50;
const RUNNER_TRAIL_PERCENT = 5;
const RUNNER_PROTECTED_GAIN_PERCENT = 3;
const MAX_STALE_HOLD_MS = 8 * 60 * 1000;
const MIN_STALE_HOLD_MS = 2 * 60 * 1000;
const STALE_EXIT_MAX_GAIN_PERCENT = 2;
const STALE_EXIT_MAX_PEAK_GAIN_PERCENT = 5;

function createPubxExitPolicy() {
  return ({ position, currentPrice, profitPercent, dropFromHigh, highestProfitPercent, freshData, now = Date.now() }) => {
    if (profitPercent <= HARD_STOP_PERCENT) return { percent: 100, reason: "PUBX HARD STOP" };

    const buys = Number(freshData?.buys5m) || 0;
    const sells = Number(freshData?.sells5m) || 0;
    const total = buys + sells;
    const buyRatio = total ? buys / total : 0;
    const change5m = Number(freshData?.priceChange5m) || 0;
    if (profitPercent <= FLOW_FADE_LOSS_PERCENT && change5m <= FLOW_FADE_5M_PERCENT &&
        total >= FLOW_FADE_MIN_TRANSACTIONS && buyRatio <= FLOW_FADE_MAX_BUY_RATIO) {
      return { percent: 100, reason: "PUBX FLOW FADE EXIT" };
    }

    const entryAt = Date.parse(position?.entryTime);
    const heldMs = Number.isFinite(entryAt) ? now - entryAt : 0;
    if (position?.firstTakeProfitDone && highestProfitPercent >= TAKE_PROFIT_PERCENT &&
        (dropFromHigh >= RUNNER_TRAIL_PERCENT || profitPercent <= RUNNER_PROTECTED_GAIN_PERCENT)) {
      return { percent: 100, reason: "PUBX RUNNER TRAIL EXIT" };
    }

    if (!position?.firstTakeProfitDone && profitPercent >= TAKE_PROFIT_PERCENT) {
      return { percent: TAKE_PROFIT_SELL_PERCENT, reason: "PUBX TAKE PROFIT 1",
        takeProfit: "firstTakeProfitDone" };
    }

    if (heldMs >= MAX_STALE_HOLD_MS && profitPercent < STALE_EXIT_MAX_GAIN_PERCENT &&
        highestProfitPercent < STALE_EXIT_MAX_PEAK_GAIN_PERCENT) {
      return { percent: 100, reason: "PUBX TIME EXIT" };
    }

    const entryVolume = Number(position?.experimentEntry?.volume5mUsd) || 0;
    const currentVolume = Number(freshData?.volume5m) || 0;
    if (heldMs >= MIN_STALE_HOLD_MS && profitPercent <= 0 && change5m < 0 &&
        entryVolume > 0 && currentVolume < entryVolume * 0.5 && total >= FLOW_FADE_MIN_TRANSACTIONS) {
      return { percent: 100, reason: "PUBX VOLUME FADE EXIT" };
    }
    return null;
  };
}

module.exports = {
  HARD_STOP_PERCENT, FLOW_FADE_LOSS_PERCENT, FLOW_FADE_5M_PERCENT,
  FLOW_FADE_MIN_TRANSACTIONS, FLOW_FADE_MAX_BUY_RATIO, TAKE_PROFIT_PERCENT,
  TAKE_PROFIT_SELL_PERCENT, RUNNER_TRAIL_PERCENT, RUNNER_PROTECTED_GAIN_PERCENT,
  MAX_STALE_HOLD_MS, MIN_STALE_HOLD_MS, createPubxExitPolicy
};
