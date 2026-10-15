const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const scanner = require("../scanner");

test("parallel paper strategies reuse one discovery scan and receive isolated snapshots", async t => {
	const previousGet = axios.get;
	const requests = [];
	axios.get = async url => {
		requests.push(url);
		if (url.includes("/tokens/v1/")) {
			return { data: [{ chainId: "solana", baseToken: { address: "token-A", name: "Token A", symbol: "A" },
				priceUsd: "1", liquidity: { usd: 60000 }, volume: { m5: 12000, h24: 160000 },
				priceChange: { m5: 2, h1: 5, h24: 10 }, txns: { m5: { buys: 40, sells: 20 } }, pairAddress: "pair-A" }] };
		}
		return { data: [{ chainId: "solana", tokenAddress: "token-A" }] };
	};
	t.after(() => { axios.get = previousGet; });

	const [first, second] = await Promise.all([
		scanner.discoverCandidates(),
		scanner.discoverCandidates()
	]);
	assert.equal(first.length, 1);
	assert.equal(second.length, 1);
	assert.equal(requests.length, 5); // four discovery feeds and one batched market-data request
	first[0].symbol = "mutated";
	assert.equal(second[0].symbol, "A");

	await scanner.discoverCandidates();
	assert.equal(requests.length, 5); // a near-simultaneous consumer uses the short shared cache
});
