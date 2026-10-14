const test = require("node:test");
const assert = require("node:assert/strict");
const { createEntryGuard, poolLock } = require("../profitSniperPrebuy");
const coin = { tokenAddress: "mint-A", pairAddress: "pool-A", symbol: "TEST", priceUsd: 0.5 };
const now = 1800000000000;
function report({ pair = "pool-A", mint = "mint-A", liquidity = 30000, lock = 100 } = {}) {
  return { mint: "mint-A", markets: [{ pubkey: pair, mintA: mint, mintB: "SOL",
    lp: { lpLockedPct: lock, baseUSD: liquidity / 2, quoteUSD: liquidity / 2 } }] };
}
function pair({ liquidity = 30000, price = 1, token = "mint-A", pool = "pool-A", momentum = 2 } = {}) {
  return { chainId: "solana", pairAddress: pool, baseToken: { address: token },
    priceUsd: price, liquidity: { usd: liquidity }, pairCreatedAt: now - 15 * 60 * 1000,
    volume: { h24: 30000, m5: 2000 }, txns: { m5: { buys: 12, sells: 5 } },
    priceChange: { m5: momentum, h1: 5, h24: 5 } };
}
function fixture({ first = pair(), final = pair({ price: 1.02 }), lockReport = report(), headers = {}, onWait, fail = false } = {}) {
  let time = now, quotes = 0;
  const urls = [];
  const guard = createEntryGuard({ clock: () => time,
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
test("AI worm pattern: 100% locked but almost empty reserves is rejected", () => {
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
    { final: pair({ liquidity: 14999 }) },
    { final: pair({ liquidity: null }) },
    { final: pair({ price: null }) },
    { lockReport: report({ liquidity: 40000 }) },
    { headers: { age: "10" } },
    { fail: true }
  ];
  for (const options of cases) assert.equal((await fixture(options).guard.prepareEntry(coin)).allowed, false);
});
test("exact 20% liquidity drop remains eligible", async () => {
  const { guard } = fixture({ first: pair({ liquidity: 25000 }), final: pair({ liquidity: 20000 }) });
  assert.equal((await guard.prepareEntry(coin)).allowed, true);
});
test("fresh momentum uses the same limits and does not buy a fading or overheated candidate", async () => {
  for (const momentum of [-1, 21]) {
    assert.equal((await fixture({ final: pair({ momentum }) }).guard.prepareEntry(coin)).allowed, false);
  }
});
test("missing and insufficient exact-pool lock are rejected below the 30% floor", () => {
  for (const lock of [null, undefined, "", 0, 29, 101]) {
    const r = report(); r.markets[0].lp.lpLockedPct = lock;
    assert.equal(poolLock(r, coin).allowed, false);
  }
  assert.equal(poolLock(report({ lock: 30 }), coin).allowed, true);
  assert.equal(poolLock(report({ lock: 70 }), coin).allowed, true);
});
test("stopping during confirmation cancels the candidate", async () => {
  const controller = new AbortController();
  const { guard } = fixture({ onWait: () => controller.abort() });
  assert.equal((await guard.prepareEntry(coin, { signal: controller.signal })).allowed, false);
});
