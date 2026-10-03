const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_5M_USD = 1000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.01;
const MIN_TRANSACTIONS_5M = 6;
const MIN_BUY_RATIO = 0.50;
const MIN_CHANGE_5M = -1;
const MAX_CHANGE_5M = 12;
const MIN_CHANGE_1H = -15;
const MAX_CHANGE_1H = 75;

function createPullbackStrategy() {
	let rejectedByFilter = {};
	function observe(candidates = [], now = Date.now()) {
		const ready = [];
		const rejected = {};
		const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
		for (const coin of candidates) {
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
			if (!coin?.tokenAddress || !coin?.pairAddress || !(price > 0)) reason = "MISSING_MARKET_DATA";
			else if (liquidity < MIN_LIQUIDITY_USD) reason = "LIQUIDITY_BELOW_20000";
			else if (totalTransactions < MIN_TRANSACTIONS_5M) reason = "FEWER_THAN_6_TRANSACTIONS";
			else if (buyRatio < MIN_BUY_RATIO) reason = "BUY_RATIO_BELOW_50_PERCENT";
			else if (volume5m < requiredVolume) reason = "FIVE_MINUTE_VOLUME_TOO_LOW";
			else if (change5m < MIN_CHANGE_5M || change5m > MAX_CHANGE_5M) reason = "FIVE_MINUTE_MOMENTUM_OUT_OF_RANGE";
			else if (change1h < MIN_CHANGE_1H || change1h > MAX_CHANGE_1H) reason = "ONE_HOUR_MOMENTUM_OUT_OF_RANGE";
			if (reason) { reject(reason); continue; }
			ready.push({ ...coin, signal: "STRONG BUY", reasons: [
				"FAST MOMENTUM V1: DexScreener profile/boost discovery; no candle wait",
				`FAST MOMENTUM V1: liquidity $${Math.round(liquidity).toLocaleString()}, ${totalTransactions} five-minute transactions, ${(buyRatio * 100).toFixed(0)}% buys`,
				`FAST MOMENTUM V1: five-minute volume ${Math.round(volume5m).toLocaleString()}, price change ${change5m.toFixed(2)}% / 5m and ${change1h.toFixed(2)}% / 1h`,
				"FAST MOMENTUM V1: anti-chase limits ≤12% / 5m and ≤75% / 1h"
			], experimentEntry: {
				model: "FAST_MOMENTUM_V1_3_AGGRESSIVE",
				discoverySource: "DexScreener latest profiles, community takeovers, latest/top boosts",
				liquidityUsd: liquidity, volume5mUsd: volume5m, transactions5m: totalTransactions,
				buyRatio, priceChange5m: change5m, priceChange1h: change1h,
				maxEntryChange5m: MAX_CHANGE_5M, maxEntryChange1h: MAX_CHANGE_1H,
				observedAt: new Date(now).toISOString()
			} });
		}
		rejectedByFilter = rejected;
		return ready;
	}
	return { observe, release: () => {}, getStatus: () => ({ rejectedByFilter: { ...rejectedByFilter } }) };
}

module.exports = { createPullbackStrategy, constants: {
	MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD, MIN_VOLUME_LIQUIDITY_RATIO,
	MIN_TRANSACTIONS_5M, MIN_BUY_RATIO, MIN_CHANGE_5M, MAX_CHANGE_5M,
	MIN_CHANGE_1H, MAX_CHANGE_1H
} };
