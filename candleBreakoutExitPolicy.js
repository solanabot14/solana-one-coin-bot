const HARD_STOP_PERCENT = -9;
const FLOW_FADE_LOSS_PERCENT = -3;
const FLOW_FADE_5M_PERCENT = -3;
const FLOW_FADE_MIN_TRANSACTIONS = 8;
const FLOW_FADE_MAX_BUY_RATIO = 0.45;
const TAKE_PROFIT_PERCENT = 12;
const TAKE_PROFIT_SELL_PERCENT = 50;
const RUNNER_TRAIL_PERCENT = 7;
const RUNNER_PROTECTED_GAIN_PERCENT = 3;
const MAX_STALE_HOLD_MS = 12 * 60 * 1000;
const STALE_EXIT_MAX_GAIN_PERCENT = 3;
const STALE_EXIT_MAX_PEAK_GAIN_PERCENT = 8;

function createCandleBreakoutExitPolicy() {
	return ({ position, profitPercent, dropFromHigh, highestProfitPercent, freshData, now = Date.now() }) => {
		if (profitPercent <= HARD_STOP_PERCENT) return { percent: 100, reason: "CANDLE BREAKOUT HARD STOP" };
		const buys = Number(freshData?.buys5m) || 0;
		const sells = Number(freshData?.sells5m) || 0;
		const total = buys + sells;
		const buyRatio = total ? buys / total : 0;
		if (profitPercent <= FLOW_FADE_LOSS_PERCENT && Number(freshData?.priceChange5m) <= FLOW_FADE_5M_PERCENT &&
			total >= FLOW_FADE_MIN_TRANSACTIONS && buyRatio <= FLOW_FADE_MAX_BUY_RATIO) {
			return { percent: 100, reason: "CANDLE BREAKOUT FLOW FADE" };
		}
		const heldMs = Math.max(0, now - (Date.parse(position?.entryTime) || now));
		if (position?.firstTakeProfitDone && highestProfitPercent >= TAKE_PROFIT_PERCENT &&
			(dropFromHigh >= RUNNER_TRAIL_PERCENT || profitPercent <= RUNNER_PROTECTED_GAIN_PERCENT)) {
			return { percent: 100, reason: "CANDLE BREAKOUT RUNNER TRAIL" };
		}
		if (!position?.firstTakeProfitDone && profitPercent >= TAKE_PROFIT_PERCENT) {
			return { percent: TAKE_PROFIT_SELL_PERCENT, reason: "CANDLE BREAKOUT TAKE PROFIT 1", takeProfit: "firstTakeProfitDone" };
		}
		if (heldMs >= MAX_STALE_HOLD_MS && profitPercent < STALE_EXIT_MAX_GAIN_PERCENT && highestProfitPercent < STALE_EXIT_MAX_PEAK_GAIN_PERCENT) {
			return { percent: 100, reason: "CANDLE BREAKOUT TIME EXIT" };
		}
		return null;
	};
}

module.exports = { HARD_STOP_PERCENT, TAKE_PROFIT_PERCENT, TAKE_PROFIT_SELL_PERCENT, RUNNER_TRAIL_PERCENT,
	RUNNER_PROTECTED_GAIN_PERCENT, MAX_STALE_HOLD_MS, createCandleBreakoutExitPolicy };
