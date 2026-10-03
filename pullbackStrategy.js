const MIN_CANDLES = 6;
const BREAKOUT_LOOKBACK = 3;
const MIN_BREAKOUT_BUFFER_PERCENT = 0;
const MIN_CLOSE_LOCATION = 0.45;
const MIN_BREAKOUT_VOLUME_MULTIPLE = 1.0;
const MAX_CANDLE_AGE_MS = 3 * 60 * 1000;
const MAX_ENTRY_EXTENSION_PERCENT = 2.5;
const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_5M_USD = 1500;
const MIN_VOLUME_LIQUIDITY_RATIO = 0.015;
const MIN_TRANSACTIONS_5M = 8;
const MIN_BUY_RATIO = 0.52;

function detectPattern(inputCandles, now = Date.now()) {
	const candles = (Array.isArray(inputCandles) ? inputCandles : [])
		.filter(c => c && Number.isFinite(Number(c.timestamp)) &&
			[c.open, c.high, c.low, c.close, c.volume].every(v => Number.isFinite(Number(v))) &&
			Number(c.close) > 0 && Number(c.high) > 0 && Number(c.low) > 0 && Number(c.volume) >= 0)
		.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
	if (candles.length < MIN_CANDLES) return { phase: null, reason: "NOT_ENOUGH_CLOSED_CANDLES" };
	const lastIndex = candles.length - 1;
	const last = candles[lastIndex];
	if (now - Number(last.timestamp) * 1000 > MAX_CANDLE_AGE_MS || Number(last.timestamp) * 1000 > now) {
		return { phase: null, reason: "STALE_CANDLES" };
	}
	for (let i = lastIndex - 5; i < lastIndex; i++) {
		if (Number(candles[i + 1].timestamp) - Number(candles[i].timestamp) !== 60) {
			return { phase: null, reason: "CANDLE_GAP" };
		}
	}
	const prior = candles.slice(lastIndex - BREAKOUT_LOOKBACK, lastIndex);
	const priorHigh = Math.max(...prior.map(c => Number(c.high)));
	const close = Number(last.close);
	const breakoutPercent = (close - priorHigh) / priorHigh * 100;
	const range = Number(last.high) - Number(last.low);
	const closeLocation = range > 0 ? (close - Number(last.low)) / range : 0;
	const priorVolumes = candles.slice(lastIndex - 5, lastIndex).map(c => Number(c.volume));
	const averagePriorVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
	const breakoutVolumeMultiple = averagePriorVolume > 0 ? Number(last.volume) / averagePriorVolume : 0;
	if (breakoutPercent < MIN_BREAKOUT_BUFFER_PERCENT || closeLocation < MIN_CLOSE_LOCATION ||
		breakoutVolumeMultiple < MIN_BREAKOUT_VOLUME_MULTIPLE) {
		return { phase: null, reason: "NO_CHANNEL_BREAKOUT" };
	}
	return { phase: "BREAKOUT", breakoutClose: close, priorHigh, breakoutPercent, closeLocation,
		breakoutVolume: Number(last.volume), averagePriorVolume, breakoutVolumeMultiple,
		breakoutTimestamp: Number(last.timestamp) };
}

function createPullbackStrategy() {
	const emitted = new Map();
	function observe(candidates = [], now = Date.now()) {
		const ready = [];
		for (const coin of candidates) {
			const address = coin?.tokenAddress;
			const price = Number(coin?.priceUsd);
			if (!address || !(price > 0) || !Array.isArray(coin?.ohlcv1m)) continue;
			const pattern = detectPattern(coin.ohlcv1m, now);
			if (pattern.phase !== "BREAKOUT") continue;
			const key = `${address}:${pattern.breakoutTimestamp}`;
			if (emitted.has(key)) continue;
			const buys = Number(coin.buys5m) || 0;
			const sells = Number(coin.sells5m) || 0;
			const total = buys + sells;
			const buyRatio = total ? buys / total : 0;
			const liquidity = Number(coin.liquidityUsd) || 0;
			const volume5m = Number(coin.volume5m) || 0;
			const momentum5m = Number(coin.priceChange5m) || 0;
			const momentum1h = Number(coin.priceChange1h) || 0;
			const quoteExtensionPercent = (price - pattern.breakoutClose) / pattern.breakoutClose * 100;
			const requiredVolume = Math.max(MIN_VOLUME_5M_USD, liquidity * MIN_VOLUME_LIQUIDITY_RATIO);
			if (liquidity < MIN_LIQUIDITY_USD || total < MIN_TRANSACTIONS_5M || buyRatio < MIN_BUY_RATIO ||
				volume5m < requiredVolume || momentum5m < -3 || momentum5m > 12 || momentum1h < -15 || momentum1h > 80 ||
				quoteExtensionPercent < -0.5 || quoteExtensionPercent > MAX_ENTRY_EXTENSION_PERCENT) continue;
			const candleTime = new Date(pattern.breakoutTimestamp * 1000).toISOString();
			ready.push({ ...coin, signal: "STRONG BUY", reasons: [
				"CANDLE BREAKOUT V1: closed 1m candle cleared the prior 3-candle high",
				`CANDLE BREAKOUT V1: ${pattern.breakoutPercent.toFixed(2)}% breakout, ${pattern.breakoutVolumeMultiple.toFixed(2)}x candle volume, close in top ${(pattern.closeLocation * 100).toFixed(0)}% of range`,
				`CANDLE BREAKOUT V1: quote ${quoteExtensionPercent.toFixed(2)}% from breakout close; 5m activity ${total} tx, ${(buyRatio * 100).toFixed(0)}% buys`
			], experimentEntry: {
				model: "CANDLE_BREAKOUT_1M_V1_1_EXPANDED", candleSource: "GeckoTerminal public OHLCV", candleInterval: "1m",
				poolAddress: coin.pairAddress || null, breakoutAt: candleTime, breakoutClose: pattern.breakoutClose,
				priorHigh: pattern.priorHigh, breakoutPercent: pattern.breakoutPercent, closeLocation: pattern.closeLocation,
				breakoutVolumeMultiple: pattern.breakoutVolumeMultiple, quotePriceAtEntryCheck: price,
				quoteExtensionPercent, volume5mUsd: volume5m, buyRatio, observedAt: new Date(now).toISOString()
			} });
			emitted.set(key, now);
		}
		for (const [key, at] of emitted) if (now - at > 30 * 60 * 1000) emitted.delete(key);
		return ready;
	}
	function release(tokenAddress, breakoutAt) {
		const timestamp = Math.floor(Date.parse(breakoutAt) / 1000);
		if (tokenAddress && Number.isFinite(timestamp)) emitted.delete(`${tokenAddress}:${timestamp}`);
	}
	return { observe, release, getStatus: () => ({ qualified: 0, scanning: 0, candleInterval: "1m", candleSource: "GeckoTerminal public OHLCV" }) };
}

module.exports = { createPullbackStrategy, detectPattern, constants: {
	MIN_CANDLES, BREAKOUT_LOOKBACK, MIN_BREAKOUT_BUFFER_PERCENT, MIN_CLOSE_LOCATION,
	MIN_BREAKOUT_VOLUME_MULTIPLE, MAX_CANDLE_AGE_MS, MAX_ENTRY_EXTENSION_PERCENT,
	MIN_LIQUIDITY_USD, MIN_VOLUME_5M_USD, MIN_VOLUME_LIQUIDITY_RATIO, MIN_TRANSACTIONS_5M, MIN_BUY_RATIO
} };
