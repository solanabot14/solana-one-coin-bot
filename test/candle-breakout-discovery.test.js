const test = require("node:test");
const assert = require("node:assert/strict");
const { createPullbackDiscovery } = require("../pullbackDiscovery");

test("candle discovery rotates through qualified pools and caps each scan", async () => {
	const candidates = Array.from({ length: 4 }, (_, index) => ({ tokenAddress: `token-${index}`, pairAddress: `pool-${index}`,
		liquidityUsd: 25000, volume5m: 5000 - index, symbol: `T${index}` }));
	const requested = [];
	const discovery = createPullbackDiscovery({
		discoverExisting: async () => candidates,
		getNewPools: async () => [],
		getPoolCandles: async (poolAddress, tokenAddress) => { requested.push(tokenAddress); return [{ timestamp: 1 }]; },
		maxCandlesPerScan: 2
	});
	const first = await discovery.discoverCandidates();
	const second = await discovery.discoverCandidates();
	assert.deepEqual(first.map(coin => coin.tokenAddress), ["token-0", "token-1"]);
	assert.deepEqual(second.map(coin => coin.tokenAddress), ["token-2", "token-3"]);
	assert.deepEqual(requested, ["token-0", "token-1", "token-2", "token-3"]);
	assert.ok(first.every(coin => Array.isArray(coin.ohlcv1m)));
});
