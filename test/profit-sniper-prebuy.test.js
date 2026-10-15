const test = require("node:test");
const assert = require("node:assert/strict");
const { createEntryGuard, poolLock } = require("../profitSniperPrebuy");
const coin = { tokenAddress: "mint-A", pairAddress: "pool-A", symbol: "TEST", priceUsd: 0.5,
  pairCreatedAt: 1800000000000 - 15 * 60 * 1000, liquidityUsd: 25000,
  volume5m: 2000, buys5m: 40, sells5m: 10, priceChange5m: 2,
  momentumPattern: { ready: true } };
const now = 1800000000000;
function report({ pair = "pool-A", mint = "mint-A", liquidity = 30000, lock = 100, burned = false } = {}) {
  return { mint: "mint-A", rugged: false, risks: [],
    token: { mintAuthority: null, freezeAuthority: null },
    topHolders: Array.from({ length: 10 }, (_, i) => ({ address: "holder-" + i, pct: 2 })),
    markets: [{ pubkey: pair, mintA: mint, mintB: "SOL",
      lp: { lpLockedPct: lock, lpLockedUSD: liquidity * lock / 100,
        lpBurned: burned, baseUSD: liquidity / 2, quoteUSD: liquidity / 2 } }] };
}
function pair({ liquidity = 30000, price = 1, token = "mint-A", pool = "pool-A", momentum = 2 } = {}) {
  return { chainId: "solana", pairAddress: pool, baseToken: { address: token },
    priceUsd: price, liquidity: { usd: liquidity }, pairCreatedAt: coin.pairCreatedAt,
    volume: { h24: 0, m5: 2000 }, txns: { m5: { buys: 40, sells: 10 } },
    priceChange: { m5: momentum, h1: 5, h24: 5 } };
}
function fixture({ first = pair(), final = pair({ price: 1.02 }), lockReport = report(), headers = {}, onWait, fail = false,
  verifyExecution = async () => ({allowed:true,lossPercent:0.5}) } = {}) {
  let time = now, quotes = 0;
  const urls = [];
  const guard = createEntryGuard({ clock: () => time,
    verifyExecution,
    wait: async ms => { time += ms; if (onWait) onWait(); },
    httpGet: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers["Cache-Control"], "no-cache");
      if (fail) throw new Error("HTTP_429");
      return { headers, data: url.includes("rugcheck") ? lockReport : { pairs: [quotes++ ? final : first] } };
    }
  });
  return { guard, urls };
}
test("healthy exact pool passes and uses the final price instead of discovery price", async () => {
  const { guard, urls } = fixture();
  const result = await guard.prepareEntry(coin);
  assert.equal(result.allowed, true);
  assert.equal(result.coin.priceUsd, 1.02);
  assert.equal(urls.length, 3);
  assert.equal(guard.getStatus().counters.passed, 1);
});
test("LP with insufficient reserves is rejected even if locked", () => {
  const result = poolLock(report({ liquidity: 0.00000034 }), coin);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "EXACT_POOL_RESERVES_TOO_LOW");
});
test("another pool's lock and another mint's quote cannot authorize a purchase", async () => {
  assert.equal(poolLock(report({ pair: "other-pool" }), coin).allowed, false);
  assert.equal(poolLock(report({ mint: "other-mint" }), coin).allowed, false);
  assert.equal((await fixture({ final: pair({ token: "other-mint" }) }).guard.prepareEntry(coin)).allowed, false);
});
test("liquidity collapse, missing data, disagreement, and stale responses fail closed", async () => {
  const cases = [
    { first: pair({ liquidity: 30000 }), final: pair({ liquidity: 21000 }), lockReport: report({ liquidity: 21000 }) },
    { final: pair({ liquidity: 7999 }) },
    { final: pair({ liquidity: null }) },
    { final: pair({ price: null }) },
    { lockReport: report({ liquidity: 40000 }) },
    { headers: { age: "20" } },
    { fail: true }
  ];
  for (const options of cases) assert.equal((await fixture(options).guard.prepareEntry(coin)).allowed, false);
});
test("exact 20% liquidity drop remains eligible", async () => {
  const { guard } = fixture({ first: pair({ liquidity: 25000 }), final: pair({ liquidity: 20000 }), lockReport: report({ liquidity: 20000 }) });
  assert.equal((await guard.prepareEntry(coin)).allowed, true);
});
test("high five-minute movement is informational; confirmed activity and fresh safety checks still required", async () => {
  assert.equal((await fixture({ final: pair({ momentum: 36 }) }).guard.prepareEntry(coin)).allowed, true);
  const confirmed = { ...coin, momentumPattern: { ready: true, pullbackObserved: true,
    entryRoute: "confirmed_pullback_recovery" } };
  assert.equal((await fixture({ first: pair({ momentum: 80 }), final: pair({ momentum: 80 }) })
    .guard.prepareEntry(confirmed)).allowed, true);
  assert.equal((await fixture({ final: pair({ momentum: 30 }) }).guard.prepareEntry(coin)).allowed, true);
});
test("missing and insufficient exact-pool lock are rejected below the 30% floor", () => {
  for (const lock of [null, undefined, "", 0, 29, 101]) {
    const r = report(); r.markets[0].lp.lpLockedPct = lock;
    assert.equal(poolLock(r, coin).allowed, false);
  }
  assert.equal(poolLock(report({ lock: 30 }), coin).allowed, true);
  assert.equal(poolLock(report({ lock: 70 }), coin).allowed, true);
});
test("burned LP can pass without a lock only when RugCheck explicitly marks it burned", () => {
  assert.equal(poolLock(report({ burned: true, lock: 0 }), coin).allowed, true);
});
test("stopping during confirmation cancels the candidate", async () => {
  const controller = new AbortController();
  const { guard } = fixture({ onWait: () => controller.abort() });
  assert.equal((await guard.prepareEntry(coin, { signal: controller.signal })).allowed, false);
});

test("missing execution routes and final price falling both prevent entry", async () => {
  const missing=fixture({verifyExecution:async()=>({allowed:false,reason:"NO_SELL_ROUTE"})});
  assert.equal((await missing.guard.prepareEntry(coin)).reason,"NO_SELL_ROUTE");
  const falling=fixture({first:pair({price:1}),final:pair({price:0.99})});
  assert.equal((await falling.guard.prepareEntry(coin)).reason,"PRICE_FALLING_BEFORE_PURCHASE");
});

