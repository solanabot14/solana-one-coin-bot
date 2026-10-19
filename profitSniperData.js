const axios = require("axios");
const { setTimeout: sleep } = require("node:timers/promises");

// Sniper-only client. Never turn an API error into a security approval.
function createSniperDataClient({ httpGet = (...args) => axios.get(...args), clock = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  provider = process.env.SNIPER_SECURITY_PROVIDER || "goplus",
  rugCheckBaseUrl = process.env.RUGCHECK_API_BASE_URL || "https://api.rugcheck.xyz",
  goPlusBaseUrl = process.env.GOPLUS_API_BASE_URL || "https://api.gopluslabs.io/api/v1/solana/token_security",
  birdEyeBaseUrl = process.env.BIRDEYE_API_BASE_URL || "https://public-api.birdeye.so" } = {}) {
  const reports = new Map(), pending = new Map(), failures = new Map();
  let reportCooldownUntil = 0, historyCooldownUntil = 0, dnsCooldownUntil = 0;
  const history = new Map();
  const selectedProvider = String(provider).toLowerCase();
  const providerName = selectedProvider === "goplus" ? "GoPlus" : selectedProvider === "rugcheck" ? "RugCheck" : null;
  const goPlusOrigin = goPlusBaseUrl.replace(/\/+$/, "");
  if (!providerName) throw new Error("Unsupported Sniper security provider");
  const aborted = signal => { if (signal?.aborted) throw new Error("ABORTED"); };
  function prune(map, now) {
    for (const [key, item] of map) if (now >= item.until) map.delete(key);
    while (map.size > 200) map.delete(map.keys().next().value);
  }
  async function getReport(address, signal, context = {}) {
    aborted(signal);
    const now = clock();
    prune(reports, now); prune(failures, now);
    const cacheKey = address + (context.pairAddress ? ":" + context.pairAddress : "");
    if (reports.has(cacheKey)) return structuredClone(reports.get(cacheKey).value);
    if (pending.has(cacheKey)) {
      const value = await pending.get(cacheKey); aborted(signal); return structuredClone(value);
    }
    if (failures.has(cacheKey)) throw new Error(failures.get(cacheKey).reason);
    if (now < dnsCooldownUntil) throw new Error("SECURITY_DATA_PENDING: " + providerName + " DNS unavailable");
    if (now < reportCooldownUntil) throw new Error("SECURITY_DATA_PENDING: provider rate limit");
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        aborted(signal);
        const startedAt = clock();
        try {
          const url = selectedProvider === "goplus"
            ? goPlusOrigin + "?contract_addresses=" + encodeURIComponent(address)
            : rugCheckBaseUrl.replace(/\/+$/, "") +
              "/v1/tokens/" + encodeURIComponent(address) + "/report";
          const response = await httpGet(url, { timeout: 8000, signal,
            headers: { "Cache-Control": "no-cache", ...(process.env.GOPLUS_API_KEY ?
              { Authorization: "Bearer " + process.env.GOPLUS_API_KEY } : {}) } });
          aborted(signal);
          const age = Number(response.headers?.age || 0) * 1000;
          let data;
          if (selectedProvider === "goplus") {
            try {
              data = normalizeGoPlusReport(response.data, address);
              if (!data.topHolders.length || !data.markets.length) throw new Error("INCOMPLETE_SECURITY_REPORT");
            }
            catch (error) {
              if (error.message !== "INCOMPLETE_SECURITY_REPORT" || !process.env.BIRDEYE_API_KEY) throw error;
              try { data = await fetchBirdeyeFallback({ httpGet, address, signal, birdEyeBaseUrl, context, clock }); }
              catch (fallbackError) { fallbackError.securityProvider = "birdeye"; throw fallbackError; }
            }
          } else data = response.data;
          if ((data.provider !== "birdeye" && (!Number.isFinite(age) || age < 0 || age > 15000 ||
              clock() - startedAt > 15000))) throw new Error("STALE_SECURITY_RESPONSE");
          if (!data || data.mint !== address || !Array.isArray(data.markets))
            throw new Error("INVALID_SECURITY_REPORT");
          const holders = data.topHolders ?? data.tokenHolders ?? data.holders;
          if (!Array.isArray(holders) || !holders.length || !data.markets.length)
            throw new Error("INCOMPLETE_SECURITY_REPORT");
          const value = { data, sampledAt: data.provider === "birdeye" ? data.sampledAt : startedAt - age };
          if (clock() - value.sampledAt < 10000)
            reports.set(cacheKey, { until: value.sampledAt + 10000, value: structuredClone(value) });
          return value;
        } catch (error) {
          aborted(signal);
          const status = error.response?.status;
          const providerError = !!status || ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"]
            .includes(error.code) || error.message === "STALE_SECURITY_RESPONSE" || error.message === "INVALID_GOPLUS_RESPONSE";
          if (selectedProvider === "goplus" && process.env.BIRDEYE_API_KEY &&
              error.securityProvider !== "birdeye" && providerError) {
            try {
              const data = await fetchBirdeyeFallback({ httpGet, address, signal, birdEyeBaseUrl, context, clock });
              const value = { data, sampledAt: data.sampledAt };
              if (clock() - value.sampledAt < 10000)
                reports.set(cacheKey, { until: value.sampledAt + 10000, value: structuredClone(value) });
              console.warn("PROFIT SNIPER SECURITY FALLBACK | " + address + " | GoPlus unavailable; Birdeye verified security data");
              return value;
            } catch (fallbackError) {
              fallbackError.securityProvider = "birdeye";
              error = fallbackError;
            }
          }
          const finalStatus = error.response?.status;
          const dnsFailure = ["ENOTFOUND", "EAI_AGAIN"].includes(error.code);
          const transient = error.message === "INCOMPLETE_SECURITY_REPORT" || finalStatus === 429 || finalStatus >= 500 ||
            ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(error.code);
          const retryAfter = Number(error.response?.headers?.["retry-after"]);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
          if (transient && attempt === 0 && delay <= 2000) { await wait(delay, signal); continue; }
          const reason = "SECURITY_DATA_PENDING: " + (finalStatus ? "HTTP " + finalStatus :
            dnsFailure ? providerName + " DNS unavailable (" + error.code + ")" : error.message);
          const until = clock() + Math.max(30000, finalStatus === 429 ? Math.min(delay, 300000) : 0);
          failures.set(cacheKey, { until, reason });
          if (finalStatus === 429) reportCooldownUntil = until;
          // Avoid making one doomed request per newly discovered mint during a provider DNS outage.
          // This expires quickly so the bot automatically recovers as soon as DNS does.
          if (dnsFailure) dnsCooldownUntil = clock() + 30000;
          console.warn("PROFIT SNIPER SECURITY DATA PENDING | " + address + " | " + reason);
          throw new Error(reason);
        }
      }
    })();
    pending.set(cacheKey, task);
    try { return structuredClone(await task); } finally { pending.delete(cacheKey); }
  }
  async function getHistoricalCandles(coin, { signal, limit } = {}) {
    aborted(signal);
    const now = clock(), key = coin.pairAddress + ":" + coin.tokenAddress;
    prune(history, now);
    const cached = history.get(key);
    if (cached) return structuredClone(cached.candles);
    if (now < historyCooldownUntil) return [];
    try {
      const candles = await require("./geckoTerminal").getPoolCandles(coin.pairAddress,
        coin.tokenAddress, { signal, limit });
      history.set(key, { until: clock() + 60000, candles });
      return structuredClone(candles);
    } catch (error) {
      aborted(signal);
      history.set(key, { until: clock() + 60000, candles: [] });
      if (error.response?.status === 429) {
        const retrySeconds = Number(error.response?.headers?.["retry-after"]);
        historyCooldownUntil = clock() + Math.max(60000, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0);
      }
      console.warn("PROFIT SNIPER HISTORICAL PATTERN PENDING | " + coin.pairAddress + " | " + error.message);
      return [];
    }
  }
  function canFetchHistorical(coin) {
    const now = clock(); prune(history, now);
    return now >= historyCooldownUntil && !history.has(coin.pairAddress + ":" + coin.tokenAddress);
  }
  return { getReport, getHistoricalCandles, canFetchHistorical };
}

async function fetchBirdeyeFallback({ httpGet, address, signal, birdEyeBaseUrl, context, clock }) {
  const origin = birdEyeBaseUrl.replace(/\/+$/, "");
  const headers = { "Cache-Control": "no-cache", "x-chain": "solana",
    "X-API-KEY": process.env.BIRDEYE_API_KEY };
  const request = (path, query) => httpGet(origin + path + "?" + query,
    { timeout: 8000, signal, headers });
  const startedAt = clock();
  const [securityResponse, holderResponse, marketsResponse] = await Promise.all([
    request("/defi/token_security", "address=" + encodeURIComponent(address)),
    request("/defi/v3/token/holder", "address=" + encodeURIComponent(address) + "&offset=0&limit=10"),
    request("/defi/v2/markets", "address=" + encodeURIComponent(address) + "&sort_by=liquidity&sort_type=desc&limit=20")
  ]);
  if (signal?.aborted) throw new Error("ABORTED");
  const security = securityResponse.data?.data;
  const holders = holderResponse.data?.data?.items;
  const pool = marketsResponse.data?.data?.items?.find(item => item?.address === context.pairAddress);
  const poolLiquidity = positiveNumberOrNull(pool?.liquidity);
  const ages = [securityResponse, holderResponse, marketsResponse]
    .map(response => Number(response.headers?.age || 0) * 1000);
  const maxAge = Math.max(...ages);
  if (!Number.isFinite(maxAge) || maxAge < 0 || maxAge > 15000 || clock() - startedAt > 15000)
    throw new Error("STALE_BIRDEYE_SECURITY_RESPONSE");
  if (securityResponse.data?.success !== true || holderResponse.data?.success !== true ||
      marketsResponse.data?.success !== true || !security ||
      !Array.isArray(holders) || !holders.length || !pool || poolLiquidity === null)
    throw new Error("INCOMPLETE_BIRDEYE_SECURITY_REPORT");
  const topHolders = holders.map(holder => {
    const raw = holder?.percentage;
    const fraction = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    return { address: holder?.address, owner: holder?.owner,
      pct: Number.isFinite(fraction) && fraction >= 0 && fraction <= 100
        ? (fraction <= 1 ? fraction * 100 : fraction) : NaN };
  });
  const authority = value => value === null || value === "" || value === false ? null
    : value === undefined ? "unverified" : value;
  const freezeAuthority = security.freezeable === false || security.freezeable === "false" ? null
    : security.freezeable === true || security.freezeable === "true"
      ? authority(security.freezeAuthority || "unverified") : authority(security.freezeAuthority);
  return { mint: address, provider: "birdeye", rugged: false,
    token: { mintAuthority: authority(security.ownerAddress),
      freezeAuthority },
    topHolders,
    markets: [{ pubkey: pool.address, provider: "birdeye", mintA: address, mintB: null,
      lp: { providerTvlUSD: poolLiquidity, lpLockedPct: null,
        lpLockedUSD: null, lpBurnedPct: null, lpBurned: false } }],
    securitySummary: { top10HolderPercent: maxValidPercent(
        numberOrNull(security.top10HolderPercent), numberOrNull(security.top10UserPercent)),
      creatorPercentage: numberOrNull(security.creatorPercentage),
      transferFeeEnable: security.transferFeeEnable, isToken2022: security.isToken2022,
      mutableMetadata: security.mutableMetadata },
    lockDataUnavailable: true, sampledAt: startedAt - maxAge };
}

function numberOrNull(value) {
  const number = value === null || value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function positiveNumberOrNull(value) {
  const number = value === null || value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function maxValidPercent(...values) {
  const valid = values.filter(value => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

function normalizeGoPlusReport(envelope, mint) {
  if (!envelope || envelope.code !== 1 || !envelope.result || typeof envelope.result !== "object")
    throw new Error("INVALID_GOPLUS_RESPONSE");
  const raw = envelope.result[mint];
  if (!raw)
    throw new Error("INCOMPLETE_SECURITY_REPORT");
  const authority = status => status?.status === "0" ? null :
    Array.isArray(status?.authority) && status.authority.length ? status.authority[0] : "unverified";
  let uniquelyAttributedLockedPct = null;
  // GoPlus returns lp_holders without a pool id. Attribute those holders only
  // when the response contains one DEX pool, so this lower bound cannot be
  // borrowed from a different pool of the same mint.
  if (Array.isArray(raw.dex) && raw.dex.length === 1 && Array.isArray(raw.lp_holders)) {
    const seen = new Set();
    let sum = 0, verifiedLockedHolder = false;
    for (const holder of raw.lp_holders) {
      const locked = holder?.is_locked === 1 || holder?.is_locked === "1";
      if (!locked) continue;
      const identity = holder?.token_account || holder?.account;
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      const fraction = holder?.percent === null || holder?.percent === undefined || holder?.percent === ""
        ? NaN : Number(holder.percent);
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      verifiedLockedHolder = true;
      sum += fraction * 100;
    }
    if (verifiedLockedHolder) uniquelyAttributedLockedPct = Math.min(100, sum);
  }
  const markets = (Array.isArray(raw.dex) ? raw.dex : []).map(dex => {
    const burnedPercent = dex?.burn_percent === null || dex?.burn_percent === undefined || dex?.burn_percent === ""
      ? NaN : Number(dex.burn_percent);
    const tvl = dex?.tvl === null || dex?.tvl === undefined || dex?.tvl === "" ? NaN : Number(dex.tvl);
    const usableBurn = Number.isFinite(burnedPercent) && burnedPercent >= 0 && burnedPercent <= 100
      ? burnedPercent : null;
    const securedPercent = usableBurn === null ? uniquelyAttributedLockedPct
      : uniquelyAttributedLockedPct === null ? usableBurn : Math.max(usableBurn, uniquelyAttributedLockedPct);
    // LP that GoPlus reports burned is permanently inaccessible. Count that
    // exact-pool share toward the existing 30% secured-liquidity floor.
    return { pubkey: dex?.id, provider: "goplus", mintA: mint, mintB: null,
      lp: { providerTvlUSD: tvl,
        lpLockedPct: securedPercent,
        lpLockedUSD: Number.isFinite(tvl) && securedPercent !== null ? tvl * securedPercent / 100 : null,
        lpBurnedPct: usableBurn,
        lpBurned: Number.isFinite(burnedPercent) && burnedPercent >= 99.99 } };
  });
  const topHolders = (Array.isArray(raw.holders) ? raw.holders : []).map(holder => {
    const fraction = holder?.percent === null || holder?.percent === undefined || holder?.percent === ""
      ? NaN : Number(holder.percent);
    return { address: holder?.token_account, owner: holder?.account,
      pct: Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : NaN };
  });
  return { mint, provider: "goplus", rugged: false,
    token: { mintAuthority: authority(raw.mintable), freezeAuthority: authority(raw.freezable) },
    topHolders, markets };
}

module.exports = { createSniperDataClient, normalizeGoPlusReport, fetchBirdeyeFallback,
  sniperData: createSniperDataClient() };
