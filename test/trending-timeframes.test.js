const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	birdeyeTrendingItems,
	birdeyeTrendingToTokens,
	mergeDiscoveryTokens
} = require("../scanner");

test("extracts Birdeye trending items from supported response shapes", () => {
	const items = [{ address:"A" }, { address:"B" }];
	assert.deepEqual(birdeyeTrendingItems({ data:{ tokens:items } }), items);
	assert.deepEqual(birdeyeTrendingItems({ data:{ items } }), items);
	assert.deepEqual(birdeyeTrendingItems({ data:items }), items);
});

test("Birdeye Trending 1H caps unique token addresses", () => {
	const items = [
		{ address:"A" },
		{ address:"A" },
		{ address:"B" },
		{ address:"C" }
	];
	const tokens = birdeyeTrendingToTokens(items, 2);
	assert.deepEqual(tokens.map(token => token.tokenAddress), ["A", "B"]);
	assert.ok(tokens.every(token => token.discoverySource === "Birdeye Trending 1H"));
});

test("Birdeye discovery dedupes with existing sources and preserves labels", () => {
	const merged = mergeDiscoveryTokens([
		{
			name:"Latest Profiles", type:"organic",
			tokens:[{ chainId:"solana", tokenAddress:"A", discoverySource:"Latest Profiles", discoveryType:"organic" }]
		},
		{
			name:"Birdeye Trending 1H", type:"organic",
			tokens:[{ chainId:"solana", tokenAddress:"A", discoverySource:"Birdeye Trending 1H", discoveryType:"organic" }]
		}
	]);
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].discoverySources, ["Latest Profiles", "Birdeye Trending 1H"]);
});
