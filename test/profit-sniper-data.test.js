const test = require("node:test");
const assert = require("node:assert/strict");
const { createSniperDataClient } = require("../profitSniperData");
const { holderConcentration, isLiquidityBurned } = require("../profitSniperEntryGuard");
const report = { mint: "mint-A", markets: [{ pubkey: "pool-A" }], topHolders: [{ pct: 2 }] };
test("incomplete reports are retried and never cached as verified", async () => {
  let now = 100000, calls = 0;
  const client = createSniperDataClient({ clock: () => now, wait: async ms => {now += ms;},
    httpGet: async () => ({data: ++calls === 1 ? {...report,topHolders:[]} : report}) });
  assert.equal((await client.getReport("mint-A")).data.topHolders.length, 1);
  assert.equal(calls, 2);
  const incomplete = createSniperDataClient({ clock: () => now, wait: async ms => {now += ms;},
    httpGet: async () => ({data: {...report,topHolders:[]}}) });
  await assert.rejects(incomplete.getReport("mint-A"), /SECURITY_DATA_PENDING: INCOMPLETE/);
});
test("simultaneous security lookups share one request and expire within ten seconds", async () => {
  let now = 100000, calls = 0;
  const client = createSniperDataClient({ clock: () => now,
    httpGet: async () => { calls++; return { data: report }; } });
  const [a, b] = await Promise.all([client.getReport("mint-A"), client.getReport("mint-A")]);
  assert.equal(calls, 1); a.data.mint = "mutated";
  assert.equal(b.data.mint, "mint-A");
  now += 7500; assert.equal((await client.getReport("mint-A")).sampledAt, 100000);
  assert.equal(calls, 1);
  now += 2501; await client.getReport("mint-A"); assert.equal(calls, 2);
});
test("HTTP 400 remains pending, is not hammered, and is retried after cooldown", async () => {
  let now = 100000, calls = 0;
  const client = createSniperDataClient({ clock: () => now, httpGet: async () => {
    if (++calls === 1) throw Object.assign(new Error("bad request"), { response: { status: 400 } });
    return { data: report };
  } });
  await assert.rejects(client.getReport("mint-A"), /SECURITY_DATA_PENDING: HTTP 400/);
  await assert.rejects(client.getReport("mint-A"), /SECURITY_DATA_PENDING/);
  assert.equal(calls, 1); now += 30001;
  assert.equal((await client.getReport("mint-A")).data.mint, "mint-A");
});
test("transient failures retry once and 429 Retry-After prevents requests across tokens", async () => {
  let now = 100000, calls = 0;
  const client = createSniperDataClient({ clock: () => now, wait: async ms => { now += ms; },
    httpGet: async () => { if (++calls === 1) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return { data: report }; } });
  await client.getReport("mint-A"); assert.equal(calls, 2); assert.equal(now, 101000);
  calls = 0;
  const limited = createSniperDataClient({ clock: () => now, httpGet: async () => {
    calls++; throw Object.assign(new Error("limited"), { response: { status: 429, headers: { "retry-after": "60" } } });
  } });
  await assert.rejects(limited.getReport("mint-A"), /HTTP 429/);
  await assert.rejects(limited.getReport("mint-B"), /provider rate limit/);
  assert.equal(calls, 1);
});
test("RugCheck DNS outages back off across mints and recover with the configured API origin", async () => {
  let now = 100000, calls = 0, requestedUrl;
  const client = createSniperDataClient({ clock: () => now, wait: async ms => { now += ms; },
    rugCheckBaseUrl: "https://rugcheck-api.example/",
    httpGet: async url => {
      requestedUrl = url;
      if (++calls <= 2) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      return { data: { ...report, mint: "mint-C" } };
    } });
  await assert.rejects(client.getReport("mint-A"), /RugCheck DNS unavailable \(ENOTFOUND\)/);
  await assert.rejects(client.getReport("mint-B"), /RugCheck DNS unavailable/);
  assert.equal(calls, 2); // one failed lookup plus its bounded retry
  now += 30001;
  await client.getReport("mint-C");
  assert.equal(calls, 3);
  assert.equal(requestedUrl, "https://rugcheck-api.example/v1/tokens/mint-C/report");
});
test("wrong mint, stale response and cancelled requests never become approvals", async () => {
  for (const response of [{ data: { ...report, mint: "wrong" } }, { data: report, headers: { age: "20" } }]) {
    const client = createSniperDataClient({ httpGet: async () => response });
    await assert.rejects(client.getReport("mint-A"), /SECURITY_DATA_PENDING/);
  }
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const client = createSniperDataClient({ httpGet: async () => { calls++; return { data: report }; } });
  await assert.rejects(client.getReport("mint-A", controller.signal), /ABORTED/);
  assert.equal(calls, 0);
});
test("only verified token reserve accounts and the incinerator are excluded", () => {
  const r = { mint: "mint-A", markets: [{ mintA: "mint-A", liquidityA: "vault",
    liquidityAAccount: { mint: "mint-A", owner: "pool", delegate: null, closeAuthority: null } }],
    topHolders: [{ address: "vault", owner: "pool", pct: 60 },
      { address: "wallet", owner: "user", pct: 5 },
      { address: "burn", owner: "1nc1nerator11111111111111111111111111111111", pct: 10 }] };
  assert.deepEqual(holderConcentration(r), { verified: true, top10Percent: 5, largestPercent: 5 });
  r.markets[0].liquidityAAccount.mint = "wrong";
  assert.equal(holderConcentration(r).largestPercent, 60);
  r.topHolders[0].name = "exchange";
  assert.equal(holderConcentration(r).largestPercent, 60);
});
test("holders are sorted after exclusion, summed by owner, and missing percentages fail closed", () => {
  const r = { topHolders: [{ address: "a", owner: "whale", pct: 5 },
    ...Array.from({ length: 10 }, (_, i) => ({ address: "small-" + i, pct: 1 })),
    { address: "b", owner: "whale", pct: 5 }] };
  assert.equal(holderConcentration(r).largestPercent, 10);
  assert.equal(holderConcentration(r).top10Percent, 19);
  r.topHolders[0].pct = null;
  assert.equal(holderConcentration(r).verified, false);
});
test("a token-wide or different-market burn never proves the selected pool burned", () => {
  assert.equal(isLiquidityBurned({ lpBurned: true }, { lp: {} }), false);
  assert.equal(isLiquidityBurned({}, { lp: { lpBurned: true } }), true);
});
test("historical failures back off and do not consume the next candidate's request budget", async () => {
  const gecko = require("../geckoTerminal");
  const original = gecko.getPoolCandles; let calls = 0, now = 100000;
  gecko.getPoolCandles = async () => { calls++; throw new Error("timeout"); };
  try {
    const client = createSniperDataClient({ clock: () => now });
    const a = { pairAddress: "pool-A", tokenAddress: "mint-A" };
    assert.equal(client.canFetchHistorical(a), true);
    assert.deepEqual(await client.getHistoricalCandles(a), []);
    assert.equal(client.canFetchHistorical(a), false);
    assert.deepEqual(await client.getHistoricalCandles(a), []); assert.equal(calls, 1);
    assert.equal(client.canFetchHistorical({ ...a, pairAddress: "pool-B" }), true);
    now += 60001; assert.equal(client.canFetchHistorical(a), true);
  } finally { gecko.getPoolCandles = original; }
});
