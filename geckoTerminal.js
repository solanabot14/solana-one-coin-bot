const axios = require("axios");

const API_BASE = "https://api.geckoterminal.com/api/v2";
const CANDLE_INTERVAL_SECONDS = 60;
const CANDLE_CACHE_MS = 60 * 1000;
const NEW_POOLS_CACHE_MS = 60 * 1000;
// Keep a margin under the public API's approximate 10 requests/minute limit.
const REQUEST_SPACING_MS = 7500;
const FAILURE_CACHE_MS = 30 * 1000;

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCandles(payload, nowMs = Date.now()) {
	const rows = payload?.data?.attributes?.ohlcv_list;
	if (!Array.isArray(rows)) return [];
	const nowSeconds = Math.floor(nowMs / 1000);
	const candles = rows.map(row => ({
		timestamp: Number(row?.[0]),
		open: Number(row?.[1]),
		high: Number(row?.[2]),
		low: Number(row?.[3]),
		close: Number(row?.[4]),
		volume: Number(row?.[5])
	})).filter(candle =>
		Number.isFinite(candle.timestamp) &&
		candle.timestamp + CANDLE_INTERVAL_SECONDS <= nowSeconds &&
		[candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) &&
		candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 && candle.volume >= 0
	).sort((a, b) => a.timestamp - b.timestamp);
	return candles;
}

function createGeckoTerminalClient({
	httpGet = axios.get,
	clock = Date.now,
	sleep = wait,
	cacheMs = CANDLE_CACHE_MS,
	requestSpacingMs = REQUEST_SPACING_MS
} = {}) {
	const cache = new Map();
	let requestQueue = Promise.resolve();
	let lastRequestAt = 0;
	const feedCache = new Map();
	const feedRequests = new Map();

	function queueRequest(run) {
		const request = requestQueue.then(async () => {
			const delayMs = Math.max(0, requestSpacingMs - (clock() - lastRequestAt));
			if (delayMs > 0) await sleep(delayMs);
			if (run.signal?.aborted) throw new Error("GeckoTerminal request aborted.");
			lastRequestAt = clock();
			return run.execute();
		});
		requestQueue = request.catch(() => {});
		return request;
	}

	async function getPoolFeed(feed, { signal, duration = "24h", page = 1 } = {}) {
		const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
		const key = `${feed}:${duration}:${normalizedPage}`;
		const cached = feedCache.get(key);
		if (cached && clock() - cached.at < NEW_POOLS_CACHE_MS) return structuredClone(cached.pools);
		if (feedRequests.has(key)) return structuredClone(await feedRequests.get(key));
		const endpoint = feed === "new" ? "new_pools"
			: feed === "trending" ? "trending_pools" : "pools";
		const params = { include: "base_token,quote_token", page: normalizedPage };
		if (feed === "trending") params.duration = duration;
		const request = queueRequest({
			signal,
			execute: async () => {
				const url = `${API_BASE}/networks/solana/${endpoint}`;
				const response = await httpGet(url, {
					params,
					headers: { Accept: "application/json;version=20230203" },
					timeout: 10000,
					signal
				});
				return Array.isArray(response?.data?.data) ? response.data.data : [];
			}
		}).then(pools => {
			feedCache.set(key, { at: clock(), pools });
			return pools;
		}).finally(() => { feedRequests.delete(key); });
		feedRequests.set(key, request);
		return structuredClone(await request);
	}

	async function getNewSolanaPools(options = {}) {
		return getPoolFeed("new", options);
	}

	async function getTrendingSolanaPools(options = {}) {
		return getPoolFeed("trending", options);
	}

	async function getTopSolanaPools(options = {}) {
		return getPoolFeed("top", options);
	}

	async function getPoolCandles(poolAddress, tokenAddress, { signal } = {}) {
		if (!poolAddress || !tokenAddress) return [];
		const cacheKey = `${poolAddress}:${tokenAddress}`;
		const cached = cache.get(cacheKey);
		if (cached && clock() - cached.at < cached.ttl) return structuredClone(cached.candles);

		const request = queueRequest({ signal, execute: async () => {
			const url = `${API_BASE}/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute`;
			const response = await httpGet(url, {
				params: { aggregate: 1, limit: 60, currency: "usd", token: "base" },
				headers: { Accept: "application/json;version=20230203" },
				timeout: 10000,
				signal
			});
			const candles = normalizeCandles(response?.data, clock());
			cache.set(cacheKey, { at: clock(), ttl: cacheMs, candles });
			return candles;
		} });

		try {
			return structuredClone(await request);
		} catch (error) {
			// Briefly cache failures too, so a provider/rate-limit error cannot
			// trigger repeated requests or stop the separate paper experiment.
			cache.set(cacheKey, { at: clock(), ttl: FAILURE_CACHE_MS, candles: [] });
			throw error;
		}
	}

	return { getPoolCandles, getNewSolanaPools, getTrendingSolanaPools, getTopSolanaPools };
}

const client = createGeckoTerminalClient();

module.exports = {
	API_BASE,
	CANDLE_INTERVAL_SECONDS,
	createGeckoTerminalClient,
	normalizeCandles,
	getPoolCandles: client.getPoolCandles,
	getNewSolanaPools: client.getNewSolanaPools,
	getTrendingSolanaPools: client.getTrendingSolanaPools,
	getTopSolanaPools: client.getTopSolanaPools
};

