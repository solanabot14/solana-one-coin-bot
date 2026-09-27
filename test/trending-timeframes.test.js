const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	extractDexScreenerServerData,
	trendingPairsToTokens,
	mergeDiscoveryTokens
} = require("../scanner");

test("extracts DexScreener embedded server data without changing strategy data", () => {
	const html = '<html><script>window.__SERVER_DATA = {route:{data:{dexScreenerData:{pairs:[{chainId:"solana",baseToken:{address:"A"}}]}}}};</script></html>';
	const data = extractDexScreenerServerData(html);
	assert.equal(data.route.data.dexScreenerData.pairs[0].baseToken.address, "A");
});

test("Trending 1H caps unique Solana base tokens at configured limit", () => {
	const source = { name: "Trending 1H", type: "organic", limit: 2 };
	const pairs = [
		{ chainId:"solana", baseToken:{ address:"A" } },
		{ chainId:"ethereum", baseToken:{ address:"ETH" } },
		{ chainId:"solana", baseToken:{ address:"A" } },
		{ chainId:"solana", baseToken:{ address:"B" } },
		{ chainId:"solana", baseToken:{ address:"C" } }
	];

	const tokens = trendingPairsToTokens(pairs, source);
	assert.deepEqual(tokens.map(token => token.tokenAddress), ["A", "B"]);
	assert.ok(tokens.every(token => token.discoverySource === "Trending 1H"));
});

test("timeframe discovery dedupes with existing sources while preserving source labels", () => {
	const merged = mergeDiscoveryTokens([
		{
			name:"Latest Profiles",
			type:"organic",
			tokens:[{
				chainId:"solana",
				tokenAddress:"A",
				discoverySource:"Latest Profiles",
				discoveryType:"organic"
			}]
		},
		{
			name:"Trending 5M",
			type:"organic",
			tokens:[{
				chainId:"solana",
				tokenAddress:"A",
				discoverySource:"Trending 5M",
				discoveryType:"organic"
			}]
		}
	]);

	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].discoverySources, ["Latest Profiles", "Trending 5M"]);
});
