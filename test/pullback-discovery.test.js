const test = require("node:test");
const assert = require("node:assert/strict");
const {
	createPullbackDiscovery,
	describeNewPool,
	mapPair,
	MIN_NEW_POOL_LIQUIDITY_USD
} = require("../pullbackDiscovery");

const NOW = 1_800_000_000_000;

function pool(overrides = {}) {
	return {
		id: "solana_pool-A",
		attributes: {
			address: "pool-A",
			base_token_address: "token-A",
			pool_created_at: new Date(NOW - 5 * 60_000).toISOString(),
			...overrides
		}
	};
}

function dexPair(overrides = {}) {
	return {
		chainId: "solana",
		pairAddress: "pool-A",
		pairCreatedAt: NOW - 5 * 60_000,
		baseToken: { address: "token-A", name: "Recent Coin", symbol: "NEW" },
		priceUsd: "0.001",
		liquidity: { usd: 35000 },
		volume: { m5: 9000, h24: 25000 },
		priceChange: { m5: 2, h1: 3, h24: 15 },
		txns: { m5: { buys: 40, sells: 15 } },
		...overrides
	};
}

test("parses GeckoTerminal's Solana new-pool records safely", () => {
	assert.deepEqual(describeNewPool(pool()), {
		poolAddress: "pool-A",
		tokenAddress: "token-A",
		createdAt: NOW - 5 * 60_000
	});
	assert.equal(describeNewPool({ id: "bad" }), null);
});

test("adds recent DexScreener pairs with fresh 24h volume only to the Pullback candidate list", async () => {
	let pairRequest;
	const base = { tokenAddress: "base-token", pairAddress: "base-pool", signal: "WAIT" };
	const discovery = createPullbackDiscovery({
		discoverExisting: async () => [base],
		getNewPools: async () => [pool()],
		httpGet: async (url, options) => {
			pairRequest = { url, options };
			return { data: { pairs: [dexPair()] } };
		},
		clock: () => NOW
	});
	const candidates = await discovery.discoverCandidates();
	assert.match(pairRequest.url, /\/latest\/dex\/pairs\/solana\/pool-A$/);
	assert.equal(pairRequest.options.timeout, 10000);
	assert.equal(candidates.length, 2);
	const recent = candidates.find(candidate => candidate.tokenAddress === "token-A");
	assert.equal(recent.discoverySource, "GECKOTERMINAL_NEW_POOL_DEXSCREENER");
	assert.equal(recent.volume24h, 25000, "new pools do not need to accumulate $100k in 24h to be watched");
	assert.equal(recent.liquidityUsd, 35000);
	assert.equal(recent.pairAddress, "pool-A");
	assert.equal(recent.newPoolCreatedAt, new Date(NOW - 5 * 60_000).toISOString());
	assert.equal(candidates.find(candidate => candidate.tokenAddress === "base-token"), base);
});

test("retains the existing $30k liquidity floor and requires the exact DexScreener pool/base token", () => {
	const descriptor = describeNewPool(pool());
	assert.equal(MIN_NEW_POOL_LIQUIDITY_USD, 30000);
	assert.equal(mapPair(dexPair({ liquidity: { usd: 29999 } }), descriptor), null);
	assert.equal(mapPair(dexPair({ pairAddress: "different-pool" }), descriptor), null);
	assert.equal(mapPair(dexPair({ baseToken: { address: "different-token" } }), descriptor), null);
});

test("remembers a new pool across scans so it can build candle history", async () => {
	let rounds = 0;
	const discovery = createPullbackDiscovery({
		discoverExisting: async () => [],
		getNewPools: async () => (++rounds === 1 ? [pool()] : []),
		httpGet: async () => ({ data: { pairs: [dexPair()] } }),
		clock: () => NOW
	});
	assert.equal((await discovery.discoverCandidates()).length, 1);
	assert.equal(discovery.getTrackedPoolCount(), 1);
	assert.equal((await discovery.discoverCandidates()).length, 1);
});

test("ignores stale pools and falls back to baseline discovery on source errors", async () => {
	let pairCalls = 0;
	const stalePool = pool({ pool_created_at: new Date(NOW - 61 * 60_000).toISOString() });
	const discovery = createPullbackDiscovery({
		discoverExisting: async () => [{ tokenAddress: "base-only" }],
		getNewPools: async () => [stalePool],
		httpGet: async () => { pairCalls += 1; return { data: { pairs: [] } }; },
		clock: () => NOW
	});
	assert.deepEqual(await discovery.discoverCandidates(), [{ tokenAddress: "base-only" }]);
	assert.equal(pairCalls, 0);

	const fallback = createPullbackDiscovery({
		discoverExisting: async () => [{ tokenAddress: "base-only" }],
		getNewPools: async () => { throw new Error("offline"); },
		clock: () => NOW
	});
	assert.deepEqual(await fallback.discoverCandidates(), [{ tokenAddress: "base-only" }]);
});
