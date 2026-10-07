const axios = require("axios");

const MAX_TOKEN_ADDRESSES_PER_REQUEST = 30;
const MIN_TOKEN_REQUEST_INTERVAL_MS = 300;
const TOKEN_DATA_CACHE_MS = 1500;
let tokenRequestQueue = Promise.resolve();
let nextTokenRequestAt = 0;
const tokenDataCache = new Map();

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function requestTokenPairs(addresses, signal) {
	const run = tokenRequestQueue.then(async () => {
		const delay = Math.max(0, nextTokenRequestAt - Date.now());
		if (delay > 0) await wait(delay);
		if (signal?.aborted) throw new Error("DexScreener request aborted.");
		nextTokenRequestAt = Date.now() + MIN_TOKEN_REQUEST_INTERVAL_MS;

		const url = "https://api.dexscreener.com/tokens/v1/solana/" + addresses.join(",");
		return axios.get(url, { timeout: 10000, signal });
	});
	tokenRequestQueue = run.catch(() => {});
	return run;
}

async function requestTokenPairsWithRetry(addresses, signal) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await requestTokenPairs(addresses, signal);
		} catch (error) {
			if (error.response?.status !== 429 || attempt === 2 || signal?.aborted) throw error;
			const retryAfterSeconds = Number(error.response.headers?.["retry-after"]);
			const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
				? retryAfterSeconds * 1000
				: 1000 * (attempt + 1);
			console.warn("DexScreener rate limited; retrying after " + backoffMs + "ms.");
			await wait(backoffMs);
		}
	}
}

function dataFromPair(pair) {
	return {
		name: pair.baseToken?.name,
		symbol: pair.baseToken?.symbol,
		priceUsd: pair.priceUsd,
		liquidityUsd: pair.liquidity?.usd,
		volume5m: pair.volume?.m5,
		volume1h: pair.volume?.h1,
		volume24h: pair.volume?.h24,
		priceChange5m: pair.priceChange?.m5,
		priceChange1h: pair.priceChange?.h1,
		priceChange24h: pair.priceChange?.h24,
		pairCreatedAt: pair.pairCreatedAt,
		buys1h: pair.txns?.h1?.buys,
		sells1h: pair.txns?.h1?.sells,
		buys5m: pair.txns?.m5?.buys,
		sells5m: pair.txns?.m5?.sells,
		pairAddress: pair.pairAddress
	};
}

function readCachedTokenData(address) {
	const cached = tokenDataCache.get(address);
	if (!cached) return undefined;
	if (Date.now() - cached.at > TOKEN_DATA_CACHE_MS) {
		tokenDataCache.delete(address);
		return undefined;
	}
	return cached.data;
}

async function getTokensData(tokenAddresses, { signal } = {}) {
	const addresses = [...new Set((tokenAddresses || []).filter(Boolean))];
	const results = new Map();
	const missing = [];

	for (const address of addresses) {
		const cached = readCachedTokenData(address);
		if (cached !== undefined) results.set(address, cached);
		else missing.push(address);
	}

	for (let start = 0; start < missing.length; start += MAX_TOKEN_ADDRESSES_PER_REQUEST) {
		if (signal?.aborted) break;
		const batch = missing.slice(start, start + MAX_TOKEN_ADDRESSES_PER_REQUEST);
		try {
			const response = await requestTokenPairsWithRetry(batch, signal);
			const bestPairs = new Map();

			for (const pair of Array.isArray(response.data) ? response.data : []) {
				const address = pair.chainId === "solana" ? pair.baseToken?.address : null;
				if (!address || !batch.includes(address)) continue;
				const current = bestPairs.get(address);
				if (!current || (Number(pair.liquidity?.usd) || 0) > (Number(current.liquidity?.usd) || 0)) {
					bestPairs.set(address, pair);
				}
			}

			for (const address of batch) {
				const pair = bestPairs.get(address);
				if (!pair) continue;
				const data = dataFromPair(pair);
				results.set(address, data);
				tokenDataCache.set(address, { at: Date.now(), data });
			}
		} catch (error) {
			if (signal?.aborted) break;
			console.error("DexScreener batch error:", error.message);
		}
	}

	return results;
}

async function getTokenData(tokenAddress, options = {}) {
	const results = await getTokensData([tokenAddress], options);
	return results.get(tokenAddress) || null;
}

module.exports = { getTokenData, getTokensData };
