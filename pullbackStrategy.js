const MIN_FIRST_PUMP_5M_PERCENT = 1.5;
const MAX_FIRST_PUMP_5M_PERCENT = 8;
const MIN_PULLBACK_PERCENT = 2;
const MAX_PULLBACK_PERCENT = 12;
const RECLAIM_BUFFER_PERCENT = 0.2;
const MIN_VOLUME_5M_USD = 5000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.10;
const MIN_BUY_RATIO = 0.60;
const MIN_TRANSACTIONS_5M = 30;
const MAX_WATCH_AGE_MS = 30 * 60 * 1000;

function buyRatio(coin) {
	const buys = Number(coin.buys5m) || 0;
	const sells = Number(coin.sells5m) || 0;
	const total = buys + sells;
	return { buys, sells, total, ratio: total ? buys / total : 0 };
}

function createPullbackStrategy() {
	const states = new Map();

	function observe(candidates = [], now = Date.now()) {
		const ready = [];

		for (const coin of candidates) {
			const address = coin?.tokenAddress;
			const price = Number(coin?.priceUsd);
			if (!address || !(price > 0)) continue;

			const momentum5m = Number(coin.priceChange5m) || 0;
			const momentum1h = Number(coin.priceChange1h) || 0;
			const activity = buyRatio(coin);
			let state = states.get(address);

			if (!state) {
				const firstPump = coin.signal === "STRONG BUY" &&
					momentum5m >= MIN_FIRST_PUMP_5M_PERCENT &&
					momentum5m <= MAX_FIRST_PUMP_5M_PERCENT &&
					momentum1h > 0 && activity.total >= 20 && activity.ratio >= 0.55;
				if (!firstPump) continue;
				state = { phase: "FIRST_PUMP", high: price, low: price, firstSeenAt: now, lastSeenAt: now };
				states.set(address, state);
				continue;
			}

			state.lastSeenAt = now;
			if (state.phase === "FIRST_PUMP") {
				if (price > state.high) state.high = price;
				const pullbackPercent = (state.high - price) / state.high * 100;
				if (pullbackPercent >= MIN_PULLBACK_PERCENT && pullbackPercent <= MAX_PULLBACK_PERCENT) {
					state.phase = "PULLBACK";
					state.low = price;
				} else if (pullbackPercent > MAX_PULLBACK_PERCENT) {
					states.delete(address);
				}
				continue;
			}

			if (price < state.low) state.low = price;
			const totalPullback = (state.high - state.low) / state.high * 100;
			if (totalPullback > MAX_PULLBACK_PERCENT) {
				states.delete(address);
				continue;
			}

			const volume5m = Number(coin.volume5m) || 0;
			const liquidity = Number(coin.liquidityUsd) || 0;
			const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
			const confirmsSecondPump = coin.signal === "STRONG BUY" &&
				price >= state.high * (1 + RECLAIM_BUFFER_PERCENT / 100) &&
				momentum5m >= 0.25 && momentum5m <= 6 &&
				momentum1h > 0 && momentum1h <= 30 &&
				activity.ratio >= MIN_BUY_RATIO && activity.total >= MIN_TRANSACTIONS_5M &&
				volume5m >= requiredVolume;

			if (confirmsSecondPump) {
				ready.push({
					...coin,
					signal: "STRONG BUY",
					reasons: [
						...(Array.isArray(coin.reasons) ? coin.reasons : []),
						"PULLBACK EXPERIMENT: first pump observed",
						`PULLBACK EXPERIMENT: ${totalPullback.toFixed(2)}% retracement, then reclaimed the prior high`,
						`PULLBACK EXPERIMENT: 5m USD volume $${volume5m.toFixed(0)}, buy ratio ${(activity.ratio * 100).toFixed(1)}%`
					],
					experimentEntry: {
						model: "PULLBACK_RECLAIM_SNAPSHOT_V1",
						firstPumpHigh: state.high,
						pullbackLow: state.low,
						pullbackPercent: totalPullback,
						volume5mUsd: volume5m,
						buyRatio: activity.ratio,
						observedAt: new Date(now).toISOString()
					}
				});
				states.delete(address);
			}
		}

		for (const [address, state] of states) {
			if (now - state.firstSeenAt > MAX_WATCH_AGE_MS) states.delete(address);
		}
		return ready;
	}

	function getStatus() {
		const counts = { firstPump: 0, pullback: 0 };
		for (const state of states.values()) {
			if (state.phase === "FIRST_PUMP") counts.firstPump++;
			if (state.phase === "PULLBACK") counts.pullback++;
		}
		return { ...counts, watching: states.size };
	}

	return { observe, getStatus };
}

module.exports = {
	createPullbackStrategy,
	constants: {
		MIN_FIRST_PUMP_5M_PERCENT,
		MIN_PULLBACK_PERCENT,
		MAX_PULLBACK_PERCENT,
		RECLAIM_BUFFER_PERCENT,
		MIN_VOLUME_5M_USD,
		MIN_VOLUME_LIQUIDITY_RATIO,
		MIN_BUY_RATIO,
		MIN_TRANSACTIONS_5M
	}
};
