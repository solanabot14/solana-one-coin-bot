const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMarket(pairs) {
	const requests = [];
	const sandbox = {
		module: { exports: {} },
		console,
		require(name) {
			assert.equal(name, "axios");
			return {
				get: async (url, options) => {
					requests.push({ url, options });
					return { data: { pairs } };
				}
			};
		}
	};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, "../dexscreener.js"), "utf8"),
		sandbox
	);
	return { market: sandbox.module.exports, requests };
}

test("pair lock keeps the entry pool even when another pool has more liquidity", async () => {
	const { market, requests } = loadMarket([
		{
			chainId: "solana", pairAddress: "WRONG_HIGH_LIQ",
			baseToken: { address: "TOKEN", symbol: "T" },
			liquidity: { usd: 9999999 }, priceUsd: "782000"
		},
		{
			chainId: "solana", pairAddress: "ENTRY_PAIR",
			baseToken: { address: "TOKEN", symbol: "T" },
			liquidity: { usd: 100000 }, priceUsd: "0.63",
			volume: { m5: 5000, h1: 50000, h24: 500000 }
		}
	]);

	const data = await market.getTokenData("TOKEN", { pairAddress: "ENTRY_PAIR" });
	assert.equal(data.priceUsd, "0.63");
	assert.equal(data.pairAddress, "ENTRY_PAIR");
	assert.equal(requests.length, 1);
	assert.match(requests[0].url, /\/latest\/dex\/pairs\/solana\/ENTRY_PAIR$/);
});

test("pair lock never falls back when the saved entry pair is missing", async () => {
	const { market } = loadMarket([
		{
			chainId: "solana", pairAddress: "OTHER_PAIR",
			baseToken: { address: "TOKEN" },
			liquidity: { usd: 9999999 }, priceUsd: "1000"
		}
	]);

	const data = await market.getTokenData("TOKEN", { pairAddress: "ENTRY_PAIR" });
	assert.equal(data, null);
});

test("pair lock rejects a saved pair whose base token no longer matches", async () => {
	const { market } = loadMarket([
		{
			chainId: "solana", pairAddress: "ENTRY_PAIR",
			baseToken: { address: "OTHER_TOKEN" },
			liquidity: { usd: 9999999 }, priceUsd: "1000"
		}
	]);

	const data = await market.getTokenData("TOKEN", { pairAddress: "ENTRY_PAIR" });
	assert.equal(data, null);
});


function loadMarketWithResponder(responder) {
	const requests = [];
	const sandbox = {
		module: { exports: {} },
		console,
		process: { env: {} },
		require(name) {
			assert.equal(name, "axios");
			return {
				get: async (url, options) => {
					requests.push({ url, options });
					return responder(url, options);
				}
			};
		}
	};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, "../dexscreener.js"), "utf8"),
		sandbox
	);
	return { market: sandbox.module.exports, requests };
}

test("pair shock uses a liquid alternate quote instead of an absurd locked-pair price", async () => {
	const exact = {
		chainId: "solana",
		pairAddress: "ENTRY_PAIR",
		baseToken: { address: "TOKEN", symbol: "T" },
		quoteToken: { symbol: "USDT" },
		liquidity: { usd: 1200 },
		priceUsd: "0.000001"
	};
	const alternate = {
		chainId: "solana",
		pairAddress: "HEALTHY_PAIR",
		baseToken: { address: "TOKEN", symbol: "T" },
		quoteToken: { symbol: "USDC" },
		liquidity: { usd: 500000 },
		priceUsd: "1.02",
		volume: { m5: 5000, h1: 50000, h24: 500000 }
	};

	const { market, requests } = loadMarketWithResponder(async url => {
		if (url.includes("/pairs/solana/ENTRY_PAIR")) return { data: { pairs: [exact] } };
		if (url.includes("/tokens/TOKEN")) return { data: { pairs: [exact, alternate] } };
		throw new Error("Unexpected URL " + url);
	});

	const data = await market.getTokenData("TOKEN", {
		pairAddress: "ENTRY_PAIR",
		referencePrice: 1
	});

	assert.equal(data.priceUsd, "1.02");
	assert.equal(data.pairAddress, "HEALTHY_PAIR");
	assert.equal(data.pairSanityFallbackApplied, true);
	assert.equal(requests.length, 2);
});

test("pair shock is accepted when an independent liquid pair confirms the move", async () => {
	const exact = {
		chainId: "solana",
		pairAddress: "ENTRY_PAIR",
		baseToken: { address: "TOKEN", symbol: "T" },
		liquidity: { usd: 500000 },
		priceUsd: "0.40"
	};
	const alternate = {
		chainId: "solana",
		pairAddress: "HEALTHY_PAIR",
		baseToken: { address: "TOKEN", symbol: "T" },
		liquidity: { usd: 400000 },
		priceUsd: "0.42"
	};

	const { market } = loadMarketWithResponder(async url => {
		if (url.includes("/pairs/solana/ENTRY_PAIR")) return { data: { pairs: [exact] } };
		if (url.includes("/tokens/TOKEN")) return { data: { pairs: [exact, alternate] } };
		throw new Error("Unexpected URL " + url);
	});

	const data = await market.getTokenData("TOKEN", {
		pairAddress: "ENTRY_PAIR",
		referencePrice: 1
	});

	assert.equal(data.priceUsd, "0.40");
	assert.equal(data.pairAddress, "ENTRY_PAIR");
	assert.equal(data.pairSanityVerified, true);
});
