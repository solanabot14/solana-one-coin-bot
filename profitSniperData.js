const axios = require("axios");
const { setTimeout: sleep } = require("node:timers/promises");

// Sniper-only client. Never turn an API error into a security approval.
function createSniperDataClient({ httpGet = (...args) => axios.get(...args), clock = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  provider = process.env.SNIPER_SECURITY_PROVIDER || "goplus",
  rugCheckBaseUrl = process.env.RUGCHECK_API_BASE_URL || "https://api.rugcheck.xyz",
  goPlusBaseUrl = process.env.GOPLUS_API_BASE_URL || "https://api.gopluslabs.io/api/v1/solana/token_security" } = {}) {
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
  async function getReport(address, signal) {
    aborted(signal);
    const now = clock();
    prune(reports, now); prune(failures, now);
    if (reports.has(address)) return structuredClone(reports.get(address).value);
    if (pending.has(address)) {
      const value = await pending.get(address); aborted(signal); return structuredClone(value);
    }
    if (failures.has(address)) throw new Error(failures.get(address).reason);
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
          if (!Number.isFinite(age) || age < 0 || age > 15000 || clock() - startedAt > 15000)
            throw new Error("STALE_SECURITY_RESPONSE");
          const data = selectedProvider === "goplus" ? normalizeGoPlusReport(response.data, address) : response.data;
          if (!data || data.mint !== address || !Array.isArray(data.markets))
            throw new Error("INVALID_SECURITY_REPORT");
          const holders = data.topHolders ?? data.tokenHolders ?? data.holders;
          if (!Array.isArray(holders) || !holders.length || !data.markets.length)
            throw new Error("INCOMPLETE_SECURITY_REPORT");
          const value = { data, sampledAt: startedAt - age };
          if (clock() - value.sampledAt < 10000)
            reports.set(address, { until: value.sampledAt + 10000, value: structuredClone(value) });
          return value;
        } catch (error) {
          aborted(signal);
          const status = error.response?.status;
          const dnsFailure = ["ENOTFOUND", "EAI_AGAIN"].includes(error.code);
          const transient = error.message === "INCOMPLETE_SECURITY_REPORT" || status === 429 || status >= 500 ||
            ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(error.code);
          const retryAfter = Number(error.response?.headers?.["retry-after"]);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
          if (transient && attempt === 0 && delay <= 2000) { await wait(delay, signal); continue; }
          const reason = "SECURITY_DATA_PENDING: " + (status ? "HTTP " + status :
            dnsFailure ? providerName + " DNS unavailable (" + error.code + ")" : error.message);
          const until = clock() + Math.max(30000, status === 429 ? Math.min(delay, 300000) : 0);
          failures.set(address, { until, reason });
          if (status === 429) reportCooldownUntil = until;
          // Avoid making one doomed request per newly discovered mint during a provider DNS outage.
          // This expires quickly so the bot automatically recovers as soon as DNS does.
          if (dnsFailure) dnsCooldownUntil = clock() + 30000;
          console.warn("PROFIT SNIPER SECURITY DATA PENDING | " + address + " | " + reason);
          throw new Error(reason);
        }
      }
    })();
    pending.set(address, task);
    try { return structuredClone(await task); } finally { pending.delete(address); }
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

function normalizeGoPlusReport(envelope, mint) {
  if (!envelope || envelope.code !== 1 || !envelope.result || typeof envelope.result !== "object")
    throw new Error("INVALID_GOPLUS_RESPONSE");
  const raw = envelope.result[mint];
  if (!raw || !Array.isArray(raw.holders) || !raw.holders.length || !Array.isArray(raw.dex) || !raw.dex.length)
    throw new Error("INCOMPLETE_SECURITY_REPORT");
  const authority = status => status?.status === "0" ? null :
    Array.isArray(status?.authority) && status.authority.length ? status.authority[0] : "unverified";
  let uniquelyAttributedLockedPct = null;
  // GoPlus returns lp_holders without a pool id. Attribute those holders only
  // when the response contains one DEX pool, so this lower bound cannot be
  // borrowed from a different pool of the same mint.
  if (raw.dex.length === 1 && Array.isArray(raw.lp_holders)) {
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
  const markets = raw.dex.map(dex => {
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
  const topHolders = raw.holders.map(holder => {
    const fraction = holder?.percent === null || holder?.percent === undefined || holder?.percent === ""
      ? NaN : Number(holder.percent);
    return { address: holder?.token_account, owner: holder?.account,
      pct: Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : NaN };
  });
  return { mint, provider: "goplus", rugged: false,
    token: { mintAuthority: authority(raw.mintable), freezeAuthority: authority(raw.freezable) },
    topHolders, markets };
}

module.exports = { createSniperDataClient, normalizeGoPlusReport, sniperData: createSniperDataClient() };
