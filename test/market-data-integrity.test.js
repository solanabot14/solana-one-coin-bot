const { test } = require("node:test");
const assert = require("node:assert/strict");
const { marketDataIntegritySnapshot } = require("../scanner");
const { pairToTokenData } = require("../dexscreener");

test("keeps ZEC-like liquidity/FDV inconsistency as warning while still blocking extreme MCAP/FDV contradiction", () => {
	const snapshot = marketDataIntegritySnapshot({
		tokenAddress: "TOKEN",
		pairAddress: "PAIR",
		priceUsd: 1645.39,
		liquidityUsd: 3000000,
		fdv: 40000,
		marketCap: 165100000,
		marketDataSource: "DexScreener"
	}, "TOKEN");

	assert.equal(snapshot.ok, false);
	assert.ok(snapshot.reasons.includes("EXTREME_MCAP_FDV_RATIO"));
	assert.ok(snapshot.warnings.includes("LIQUIDITY_FDV_INCONSISTENT"));
	assert.ok(!snapshot.reasons.includes("LIQUIDITY_FDV_INCONSISTENT"));
});

test("does not reject a legitimate expensive token solely because its unit price is high", () => {
	const snapshot = marketDataIntegritySnapshot({
		tokenAddress: "TOKEN",
		pairAddress: "PAIR",
		priceUsd: 2500,
		liquidityUsd: 500000,
		fdv: 12000000,
		marketCap: 10000000,
		marketDataSource: "DexScreener"
	}, "TOKEN");

	assert.equal(snapshot.ok, true);
	assert.deepEqual(snapshot.reasons, []);
});

test("pair parser preserves identity and market metadata for entry audit", () => {
	const data = pairToTokenData({
		chainId: "solana",
		dexId: "raydium",
		pairAddress: "PAIR",
		baseToken: { address: "TOKEN", name: "Token", symbol: "TOK" },
		quoteToken: { address: "SOL", symbol: "SOL" },
		priceUsd: "0.0029",
		liquidity: { usd: 491000 },
		volume: { m5: 2900, h1: 50000, h24: 500000 },
		priceChange: { m5: 0.99, h1: 24.95, h24: 79.24 },
		txns: { m5: { buys: 15, sells: 4 } },
		fdv: 2900000,
		marketCap: 2800000,
		pairCreatedAt: 123
	}, "TOKEN");

	assert.equal(data.tokenAddress, "TOKEN");
	assert.equal(data.pairAddress, "PAIR");
	assert.equal(data.dexId, "raydium");
	assert.equal(data.quoteTokenSymbol, "SOL");
	assert.equal(data.fdv, 2900000);
	assert.equal(data.marketCap, 2800000);
	assert.equal(data.marketDataSource, "DexScreener");
});
