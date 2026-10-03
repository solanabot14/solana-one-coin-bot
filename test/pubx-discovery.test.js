const test = require("node:test");
const assert = require("node:assert/strict");
const { createPubxDiscovery, MIN_LIQUIDITY_USD } = require("../pubxDiscovery");

function profile(address) {
  return { chainId: "solana", tokenAddress: address };
}

test("keeps candidates under $100k 24h volume when recent-flow data is available", async () => {
  const calls = [];
  const getTokenDataBatch = async addresses => new Map([
    ["fast-token", { symbol: "FAST", pairAddress: "fast-pool", priceUsd: 1,
      liquidityUsd: 40000, volume5m: 6500, volume24h: 18000,
      priceChange5m: 4, buys5m: 35, sells5m: 15 }],
    ["thin-token", { symbol: "THIN", pairAddress: "thin-pool", priceUsd: 1,
      liquidityUsd: 29999, volume5m: 12000, volume24h: 9000,
      priceChange5m: 5, buys5m: 40, sells5m: 10 }]
  ]);
  const discovery = createPubxDiscovery({
    httpGet: async url => {
      calls.push(url);
      return { data: [profile("fast-token"), profile("thin-token")] };
    },
    getTokenDataBatch
  });
  const candidates = await discovery.discoverCandidatesFresh();
  assert.equal(calls.length, 4);
  assert.equal(MIN_LIQUIDITY_USD, 30000);
  assert.deepEqual(candidates.map(coin => coin.tokenAddress), ["fast-token"]);
  assert.equal(candidates[0].volume24h, 18000);
  assert.match(candidates[0].reasons[0], /no \$100k minimum/);
});

test("deduplicates profile feeds and caches a discovery snapshot briefly", async () => {
  let sourceCalls = 0;
  let batchCalls = 0;
  const discovery = createPubxDiscovery({
    httpGet: async () => {
      sourceCalls += 1;
      return { data: [profile("token-a"), profile("token-a")] };
    },
    getTokenDataBatch: async addresses => {
      batchCalls += 1;
      assert.deepEqual(addresses, ["token-a"]);
      return new Map([["token-a", { pairAddress: "pool-a", liquidityUsd: 50000,
        volume5m: 8000, volume24h: 50000 }]]);
    },
    clock: () => 1000
  });
  const first = await discovery.discoverCandidates();
  const second = await discovery.discoverCandidates();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(sourceCalls, 4);
  assert.equal(batchCalls, 1);
});
