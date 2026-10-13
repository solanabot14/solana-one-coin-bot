const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeckoTerminalClient, normalizeCandles } = require("../geckoTerminal");

test("normalizes pool OHLCV chronologically and excludes the still-open candle", () => {
	const nowMs = 1_800_000_000_000;
	const nowSeconds = Math.floor(nowMs / 1000);
	const payload = { data: { attributes: { ohlcv_list: [
		[nowSeconds, 1.2, 1.3, 1.1, 1.25, 500],
		[nowSeconds - 60, 1.1, 1.2, 1.0, 1.2, 400],
		[nowSeconds - 120, 1.0, 1.1, 0.9, 1.1, 300]
	] } } };
	const candles = normalizeCandles(payload, nowMs);
	assert.deepEqual(candles.map(candle => candle.timestamp), [nowSeconds - 120, nowSeconds - 60]);
	assert.equal(candles[0].volume, 300);
});

test("uses keyless GeckoTerminal public OHLCV, spaces calls, and clones cached results", async () => {
	const nowMs = 1_800_000_000_000;
	const rows = [[nowMs / 1000 - 60, 1, 1.1, 0.9, 1.05, 100]];
	let calls = 0;
	const client = createGeckoTerminalClient({
		clock: () => nowMs,
		requestSpacingMs: 0,
		httpGet: async (url, options) => {
			calls += 1;
			assert.match(url, /api\.geckoterminal\.com\/api\/v2\/networks\/solana\/pools\/pool-A\/ohlcv\/minute/);
			assert.deepEqual(options.params, { aggregate: 1, limit: 60, currency: "usd", token: "base" });
			assert.equal(options.params.api_key, undefined);
			return { data: { data: { attributes: { ohlcv_list: rows } } } };
		}
	});
	const first = await client.getPoolCandles("pool-A", "token-A");
	first[0].close = 999;
	const second = await client.getPoolCandles("pool-A", "token-A");
	assert.equal(calls, 1);
	assert.equal(second[0].close, 1.05);
});

test("fetches and caches the public Solana new-pools feed through the shared rate-limited queue", async () => {
	const nowMs = 1_800_000_000_000;
	const pool = { id: "solana_pool-A", attributes: { address: "pool-A" } };
	let calls = 0;
	const client = createGeckoTerminalClient({
		clock: () => nowMs,
		requestSpacingMs: 0,
		httpGet: async (url, options) => {
			calls += 1;
			assert.match(url, /api\.geckoterminal\.com\/api\/v2\/networks\/solana\/new_pools$/);
			assert.deepEqual(options.params, { include: "base_token,quote_token" });
			assert.equal(options.params.api_key, undefined);
			return { data: { data: [pool] } };
		}
	});
	const first = await client.getNewSolanaPools();
	first[0].attributes.address = "mutated";
	const second = await client.getNewSolanaPools();
	assert.equal(calls, 1);
	assert.equal(second[0].attributes.address, "pool-A");
});

test("caches a public feed error briefly to prevent request retries", async () => {
	let calls = 0;
	const nowMs = 1_800_000_000_000;
	const client = createGeckoTerminalClient({
		clock: () => nowMs,
		requestSpacingMs: 0,
		httpGet: async () => { calls += 1; throw new Error("temporary HTTP 429"); }
	});
	await assert.rejects(client.getPoolCandles("pool-B", "token-B"), /429/);
	assert.deepEqual(await client.getPoolCandles("pool-B", "token-B"), []);
	assert.equal(calls, 1);
});

test("spaces uncached pool requests below the public endpoint's approximate rate ceiling", async () => {
	let nowMs = 1_800_000_000_000;
	const requestTimes = [];
	const client = createGeckoTerminalClient({
		clock: () => nowMs,
		sleep: async ms => { nowMs += ms; },
		cacheMs: 0,
		requestSpacingMs: 7500,
		httpGet: async () => {
			requestTimes.push(nowMs);
			return { data: { data: { attributes: { ohlcv_list: [] } } } };
		}
	});
	await client.getPoolCandles("pool-C1", "token-C1");
	await client.getPoolCandles("pool-C2", "token-C2");
	await client.getPoolCandles("pool-C3", "token-C3");
	assert.ok(requestTimes[1] - requestTimes[0] >= 7500);
	assert.ok(requestTimes[2] - requestTimes[1] >= 7500);
});

test("fetches and caches mature-pool discovery feeds", async () => {
  const nowMs = 1_800_000_000_000;
  const calls = [];
  const client = createGeckoTerminalClient({
    clock: () => nowMs,
    requestSpacingMs: 0,
    httpGet: async (url, options) => {
      calls.push({ url, params: options.params });
      return { data: { data: [{ id: "solana_pool-A", attributes: { address: "pool-A" } }] } };
    }
  });
  assert.equal((await client.getTrendingSolanaPools())[0].attributes.address, "pool-A");
  assert.equal((await client.getTopSolanaPools())[0].attributes.address, "pool-A");
  assert.match(calls[0].url, /networks\/solana\/trending_pools$/);
  assert.equal(calls[0].params.duration, "24h");
  assert.match(calls[1].url, /networks\/solana\/pools$/);
  assert.equal(calls[1].params.page, 1);
});
