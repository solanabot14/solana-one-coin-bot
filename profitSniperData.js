const axios = require("axios");
const { setTimeout: sleep } = require("node:timers/promises");

// Sniper-only client. Never turn an API error into a security approval.
function createSniperDataClient({ httpGet = (...args) => axios.get(...args), clock = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  const reports = new Map(), pending = new Map(), failures = new Map();
  let reportCooldownUntil = 0, historyCooldownUntil = 0;
  const history = new Map();
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
    if (now < reportCooldownUntil) throw new Error("SECURITY_DATA_PENDING: provider rate limit");
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        aborted(signal);
        const startedAt = clock();
        try {
          const response = await httpGet("https://api.rugcheck.xyz/v1/tokens/" +
            encodeURIComponent(address) + "/report", { timeout: 8000, signal,
            headers: { "Cache-Control": "no-cache" } });
          aborted(signal);
          const age = Number(response.headers?.age || 0) * 1000;
          if (!Number.isFinite(age) || age < 0 || age > 15000 || clock() - startedAt > 15000)
            throw new Error("STALE_SECURITY_RESPONSE");
          if (!response.data || response.data.mint !== address || !Array.isArray(response.data.markets))
            throw new Error("INVALID_SECURITY_REPORT");
          const holders = response.data.topHolders ?? response.data.tokenHolders ?? response.data.holders;
          if (!Array.isArray(holders) || !holders.length || !response.data.markets.length)
            throw new Error("INCOMPLETE_SECURITY_REPORT");
          const value = { data: response.data, sampledAt: startedAt - age };
          if (clock() - value.sampledAt < 10000)
            reports.set(address, { until: value.sampledAt + 10000, value: structuredClone(value) });
          return value;
        } catch (error) {
          aborted(signal);
          const status = error.response?.status;
          const transient = error.message === "INCOMPLETE_SECURITY_REPORT" || status === 429 || status >= 500 ||
            ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(error.code);
          const retryAfter = Number(error.response?.headers?.["retry-after"]);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
          if (transient && attempt === 0 && delay <= 2000) { await wait(delay, signal); continue; }
          const reason = "SECURITY_DATA_PENDING: " + (status ? "HTTP " + status : error.message);
          const until = clock() + Math.max(30000, status === 429 ? Math.min(delay, 300000) : 0);
          failures.set(address, { until, reason });
          if (status === 429) reportCooldownUntil = until;
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

module.exports = { createSniperDataClient, sniperData: createSniperDataClient() };
