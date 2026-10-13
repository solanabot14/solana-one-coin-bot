const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { getTokenData, getTokensData } = require("../dexscreener");
const { buildDashboardData } = require("../dashboardData");

function pair(address, liquidity, price, activity = {}) {
	return {
		chainId: "solana",
		baseToken: { address, name: "Token " + address, symbol: "T" + address },
		priceUsd: String(price),
		liquidity: { usd: liquidity },
		volume: { m5: activity.volume5m ?? 2500, h1: activity.volume1h ?? 12000, h24: 150000 },
		priceChange: { m5: 1, h1: 4, h24: 12 },
		txns: { m5: { buys: activity.buys5m ?? 20, sells: activity.sells5m ?? 5 } },
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


test("a saved position pool is preferred over another higher-liquidity pool", async t => {
	const previousGet = axios.get;
	const address = "token-pair-exact";
	const expectedPair = "pair-" + address + "-25";
	axios.get = async () => ({
		data: [
			pair(address, 25, 0.0001089),
			pair(address, 250, 0.0000446)
		]
	});
	t.after(() => { axios.get = previousGet; });

	const quote = await getTokenData(address, { pairAddress: expectedPair });
	assert.equal(quote.pairAddress, expectedPair);
	assert.equal(quote.priceUsd, "0.0001089");
});


test("a missing saved pool falls back to the most active pool and labels the quote", async t => {
	const previousGet = axios.get;
	const address = "token-pair-fallback";
	axios.get = async () => ({ data: [
		pair(address, 25000, 0.0000446, { volume5m: 700, buys5m: 2, sells5m: 1 }),
		pair(address, 5000, 0.0001089, { volume5m: 12000, buys5m: 48, sells5m: 12 })
	] });
	t.after(() => { axios.get = previousGet; });
	const quote = await getTokenData(address, { pairAddress: "pool-no-longer-returned", allowAlternatePairQuote: true });
	assert.equal(quote.priceUsd, "0.0001089");
	assert.notEqual(quote.pairAddress, "pool-no-longer-returned");
	assert.equal(quote.pairAddressMismatch, true);
	assert.match(quote.quoteWarning, /most active current pool/);
});


test("alternate pool quotes stay disabled unless explicitly enabled", async t => {
	const previousGet = axios.get;
	const address = "token-pair-fallback-disabled";
	axios.get = async () => ({ data: [pair(address, 25000, 0.0000446)] });
	t.after(() => { axios.get = previousGet; });
	const quote = await getTokenData(address, { pairAddress: "pool-no-longer-returned" });
	assert.equal(quote, null);
});

test("dashboard mark-to-market requests the position's saved pair", async () => {
	const position = {
		id: "carlo-position", tokenAddress: "carlo-token", pairAddress: "carlo-pool",
		symbol: "CARLO", entryPrice: 0.0000463, amountInvested: 12.69,
		quantity: 12.69 / 0.0000463, entryTime: new Date().toISOString(),
		highestPrice: 0.0000463
	};
	let requested;
	const account = await buildDashboardData({
		startingBalance: 100, cashBalance: 0, positions: [position], history: []
	}, async (address, options) => {
		requested = { address, pairAddress: options.pairAddress };
		return { priceUsd: 0.0001089, pairAddress: options.pairAddress };
	});

	assert.deepEqual(requested, { address: "carlo-token", pairAddress: "carlo-pool" });
	assert.ok(account.livePositions[0].live.pnl > 17);
	assert.ok(account.livePositions[0].live.pnlPercent > 135);
});

test("same-name tokens cannot substitute for the requested mint, including cached alternate pools", async t => {
 const previousGet=axios.get; t.after(()=>{axios.get=previousGet;});
 const mint='identity-mint', pool='saved-pool';
 const wrong={...pair('clone-mint',999999,999),baseToken:{address:'clone-mint',name:'Same',symbol:'SAME'},pairAddress:pool};
 const correct={...pair(mint,25000,1),baseToken:{address:mint,name:'Same',symbol:'SAME'},pairAddress:'alternate-pool'};
 axios.get=async()=>({data:[wrong,correct]});
 const fallback=await getTokenData(mint,{pairAddress:pool,allowAlternatePairQuote:true});
 assert.equal(fallback.tokenAddress,mint); assert.equal(fallback.pairAddress,'alternate-pool');
 assert.equal(await getTokenData(mint,{pairAddress:pool}),null);
});
