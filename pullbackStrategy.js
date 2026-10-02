const MIN_FIRST_PUMP_PERCENT = 1.5;
const MAX_FIRST_PUMP_PERCENT = 8;
const MIN_PULLBACK_PERCENT = 2;
const MAX_PULLBACK_PERCENT = 12;
const RECLAIM_BUFFER_PERCENT = 0.2;
const MIN_VOLUME_5M_USD = 5000;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.10;
const MIN_BUY_RATIO = 0.60;
const MIN_TRANSACTIONS_5M = 30;
const MIN_BREAKOUT_VOLUME_MULTIPLE = 1.5;
const MAX_ENTRY_EXTENSION_PERCENT = 2;
const MAX_WATCH_AGE_MS = 30 * 60 * 1000;
const MAX_CANDLE_AGE_MS = 3 * 60 * 1000;
const CANDLE_SECONDS = 60;
const CANDLE_LOOKBACK = 30;

function buyRatio(coin) {
	const buys = Number(coin.buys5m) || 0;
	const sells = Number(coin.sells5m) || 0;
	const total = buys + sells;
	return { buys, sells, total, ratio: total ? buys / total : 0 };
}

function areContinuous(candles, start, end) {
	for (let index = start + 1; index <= end; index += 1) {
		if (candles[index].timestamp - candles[index - 1].timestamp !== CANDLE_SECONDS) return false;
	}
	return true;
}

function detectPattern(inputCandles, now = Date.now()) {
	const candles = (Array.isArray(inputCandles) ? inputCandles : [])
		.filter(candle => candle && Number.isFinite(Number(candle.timestamp)) &&
			[candle.open, candle.high, candle.low, candle.close, candle.volume].every(value => Number.isFinite(Number(value))) &&
			Number(candle.close) > 0 && Number(candle.high) > 0 && Number(candle.low) > 0 && Number(candle.volume) >= 0)
		.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
		.slice(-CANDLE_LOOKBACK);
	if (candles.length < 10) return { phase: null, reason: "NOT_ENOUGH_CLOSED_CANDLES" };

	const last = candles.length - 1;
	const lastCandle = candles[last];
	if (now - Number(lastCandle.timestamp) * 1000 > MAX_CANDLE_AGE_MS) {
		return { phase: null, reason: "STALE_CANDLES" };
	}

	let bestWatch = null;
	const oldestPeak = Math.max(5, last - CANDLE_LOOKBACK + 1);
	for (let peakIndex = last - 4; peakIndex >= oldestPeak; peakIndex -= 1) {
		const baselineIndex = peakIndex - 5;
		if (!areContinuous(candles, baselineIndex, last)) continue;

		const baseline = Number(candles[baselineIndex].close);
		const peakHigh = Number(candles[peakIndex].high);
		if (!(baseline > 0) || !(peakHigh > 0)) continue;
		const firstPumpPercent = (peakHigh - baseline) / baseline * 100;
		if (firstPumpPercent < MIN_FIRST_PUMP_PERCENT || firstPumpPercent > MAX_FIRST_PUMP_PERCENT) continue;

		let troughIndex = peakIndex + 1;
		for (let index = peakIndex + 2; index <= last; index += 1) {
			if (Number(candles[index].low) < Number(candles[troughIndex].low)) troughIndex = index;
		}
		const pullbackLow = Number(candles[troughIndex].low);
		const pullbackPercent = (peakHigh - pullbackLow) / peakHigh * 100;
		if (pullbackPercent > MAX_PULLBACK_PERCENT) continue;

		const evidence = {
			phase: pullbackPercent >= MIN_PULLBACK_PERCENT ? "PULLBACK" : "FIRST_PUMP",
			firstPumpHigh: peakHigh,
			firstPumpPercent,
			pullbackLow,
			pullbackPercent,
			firstPumpTimestamp: Number(candles[peakIndex].timestamp),
			lastCandleTimestamp: Number(lastCandle.timestamp)
		};
		if (!bestWatch || evidence.phase === "PULLBACK") bestWatch = evidence;
		if (pullbackPercent < MIN_PULLBACK_PERCENT || last - troughIndex < 4) continue;

		const recoveryStart = last - 3;
		if (recoveryStart <= troughIndex) continue;
		const recentRecoveryHigh = Math.max(...candles.slice(recoveryStart, last).map(candle => Number(candle.high)));
		const priorVolumes = candles.slice(Math.max(0, last - 5), last).map(candle => Number(candle.volume));
		if (priorVolumes.length < 5 || priorVolumes.every(volume => volume === 0)) continue;
		const averagePriorVolume = priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length;
		const breakoutVolumeMultiple = averagePriorVolume > 0 ? Number(lastCandle.volume) / averagePriorVolume : 0;
		const breakout = Number(lastCandle.close) >= recentRecoveryHigh * (1 + RECLAIM_BUFFER_PERCENT / 100) &&
			breakoutVolumeMultiple >= MIN_BREAKOUT_VOLUME_MULTIPLE;
		if (breakout) {
			return {
				...evidence,
				phase: "RECLAIMED",
				breakoutClose: Number(lastCandle.close),
				breakoutVolume: Number(lastCandle.volume),
				averagePriorVolume,
				breakoutVolumeMultiple,
				breakoutTimestamp: Number(lastCandle.timestamp)
			};
		}
	}

	return bestWatch || { phase: null, reason: "NO_VALID_PUMP_PATTERN" };
}

function createPullbackStrategy() {
	const states = new Map();
	const emittedBreakouts = new Map();

	function observe(candidates = [], now = Date.now()) {
		const ready = [];
		const seen = new Set();

		for (const coin of candidates) {
			const address = coin?.tokenAddress;
			const price = Number(coin?.priceUsd);
			const candles = coin?.ohlcv1m;
			if (!address || !(price > 0) || !Array.isArray(candles)) continue;
			seen.add(address);

			const pattern = detectPattern(candles, now);
			if (!pattern.phase) {
				states.delete(address);
				continue;
			}

			states.set(address, {
				phase: pattern.phase === "RECLAIMED" ? "PULLBACK" : pattern.phase,
				firstSeenAt: Number(pattern.firstPumpTimestamp) * 1000,
				lastSeenAt: now,
				poolAddress: coin.pairAddress || null,
				firstPumpHigh: pattern.firstPumpHigh,
				pullbackLow: pattern.pullbackLow
			});

			if (pattern.phase !== "RECLAIMED" || coin.signal !== "STRONG BUY") continue;
			const breakoutKey = `${address}:${pattern.breakoutTimestamp}`;
			if (emittedBreakouts.has(breakoutKey)) continue;

			const momentum5m = Number(coin.priceChange5m) || 0;
			const momentum1h = Number(coin.priceChange1h) || 0;
			const activity = buyRatio(coin);
			const volume5m = Number(coin.volume5m) || 0;
			const liquidity = Number(coin.liquidityUsd) || 0;
			const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
			const quoteExtensionPercent = (price - pattern.breakoutClose) / pattern.breakoutClose * 100;
			const confirmsMarketActivity = momentum5m >= 0.25 && momentum5m <= 6 &&
				momentum1h > 0 && momentum1h <= 30 &&
				activity.ratio >= MIN_BUY_RATIO && activity.total >= MIN_TRANSACTIONS_5M &&
				volume5m >= requiredVolume;
		const quoteStillNearBreakout = quoteExtensionPercent >= -0.2 && quoteExtensionPercent <= MAX_ENTRY_EXTENSION_PERCENT;
		if (!confirmsMarketActivity || !quoteStillNearBreakout) continue;

		const pullbackPercent = pattern.pullbackPercent;
		const firstPumpTime = new Date(pattern.firstPumpTimestamp * 1000).toISOString();
		const breakoutTime = new Date(pattern.breakoutTimestamp * 1000).toISOString();
		ready.push({
			...coin,
			signal: "STRONG BUY",
			reasons: [
				...(Array.isArray(coin.reasons) ? coin.reasons : []),
				"PULLBACK EXPERIMENT: confirmed with closed GeckoTerminal 1m candles",
				`PULLBACK EXPERIMENT: first pump ${pattern.firstPumpPercent.toFixed(2)}%, pullback ${pullbackPercent.toFixed(2)}%`,
				`PULLBACK EXPERIMENT: reclaim candle volume ${pattern.breakoutVolumeMultiple.toFixed(2)}x the previous 5-candle average`,
				`PULLBACK EXPERIMENT: quote is ${quoteExtensionPercent.toFixed(2)}% from breakout close; 5m volume $${volume5m.toFixed(0)}, buy ratio ${(activity.ratio * 100).toFixed(1)}%`
			],
			experimentEntry: {
				model: "PULLBACK_RECLAIM_OHLCV_V2",
				candleSource: "GeckoTerminal public OHLCV",
				candleInterval: "1m",
				poolAddress: coin.pairAddress || null,
				firstPumpAt: firstPumpTime,
				firstPumpHigh: pattern.firstPumpHigh,
				firstPumpPercent: pattern.firstPumpPercent,
				pullbackLow: pattern.pullbackLow,
				pullbackPercent,
				breakoutAt: breakoutTime,
				breakoutClose: pattern.breakoutClose,
				breakoutVolume: pattern.breakoutVolume,
				breakoutVolumeMultiple: pattern.breakoutVolumeMultiple,
				quotePriceAtEntryCheck: price,
				quoteExtensionPercent,
				volume5mUsd: volume5m,
				buyRatio: activity.ratio,
				observedAt: new Date(now).toISOString()
			}
		});
		emittedBreakouts.set(breakoutKey, now);
		states.delete(address);
		}

		for (const [address, state] of states) {
			if (now - state.firstSeenAt > MAX_WATCH_AGE_MS || (!seen.has(address) && now - state.lastSeenAt > MAX_WATCH_AGE_MS)) {
				states.delete(address);
			}
		}
		for (const [key, at] of emittedBreakouts) {
			if (now - at > MAX_WATCH_AGE_MS) emittedBreakouts.delete(key);
		}
		return ready;
	}

	function getStatus() {
		const counts = { firstPump: 0, pullback: 0, watching: states.size, candleInterval: "1m", candleSource: "GeckoTerminal public OHLCV" };
		for (const state of states.values()) {
			if (state.phase === "FIRST_PUMP") counts.firstPump++;
			if (state.phase === "PULLBACK") counts.pullback++;
		}
		return counts;
	}

	function getTrackedTokens() {
		return [...states.keys()];
	}

	return { observe, getStatus, getTrackedTokens };
}

module.exports = {
	createPullbackStrategy,
	detectPattern,
	constants: {
		MIN_FIRST_PUMP_PERCENT,
		MAX_FIRST_PUMP_PERCENT,
		MIN_PULLBACK_PERCENT,
		MAX_PULLBACK_PERCENT,
		RECLAIM_BUFFER_PERCENT,
		MIN_VOLUME_5M_USD,
		MIN_VOLUME_LIQUIDITY_RATIO,
		MIN_BUY_RATIO,
		MIN_TRANSACTIONS_5M,
		MIN_BREAKOUT_VOLUME_MULTIPLE,
		MAX_ENTRY_EXTENSION_PERCENT,
		MAX_WATCH_AGE_MS,
		MAX_CANDLE_AGE_MS
	}
};
