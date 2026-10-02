const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { getTokensData } = require("../dexscreener");

function pair(address, liquidity, price) {
	return {
		chainId: "solana",
		baseToken: { address, name: "Token " + address, symbol: "T" + address },
		priceUsd: String(price),
		liquidity: { usd: liquidity },
		volume: { m5: 2500, h24: 150000 },
		priceChange: { m5: 1, h1: 4, h24: 12 },
		txns: { m5: { buys: 20, sells: 5 } },
		pairAddress: "pair-" + address + "-" + liquidity
	};
}

test("scanner data lookup batches at most 30 tokens and keeps the most liquid Solana pair", async t => {
	const previousGet = axios.get;
	const requests = [];
	const addresses = Array.from({ length: 31 }, (_, index) => "token-" + index);

	axios.get = async url => {
		requests.push(url);
		const requested = url.slice(url.lastIndexOf("/") + 1).split(",");
		const pairs = requested.map((address, index) => pair(address, index === 0 ? 100 : 10, index === 0 ? 2 : 1));
		if (requested.includes(addresses[0])) {
			pairs.push(pair(addresses[0], 250, 3));
		}
		return { data: pairs };
	};

	t.after(() => { axios.get = previousGet; });
	const data = await getTokensData(addresses);

	assert.equal(requests.length, 2);
	assert.ok(requests[0].includes(addresses.slice(0, 30).join(",")));
	assert.ok(requests[1].endsWith(addresses[30]));
	assert.equal(data.size, 31);
	assert.equal(data.get(addresses[0]).priceUsd, "3");
	assert.equal(data.get(addresses[0]).liquidityUsd, 250);
	assert.equal(data.get(addresses[30]).symbol, "Ttoken-30");
	assert.equal(data.get(addresses[30]).volume5m, 2500);
});
