const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeDiscoveryTokens } = require("../scanner");

test("discovery merges duplicate Solana tokens and preserves all source labels", () => {
	const merged = mergeDiscoveryTokens([
		{
			name:"Recent Profile Updates",
			type:"organic",
			tokens:[
				{ chainId:"solana", tokenAddress:"A", discoverySource:"Recent Profile Updates", discoveryType:"organic" },
				{ chainId:"ethereum", tokenAddress:"ETH", discoverySource:"Recent Profile Updates", discoveryType:"organic" }
			]
		},
		{
			name:"Latest Boosts",
			type:"boosted",
			tokens:[
				{ chainId:"solana", tokenAddress:"A", discoverySource:"Latest Boosts", discoveryType:"boosted" },
				{ chainId:"solana", tokenAddress:"B", discoverySource:"Latest Boosts", discoveryType:"boosted" }
			]
		},
		{
			name:"Trending Metas",
			type:"organic",
			tokens:[
				{ chainId:"solana", tokenAddress:"C", discoverySource:"Trending Metas", discoveryType:"organic" }
			]
		}
	]);

	assert.equal(merged.length, 3);
	const a = merged.find(token => token.tokenAddress === "A");
	assert.deepEqual(a.discoverySources, ["Recent Profile Updates", "Latest Boosts"]);
	assert.deepEqual(a.discoveryTypes, ["organic", "boosted"]);
	assert.equal(merged.some(token => token.tokenAddress === "ETH"), false);
});

test("boosted-only tokens remain eligible discovery candidates rather than being banned", () => {
	const merged = mergeDiscoveryTokens([
		{
			name:"Latest Boosts",
			type:"boosted",
			tokens:[
				{ chainId:"solana", tokenAddress:"BOOST", discoverySource:"Latest Boosts", discoveryType:"boosted" }
			]
		}
	]);

	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].discoverySources, ["Latest Boosts"]);
	assert.deepEqual(merged[0].discoveryTypes, ["boosted"]);
});
