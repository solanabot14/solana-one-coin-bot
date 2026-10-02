const axios = require("axios");
const scanner = require("./scanner");
const geckoTerminal = require("./geckoTerminal");
const { analyzeToken } = require("./strategy");

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/pairs/solana";
const MAX_PAIR_ADDRESSES_PER_REQUEST = 30;
const MAX_TRACKED_NEW_POOLS = 60;
const MAX_NEW_POOL_AGE_MS = 60 * 60 * 1000;
const MIN_NEW_POOL_LIQUIDITY_USD = 30000;
const PAIR_REQUEST_TIMEOUT_MS = 10000;

function addressFromResourceId(id) {
	return typeof id === "string" ? id.replace(/^solana_/, "") : "";
}

function toTimestamp(value) {
	if (Number.isFinite(Number(value))) {
		const number = Number(value);
		return number > 1e12 ? number : number * 1000;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function describeNewPool(pool) {
	const attributes = pool?.attributes || {};
	const relationships = pool?.relationships || {};
	const poolAddress = attributes.address || addressFromResourceId(pool?.id);
	const tokenAddress = attributes.base_token_address ||
		addressFromResourceId(relationships.base_token?.data?.id);
	const createdAt = toTimestamp(attributes.pool_created_at || attributes.created_at);
	if (!poolAddress || !tokenAddress || !createdAt) return null;
	return { poolAddress, tokenAddress, createdAt };
}

function mapPair(pair, descriptor) {
	if (!pair || !descriptor || pair.chainId !== "solana" || pair.pairAddress !== descriptor.poolAddress ||
		pair.baseToken?.address !== descriptor.tokenAddress) return null;
	const data = {
		name: pair.baseToken?.name,
		symbol: pair.baseToken?.symbol,
		priceUsd: pair.priceUsd,
		liquidityUsd: pair.liquidity?.usd,
		volume5m: pair.volume?.m5,
		volume24h: pair.volume?.h24,
		priceChange5m: pair.priceChange?.m5,
		priceChange1h: pair.priceChange?.h1,
		priceChange24h: pair.priceChange?.h24,
		buys5m: pair.txns?.m5?.buys,
		sells5m: pair.txns?.m5?.sells,
		tokenAddress: descriptor.tokenAddress,
		pairAddress: descriptor.poolAddress,
		pairCreatedAt: pair.pairCreatedAt || descriptor.createdAt,
		newPoolCreatedAt: new Date(descriptor.createdAt).toISOString(),
		discoverySource: "GECKOTERMINAL_NEW_POOL_DEXSCREENER"
	};
	if ((Number(data.liquidityUsd) || 0) < MIN_NEW_POOL_LIQUIDITY_USD) return null;
	const analysis = analyzeToken(data);
	return { ...data, score: analysis.score, signal: analysis.signal, reasons: analysis.reasons };
}

function createPullbackDiscovery({
	discoverExisting = scanner.discoverCandidates,
	getNewPools = geckoTerminal.getNewSolanaPools,
	httpGet = axios.get,
	clock = Date.now,
	maxPoolAgeMs = MAX_NEW_POOL_AGE_MS,
	maxTrackedPools = MAX_TRACKED_NEW_POOLS
} = {}) {
	const trackedPools = new Map();

	async function fetchDexPairs(poolAddresses, signal) {
		const pairs = [];
		for (let start = 0; start < poolAddresses.length; start += MAX_PAIR_ADDRESSES_PER_REQUEST) {
			if (signal?.aborted) break;
			const batch = poolAddresses.slice(start, start + MAX_PAIR_ADDRESSES_PER_REQUEST);
			const url = `${DEXSCREENER_API}/${batch.join(",")}`;
			const response = await httpGet(url, { timeout: PAIR_REQUEST_TIMEOUT_MS, signal });
			if (Array.isArray(response?.data?.pairs)) pairs.push(...response.data.pairs);
		}
		return pairs;
	}

	async function discoverCandidates({ signal } = {}) {
		const existingPromise = Promise.resolve().then(() => discoverExisting({ signal }));
		let existing = [];
		try {
			existing = await existingPromise;
		} catch (error) {
			console.warn(`PULLBACK BASE DISCOVERY UNAVAILABLE | ${error.message}`);
		}
		if (!Array.isArray(existing)) existing = [];
		if (signal?.aborted) return existing;

		try {
			const freshPools = await getNewPools({ signal });
			const now = clock();
			for (const pool of Array.isArray(freshPools) ? freshPools : []) {
				const descriptor = describeNewPool(pool);
				if (!descriptor || descriptor.createdAt > now + 60_000 || now - descriptor.createdAt > maxPoolAgeMs) continue;
				trackedPools.set(descriptor.poolAddress, descriptor);
			}
			for (const [address, descriptor] of trackedPools) {
				if (now - descriptor.createdAt > maxPoolAgeMs) trackedPools.delete(address);
			}
			if (trackedPools.size > maxTrackedPools) {
				const newest = [...trackedPools.values()].sort((a, b) => b.createdAt - a.createdAt)
					.slice(0, maxTrackedPools);
				trackedPools.clear();
				for (const descriptor of newest) trackedPools.set(descriptor.poolAddress, descriptor);
			}

			const descriptors = [...trackedPools.values()];
			if (!descriptors.length) return existing;
			const dexPairs = await fetchDexPairs(descriptors.map(pool => pool.poolAddress), signal);
			const descriptorByPool = new Map(descriptors.map(pool => [pool.poolAddress, pool]));
			const recentCandidates = dexPairs.map(pair => mapPair(pair, descriptorByPool.get(pair?.pairAddress)))
				.filter(Boolean);
			const merged = new Map(existing.filter(coin => coin?.tokenAddress).map(coin => [coin.tokenAddress, coin]));
			for (const coin of recentCandidates) {
				const current = merged.get(coin.tokenAddress);
				if (!current || Number(coin.pairCreatedAt) > Number(current.pairCreatedAt || 0)) {
					merged.set(coin.tokenAddress, coin);
				}
			}
			console.log(`PULLBACK NEW DEX POOLS | tracked: ${descriptors.length} | eligible by liquidity: ${recentCandidates.length}`);
			return [...merged.values()];
		} catch (error) {
			if (!signal?.aborted) console.warn(`PULLBACK NEW DEX POOLS UNAVAILABLE | ${error.message}`);
			return existing;
		}
	}

	return { discoverCandidates, getTrackedPoolCount: () => trackedPools.size };
}

const client = createPullbackDiscovery();

module.exports = {
	DEXSCREENER_API,
	MAX_PAIR_ADDRESSES_PER_REQUEST,
	MAX_TRACKED_NEW_POOLS,
	MAX_NEW_POOL_AGE_MS,
	MIN_NEW_POOL_LIQUIDITY_USD,
	addressFromResourceId,
	toTimestamp,
	describeNewPool,
	mapPair,
	createPullbackDiscovery,
	discoverCandidates: client.discoverCandidates
};
