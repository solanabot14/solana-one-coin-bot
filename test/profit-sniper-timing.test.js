const test = require("node:test");
const assert = require("node:assert/strict");
const { createMomentumTracker } = require("../profitSniperMomentum");
const { createHistoricalHydrator } = require("../profitSniperHydration");
const base = { tokenAddress: "mint-timing", pairAddress: "pool-timing", liquidityUsd: 20000 };
function sample(tracker, at, price, buys, volume) {
  return tracker.observe({ ...base, priceUsd: price, buys5m: buys, sells5m: 20, volume5m: volume, priceChange5m: 40 }, at);
}
test("irregular scans use the full 60-second window instead of only the last three samples", () => {
  const tracker = createMomentumTracker();
  sample(tracker, 0, 1.5, 100, 10000);
  sample(tracker, 30000, 1.4, 110, 11000);
  sample(tracker, 52500, 1.41, 120, 12000);
  const final = sample(tracker, 82500, 1.43, 140, 14000);
  assert.equal(final.ready, true);
  assert.equal(final.confirmationSpanMs, 82500);
});
test("less than 60 seconds or a stale observation gap cannot confirm recovery", () => {
  const tracker = createMomentumTracker();
  sample(tracker, 0, 1.5, 100, 10000);
  sample(tracker, 22500, 1.4, 110, 11000);
  assert.equal(sample(tracker, 52500, 1.42, 130, 13000).ready, false);
  assert.equal(sample(tracker, 140000, 1.44, 150, 15000).ready, false);
});
test("background hydration preserves accumulated live observations", () => {
  const tracker = createMomentumTracker();
  sample(tracker, 0, 1.5, 100, 10000);
  sample(tracker, 30000, 1.4, 110, 11000);
  tracker.hydrate(base, [
    {timestamp:-120,open:1,high:1.5,low:1,close:1.5},
    {timestamp:-60,open:1.5,high:1.5,low:1.35,close:1.4}
  ], 40000);
  const final = sample(tracker, 60000, 1.43, 130, 14000);
  assert.equal(final.historicalHydrated, true);
  assert.equal(final.confirmationSpanMs, 60000);
  assert.equal(final.ready, true);
});
test("a pending historical lookup never blocks scheduling or duplicates network calls", async () => {
  let release, calls=0, hydrated=0;
  const done = new Promise(resolve => {release=resolve;});
  const hydrator = createHistoricalHydrator({tracker:{hasHistorical:()=>false,hydrate:()=>hydrated++},
    data:{canFetchHistorical:()=>true,getHistoricalCandles:async()=>{calls++; return done;}}});
  assert.equal(hydrator.schedule(base), true);
  assert.equal(hydrator.schedule(base), false);
  assert.equal(hydrator.isPending(), true);
  await Promise.resolve(); assert.equal(calls, 1);
  release([]); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(hydrated, 1); assert.equal(hydrator.isPending(), false);
});
