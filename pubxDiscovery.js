const axios = require("axios");
const { getTokensData } = require("./dexscreener");

const DISCOVERY_SOURCES = [
  { name: "Latest Profiles", url: "https://api.dexscreener.com/token-profiles/latest/v1" },
  { name: "Community Takeovers", url: "https://api.dexscreener.com/community-takeovers/latest/v1" },
  { name: "Latest Boosts", url: "https://api.dexscreener.com/token-boosts/latest/v1" },
  { name: "Top Boosts", url: "https://api.dexscreener.com/token-boosts/top/v1" }
];
const MIN_LIQUIDITY_USD = 20000;
const CACHE_MS = 10000;

function createPubxDiscovery({
  httpGet = axios.get,
  getTokenDataBatch = getTokensData,
  clock = Date.now,
  cacheMs = CACHE_MS
} = {}) {
  let cached = null;
  let inFlight = null;

  async function fetchSource(source, signal) {
    try {
      const response = await httpGet(source.url, { timeout: 10000, signal });
      return Array.isArray(response?.data) ? response.data : [];
    } catch (error) {
      if (!signal?.aborted) console.warn(`PUBX ${source.name} unavailable: ${error.message}`);
      return [];
    }
  }

  async function discoverCandidatesFresh({ signal } = {}) {
    const sources = await Promise.all(DISCOVERY_SOURCES.map(source => fetchSource(source, signal)));
    if (signal?.aborted) return [];
    const addresses = [...new Set(sources.flat()
      .filter(token => token?.chainId === "solana" && token?.tokenAddress)
      .map(token => token.tokenAddress))];
    if (!addresses.length) return [];

    const dataByAddress = await getTokenDataBatch(addresses, { signal });
    const candidates = [];
    for (const tokenAddress of addresses) {
      if (signal?.aborted) return [];
      const data = dataByAddress.get(tokenAddress);
      if (!data || (Number(data.liquidityUsd) || 0) < MIN_LIQUIDITY_USD) continue;
      candidates.push({
        tokenAddress,
        ...data,
        signal: "MOMENTUM CANDIDATE",
        score: 0,
        reasons: ["PUBX discovery: 24h volume is recorded for context, with no $100k minimum."]
      });
    }
    return candidates;
  }

  function discoverCandidates(options = {}) {
    if (inFlight) return inFlight.then(items => structuredClone(items));
    if (cached && clock() - cached.at < cacheMs) return Promise.resolve(structuredClone(cached.items));
    inFlight = discoverCandidatesFresh(options)
      .then(items => {
        cached = { at: clock(), items: structuredClone(items) };
        return items;
      })
      .finally(() => { inFlight = null; });
    return inFlight.then(items => structuredClone(items));
  }

  return { discoverCandidates, discoverCandidatesFresh };
}

const client = createPubxDiscovery();
module.exports = {
  DISCOVERY_SOURCES, MIN_LIQUIDITY_USD, CACHE_MS, createPubxDiscovery,
  discoverCandidates: client.discoverCandidates
};
