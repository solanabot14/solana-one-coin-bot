const { setTimeout: sleep } = require("node:timers/promises");
const { constants, getMomentumFailureReasons, getBuySizing } = require("./profitSniperStrategy");
const CONFIG = require("./profitSniperConfig");
const { evaluatePoolReport, isLiquidityBurned, holderConcentration, holderPolicy } = require("./profitSniperEntryGuard");
const CONFIRMATION_MS = 7500;
const MAX_SAMPLE_AGE_MS = CONFIG.MAX_EXECUTION_QUOTE_AGE_MS;
const MAX_MARKET_DATA_AGE_MS = CONFIG.MAX_MARKET_DATA_AGE_MS;
const MAX_LIQUIDITY_DROP = 0.20;
const MIN_LOCK_PERCENT = CONFIG.MIN_LP_LOCK_PERCENT;

function number(value) {
  return value === null || value === undefined || value === "" ? NaN : Number(value);
}

function poolLock(report, coin, now = Date.now()) {
  if (!report || report.mint !== coin.tokenAddress) return { allowed: false, reason: "REPORT_MINT_MISMATCH" };
  const markets = (report.markets || []).filter(m => m.pubkey === coin.pairAddress &&
    [m.mintA, m.mintB].includes(coin.tokenAddress));
  if (markets.length !== 1) return { allowed: false, reason: "EXACT_POOL_LOCK_UNAVAILABLE" };
  const lp = markets[0].lp;
  const lockedPercent = number(lp?.lpLockedPct);
  const baseUsd = number(lp?.baseUSD), quoteUsd = number(lp?.quoteUSD);
  const liquidityUsd = baseUsd + quoteUsd;
  if (!(baseUsd > 0) || !(quoteUsd > 0) || !Number.isFinite(liquidityUsd) ||
      liquidityUsd < CONFIG.MIN_LIQUIDITY_USD)
    return { allowed: false, lockedPercent, reason: "EXACT_POOL_RESERVES_TOO_LOW" };
  const safetyFailure = evaluatePoolReport(report, coin, Number(coin.liquidityUsd) || liquidityUsd, now);
  if (safetyFailure) return { allowed: false, lockedPercent, liquidityUsd, reason: safetyFailure };
  const burned = isLiquidityBurned(report, markets[0]);
  if (!burned && (!Number.isFinite(lockedPercent) || lockedPercent < MIN_LOCK_PERCENT || lockedPercent > 100))
    return { allowed: false, lockedPercent: null, reason: "EXACT_POOL_LOCK_NOT_CONFIRMED" };
  return { allowed: true, lockedPercent: burned ? 100 : lockedPercent, liquidityUsd, pairAddress: coin.pairAddress,
    reason: burned ? "EXACT_POOL_LP_BURN_CONFIRMED" : "EXACT_POOL_LOCK_AND_RESERVES_CONFIRMED" };
}

function createEntryGuard({
  httpGet,
  verifyExecution = require("./profitSniperExecutionQuote").createExecutionVerifier(),
  clock = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal })
} = {}) {
  const reportClient = httpGet
    ? require("./profitSniperData").createSniperDataClient({ httpGet, clock, wait })
    : require("./profitSniperData").sniperData;
  const get = httpGet || ((...args) => require("axios").get(...args));
  let lastCheck = null;
  const counters = { passed: 0, rejected: 0 };
  const reject = (coin, reason, details = {}) => {
    counters.rejected++;
    lastCheck = { symbol: coin.symbol, tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress,
      allowed: false, reason, ...details, checkedAt: new Date(clock()).toISOString() };
    console.log("PROFIT SNIPER PREBUY REJECT | " + JSON.stringify(lastCheck));
    return { allowed: false, reason, ...details };
  };
  async function request(url, signal) {
    if (signal?.aborted) throw new Error("ABORTED");
    const startedAt = clock();
    const response = await get(url, { timeout: MAX_SAMPLE_AGE_MS, signal,
      headers: { "Cache-Control": "no-cache" } });
    if (signal?.aborted) throw new Error("ABORTED");
    const ageSeconds = Number(response.headers?.age || 0);
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0 ||
        ageSeconds * 1000 + clock()-startedAt > MAX_MARKET_DATA_AGE_MS ||
        clock() - startedAt > MAX_SAMPLE_AGE_MS) throw new Error("STALE_RESPONSE: cacheAgeSeconds=" + ageSeconds + "; requestMs=" + (clock()-startedAt));
    return { data: response.data, sampledAt: startedAt-ageSeconds*1000,
      receivedAt:clock(),cacheAgeSeconds:ageSeconds,
      ageBasis:"HTTP cache age; underlying indexer delay unavailable" };
  }
  async function readLock(coin, signal) {
    const response = await reportClient.getReport(coin.tokenAddress, signal);
    return { ...poolLock(response.data, coin, clock()), sampledAt: response.sampledAt,
      holderSecurity: { ...holderConcentration(response.data), ...holderPolicy(coin, clock()) },
      report: response.data };
  }
  async function checkLiquidityLock(tokenAddress, { coin, signal } = {}) {
    if (!coin || coin.tokenAddress !== tokenAddress) return { allowed: false, reason: "MISSING_POOL_IDENTITY" };
    try {
      const lock = await readLock(coin, signal);
      if (!lock.allowed) reject(coin, lock.reason, { holderSecurity: lock.holderSecurity });
      return lock;
    } catch (error) {
      reject(coin, error.message);
      return { allowed: false, lockedPercent: null, reason: error.message };
    }
  }
  async function quote(coin, signal) {
    let response;
    try {
      response = await request("https://api.dexscreener.com/latest/dex/pairs/solana/" +
        encodeURIComponent(coin.pairAddress), signal);
    } catch (error) {
      if (!error.message.startsWith("STALE_RESPONSE:")) throw error;
      // The independent official token endpoint can have a fresher cache.
      // Both responses must satisfy the same freshness and exact-pool checks.
      response = await request("https://api.dexscreener.com/tokens/v1/solana/" +
        encodeURIComponent(coin.tokenAddress), signal);
    }
    const pairs = (Array.isArray(response.data) ? response.data : response.data?.pairs || []).filter(p => p.chainId === "solana" &&
      p.pairAddress === coin.pairAddress && p.baseToken?.address === coin.tokenAddress);
    if (pairs.length !== 1) throw new Error("EXACT_POOL_QUOTE_UNAVAILABLE");
    const p = pairs[0];
    const q = { tokenAddress: p.baseToken.address, pairAddress: p.pairAddress, chainId: p.chainId,
      priceUsd: number(p.priceUsd), liquidityUsd: number(p.liquidity?.usd),
      pairCreatedAt: number(p.pairCreatedAt), volume24h: number(p.volume?.h24),
      volume5m: number(p.volume?.m5), buys5m: number(p.txns?.m5?.buys),
      sells5m: number(p.txns?.m5?.sells), priceChange5m: number(p.priceChange?.m5),
      priceChange1h: number(p.priceChange?.h1), priceChange24h: number(p.priceChange?.h24),
      momentumPattern: coin.momentumPattern,
      sampledAt: response.sampledAt, receivedAt:response.receivedAt,
      cacheAgeSeconds:response.cacheAgeSeconds,ageBasis:response.ageBasis };
    if (!(q.priceUsd > 0) || !Number.isFinite(q.priceUsd)) throw new Error("INVALID_PRICE");
    const failures = getMomentumFailureReasons(q, clock());
    if (failures.length) throw new Error("FRESH_QUOTE_FAILED: " + failures.join(","));
    return q;
  }
  async function prepareEntry(coin, { signal, portfolio } = {}) {
    try {
      const first = await quote(coin, signal);
      // Wait only in the scanner: the separate position monitor keeps running.
      await wait(CONFIRMATION_MS, signal);
      const lock = await readLock({ ...coin, ...first }, signal);
      if (!lock.allowed) return reject(coin, lock.reason, { holderSecurity: lock.holderSecurity });
      const amountUsd = getBuySizing(portfolio || {cashBalance:100,positions:[],history:[]}).amountInvested;
      const final = await quote(coin, signal);
      const finalSecurityFailure = evaluatePoolReport(lock.report, final, final.liquidityUsd, clock());
      if (finalSecurityFailure) return reject(coin, finalSecurityFailure,
        { holderSecurity: { ...holderConcentration(lock.report), ...holderPolicy(final, clock()) } });
      // Cached market statistics are a screening source. The final network
      // operations are fresh executable buy/sell quotes at the actual size.
      const execution = await verifyExecution(coin, {amountUsd,signal});
      if (!execution.allowed) return reject(coin, execution.reason, {executionQuote:execution});
      if (signal?.aborted) return reject(coin, "ABORTED");
      if (clock() - lock.sampledAt > MAX_SAMPLE_AGE_MS || clock() - final.sampledAt > MAX_MARKET_DATA_AGE_MS)
        return reject(coin, "STALE_FINAL_CHECK");
      if (final.receivedAt - first.receivedAt < CONFIRMATION_MS)
        return reject(coin, "CONFIRMATION_TOO_SHORT");
      if (final.priceUsd < first.priceUsd) return reject(coin, "PRICE_FALLING_BEFORE_PURCHASE");
      if (final.liquidityUsd < first.liquidityUsd * (1 - MAX_LIQUIDITY_DROP))
        return reject(coin, "LIQUIDITY_DROPPED_OVER_20_PERCENT");
      const discrepancy = Math.abs(final.liquidityUsd - lock.liquidityUsd) /
        Math.max(final.liquidityUsd, lock.liquidityUsd);
      if (discrepancy > MAX_LIQUIDITY_DROP) return reject(coin, "POOL_LIQUIDITY_SOURCES_DISAGREE");
      counters.passed++;
      lastCheck = { symbol: coin.symbol, tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress,
        allowed: true, reason: "VERIFIED", firstLiquidityUsd: first.liquidityUsd,
        finalLiquidityUsd: final.liquidityUsd, reportLiquidityUsd: lock.liquidityUsd,
        lockedPercent: lock.lockedPercent, executionQuote:execution,
        holderSecurity: { ...holderConcentration(lock.report), ...holderPolicy(final, clock()) },
        marketDataAgeMs:clock()-final.sampledAt,marketCacheAgeSeconds:final.cacheAgeSeconds,
        marketAgeBasis:final.ageBasis,
        marketCacheAdvanced:final.sampledAt>first.sampledAt,
        checkedAt: new Date(clock()).toISOString() };
      return { allowed: true, coin: { ...coin, ...final, reasons: [...(coin.reasons || []),
        "Exact pool lock " + lock.lockedPercent + "%; reserves $" + lock.liquidityUsd.toFixed(2),
        "Holder policy " + lastCheck.holderSecurity.policy + ": top 10 " +
          lastCheck.holderSecurity.top10Percent.toFixed(2) + "% / cap " +
          lastCheck.holderSecurity.top10LimitPercent + "%; largest " +
          lastCheck.holderSecurity.largestPercent.toFixed(2) + "% / cap " +
          lastCheck.holderSecurity.singleHolderLimitPercent + "%",
        "Buy/sell route quoted for $" + amountUsd.toFixed(2) + "; estimated round-trip cost " + execution.lossPercent.toFixed(2) + "%",
        "Fresh pre-buy checks with 7.5s confirmation wait: liquidity $" + first.liquidityUsd.toFixed(2) +
          " -> $" + final.liquidityUsd.toFixed(2) + "; compounded paper sizing"] } };
    } catch (error) { return reject(coin, error.message || "ENTRY_DATA_UNAVAILABLE"); }
  }
  return { checkLiquidityLock, prepareEntry, getStatus: () => ({
    confirmationMs: CONFIRMATION_MS, maximumSampleAgeMs: MAX_SAMPLE_AGE_MS,
    maximumMarketDataAgeMs:MAX_MARKET_DATA_AGE_MS,
    maximumQuotedRoundTripCostPercent:CONFIG.MAX_QUOTED_ROUND_TRIP_COST_PERCENT,
    maximumLiquidityDropPercent: MAX_LIQUIDITY_DROP * 100,
    exactPoolLockRequired: true, minimumLiquidityUsd: constants.MIN_LIQUIDITY_USD,
    executionQuotesRequired: true, maximumRoundTripLossPercent: CONFIG.MAX_ROUND_TRIP_LOSS_PERCENT,
    counters: { ...counters }, lastCheck
  }) };
}

module.exports = { createEntryGuard, poolLock, CONFIRMATION_MS };

