const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");
const { getTokenData } = require("./dexscreener");
const {
  tokenSecuritySnapshot,
  liquiditySecuritySnapshot,
  marketDataIntegritySnapshot
} = require("./scanner");
const { analyzeEarlyRunner } = require("./strategyR3");

const DISCOVERY_SOURCES = [
  { name: "Latest Profiles", url: "https://api.dexscreener.com/token-profiles/latest/v1" },
  { name: "Community Takeovers", url: "https://api.dexscreener.com/community-takeovers/latest/v1" },
  { name: "Latest Boosts", url: "https://api.dexscreener.com/token-boosts/latest/v1" },
  { name: "Top Boosts", url: "https://api.dexscreener.com/token-boosts/top/v1" }
];

const BIRDEYE_TRENDING_URL = "https://public-api.birdeye.so/defi/token_trending";
const BIRDEYE_TRENDING_LIMIT = 20;
const BIRDEYE_TRENDING_REFRESH_MS = Math.max(
  5 * 60 * 1000,
  (Number.parseInt(process.env.BIRDEYE_TRENDING_REFRESH_MINUTES || "5", 10) || 5) * 60 * 1000
);
let birdeyeTrendingCache = { updatedAt: 0, tokens: [], lastStatus: "NOT_FETCHED" };

const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2/networks/solana";
const GECKO_REFRESH_MS = Math.max(
  15 * 1000,
  (Number.parseInt(process.env.GECKO_REFRESH_SECONDS || "15", 10) || 15) * 1000
);
const geckoCaches = {
  trending: { updatedAt: 0, tokens: [], lastStatus: "NOT_FETCHED" },
  newPools: { updatedAt: 0, tokens: [], lastStatus: "NOT_FETCHED" }
};

// Fresh Discovery is intentionally separate from the 1-minute strategy scanner.
// Poll Gecko New Pools every 15s, retain addresses briefly, then let R3 evaluate
// them with the exact same entry/security rules as every other discovery source.
const FRESH_DISCOVERY_POLL_MS = 15 * 1000;
const FRESH_DISCOVERY_TTL_MS = 3 * 60 * 1000;
const freshDiscoveryQueue = new Map();

const WATCH_MIN_LIQUIDITY = 25000;
const MAX_ENTRY_PAIR_AGE_MS = 48 * 60 * 60 * 1000;
const knownPairCreatedAt = new Map();
const REACTIVATION_AGE_MS = 24 * 60 * 60 * 1000;
const REACTIVATION_DEAD_BASELINE_VOL5M = 500;
const REACTIVATION_LOOKBACK_OBSERVATIONS = 8;
const REACTIVATION_MIN_DEAD_OBSERVATIONS = 2;
const REACTIVATION_SPIKE_GROWTH_PCT = 500;
const REACTIVATION_CONFIRM_MAX_MS = 5 * 60 * 1000;
const REACTIVATION_MIN_RETAINED_VOLUME_RATIO = 0.50;
const HISTORY_TTL_MS = 45 * 60 * 1000;
const RESET_MIN_MS = 10 * 60 * 1000;
const REENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LOSING_EXITS_PER_TOKEN_24H = 2;
const FAILED_LAUNCH_RETRY_MIN_SCORE = 13;
const FAILED_LAUNCH_RETRY_MIN_VOLUME5M = 20000;
const FAILED_LAUNCH_RETRY_MIN_VOLUME_GROWTH_PCT = 75;
const FAILED_LAUNCH_RETRY_MIN_LIQUIDITY_GROWTH_PCT = 5;
const RESET_MIN_POST_COOL_OBS = 2;
const RESET_MIN_VOL5M_GROWTH_PCT = 25;
const RESET_MAX_LIQUIDITY_DRAWDOWN_PCT = 12;
const histories = new Map();
const exhausted = new Map();
const reactivationWatches = new Map();

function dataDirectory() {
  return path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname);
}

function reentryStateFile() {
  return path.join(dataDirectory(), "r3ReentryState.json");
}

function watchHistoryFile() {
  return path.join(dataDirectory(), "r3WatchHistory.json");
}

function saveExhaustedState() {
  const file = reentryStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = Object.fromEntries(exhausted.entries());
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function hydrateExhaustedState() {
  const file = reentryStateFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [tokenAddress, state] of Object.entries(parsed || {})) {
        if (tokenAddress && state?.at) exhausted.set(tokenAddress, state);
      }
    }

    // Seed missing token memory from both the R3 account and the preserved legacy account.
    // This does not permanently blacklist a token; resetEligible can release it after
    // cooling + fresh observations + a new live acceleration setup.
    const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
    for (const name of ["tradingDataR3.json", "tradingData.json"]) {
      const tradeFile = path.join(path.resolve(directory), name);
      if (!fs.existsSync(tradeFile)) continue;
      const data = JSON.parse(fs.readFileSync(tradeFile, "utf8"));
      for (const trade of Array.isArray(data?.history) ? data.history : []) {
        if (trade?.type !== "SELL" || Number(trade.percentSold) !== 100 || !trade.tokenAddress || !trade.exitTime) continue;
        const at = Date.parse(trade.exitTime);
        if (!Number.isFinite(at)) continue;
        const previous = exhausted.get(trade.tokenAddress);
        if (!previous || at > Number(previous.at || 0)) {
          exhausted.set(trade.tokenAddress, {
            at,
            reason: trade.reason || "PRIOR FULL EXIT",
            high: Number(trade.highestPrice) || null,
            source: name
          });
        }
      }
    }
    saveExhaustedState();
  } catch (error) {
    console.log(`R3 REENTRY STATE LOAD WARNING | ${error.message}`);
  }
}

hydrateExhaustedState();

function saveWatchHistory() {
  const now = Date.now();
  const payload = {};
  for (const [tokenAddress, observations] of histories.entries()) {
    const recent = (observations || []).filter(x => now - Number(x.at || 0) <= HISTORY_TTL_MS).slice(-8);
    if (recent.length) payload[tokenAddress] = recent;
  }
  const file = watchHistoryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function hydrateWatchHistory() {
  const file = watchHistoryFile();
  try {
    if (!fs.existsSync(file)) return;
    const now = Date.now();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [tokenAddress, observations] of Object.entries(parsed || {})) {
      const recent = Array.isArray(observations)
        ? observations.filter(x => now - Number(x?.at || 0) <= HISTORY_TTL_MS).slice(-8)
        : [];
      if (recent.length) histories.set(tokenAddress, recent);
    }
  } catch (error) {
    console.log(`R3 WATCH HISTORY LOAD WARNING | ${error.message}`);
  }
}

hydrateWatchHistory();

let lastDiscoveryTelemetry = {
  updatedAt: null,
  strategy: "R3-EARLY-RUNNER",
  uniqueSolanaCandidates: 0,
  candidatesAfterSafetyFilters: 0,
  strongBuys: 0,
  topCandidates: []
};

function snapshot(data) {
  return {
    at: Date.now(),
    priceUsd: Number(data.priceUsd) || 0,
    liquidityUsd: Number(data.liquidityUsd) || 0,
    volume5m: Number(data.volume5m) || 0,
    volume1h: Number(data.volume1h) || 0,
    volume24h: Number(data.volume24h) || 0,
    priceChange5m: Number(data.priceChange5m) || 0,
    priceChange1h: Number(data.priceChange1h) || 0,
    buys5m: Number(data.buys5m) || 0,
    sells5m: Number(data.sells5m) || 0
  };
}

function remember(tokenAddress, data) {
  const now = Date.now();
  const previous = histories.get(tokenAddress) || [];
  const next = previous.filter(x => now - x.at <= HISTORY_TTL_MS);
  next.push(snapshot(data));
  histories.set(tokenAddress, next.slice(-8));
  saveWatchHistory();
  return histories.get(tokenAddress);
}

function markExhausted(tokenAddress, context = {}) {
  exhausted.set(tokenAddress, {
    at: Date.now(),
    reason: context.reason || "EXIT",
    high: Number(context.highestPrice) || null,
    pnlPercent: Number.isFinite(Number(context.pnlPercent)) ? Number(context.pnlPercent) : null,
    source: context.source || "R3"
  });
  saveExhaustedState();
}

function recentTokenStats(tokenAddress) {
  const cutoff = Date.now() - REENTRY_LOOKBACK_MS;
  let entries = 0;
  let losingFullExits = 0;

  for (const name of ["tradingDataR3.json", "tradingData.json"]) {
    const file = path.join(dataDirectory(), name);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const history = Array.isArray(data?.history) ? data.history : [];
      const positions = new Map();

      for (const trade of history) {
        if (trade?.tokenAddress !== tokenAddress) continue;

        if (trade.type === "BUY") {
          const entryAt = Date.parse(trade.entryTime);
          if (Number.isFinite(entryAt) && entryAt >= cutoff) entries++;
        }

        const key = trade.positionId || (trade.entryTime ? tokenAddress + "::" + trade.entryTime : null);
        if (!key) continue;
        if (!positions.has(key)) {
          positions.set(key, {
            netPnl: 0,
            fullyClosed: false,
            closedAt: null
          });
        }

        if (trade.type === "SELL") {
          const position = positions.get(key);
          position.netPnl += Number(trade.pnl) || 0;
          const exitAt = Date.parse(trade.exitTime);
          if (Number(trade.percentSold) === 100 && Number.isFinite(exitAt)) {
            position.fullyClosed = true;
            position.closedAt = exitAt;
          }
        }
      }

      for (const position of positions.values()) {
        if (
          position.fullyClosed &&
          Number.isFinite(position.closedAt) &&
          position.closedAt >= cutoff &&
          position.netPnl < 0
        ) {
          losingFullExits++;
        }
      }
    } catch (error) {
      console.log(`R3 REENTRY STATS WARNING | ${name} | ${error.message}`);
    }
  }

  return { entries, losingFullExits };
}

function resetStructureEligible(state, history) {
  if (!state) return true;

  const now = Date.now();
  if (now - state.at < RESET_MIN_MS) return false;

  const postExit = history.filter(x => x.at > state.at);
  if (postExit.length < 3) return false;

  // A reset is not "cooled once". Find a real cooling observation first.
  let coolIndex = -1;
  for (let i = 0; i < postExit.length; i++) {
    if (Number(postExit[i].priceChange5m) <= 1.5) coolIndex = i;
  }
  if (coolIndex < 0) return false;

  const postCool = postExit.slice(coolIndex + 1);
  if (postCool.length < RESET_MIN_POST_COOL_OBS) return false;

  const first = postCool[0];
  const latest = postCool.at(-1);
  const firstVol = Number(first.volume5m) || 0;
  const latestVol = Number(latest.volume5m) || 0;
  const volGrowthPct = firstVol > 0 ? ((latestVol - firstVol) / firstVol) * 100 : null;

  const maxLiq = Math.max(...postCool.map(x => Number(x.liquidityUsd) || 0));
  const latestLiq = Number(latest.liquidityUsd) || 0;
  const liqDrawdownPct = maxLiq > 0 ? ((maxLiq - latestLiq) / maxLiq) * 100 : 0;

  const buys = Number(latest.buys5m) || 0;
  const sells = Number(latest.sells5m) || 0;
  const tx = buys + sells;
  const buyRatio = tx > 0 ? buys / tx : 0;

  return (
    volGrowthPct !== null &&
    volGrowthPct >= RESET_MIN_VOL5M_GROWTH_PCT &&
    latestVol >= 3000 &&
    Number(latest.priceChange5m) >= 0.25 &&
    Number(latest.priceChange5m) < 4 &&
    tx >= 20 &&
    buyRatio >= 0.52 &&
    buyRatio <= 0.80 &&
    liqDrawdownPct <= RESET_MAX_LIQUIDITY_DRAWDOWN_PCT
  );
}

function resetEligible(tokenAddress, history) {
  const state = exhausted.get(tokenAddress);
  if (!state) return true;

  const stats = recentTokenStats(tokenAddress);
  if (stats.losingFullExits >= MAX_LOSING_EXITS_PER_TOKEN_24H) {
    return false;
  }

  return resetStructureEligible(state, history);
}

function failedLaunchRetryEligible(tokenAddress, history, analysis, data, stats) {
  const state = exhausted.get(tokenAddress);
  if (!state || state.reason !== "FAILED LAUNCH") return false;

  if (stats.losingFullExits >= MAX_LOSING_EXITS_PER_TOKEN_24H) return false;
  if (!resetStructureEligible(state, history)) return false;

  const metrics = analysis?.metrics || {};
  return (
    Number(analysis?.score) >= FAILED_LAUNCH_RETRY_MIN_SCORE &&
    Number(data?.volume5m) >= FAILED_LAUNCH_RETRY_MIN_VOLUME5M &&
    Number(metrics.volume5mGrowthPct) >= FAILED_LAUNCH_RETRY_MIN_VOLUME_GROWTH_PCT &&
    Number(metrics.liquidityGrowthPct) >= FAILED_LAUNCH_RETRY_MIN_LIQUIDITY_GROWTH_PCT
  );
}

async function fetchSource(source, signal) {
  try {
    const response = await axios.get(source.url, { timeout: 10000, signal });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.log(`R3 DISCOVERY SOURCE UNAVAILABLE | ${source.name} | ${error.message}`);
    return [];
  }
}

function birdeyeTrendingItems(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tokens)) return data.tokens;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(payload?.tokens)) return payload.tokens;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function fetchBirdeyeTrendingTokens(signal) {
  const now = Date.now();
  const ageMs = now - birdeyeTrendingCache.updatedAt;

  if (birdeyeTrendingCache.updatedAt && ageMs < BIRDEYE_TRENDING_REFRESH_MS) {
    console.log(
      `R3 DISCOVERY | Birdeye Trending 1H | ${birdeyeTrendingCache.tokens.length} cached | age ${Math.round(ageMs / 60000)}m`
    );
    return structuredClone(birdeyeTrendingCache.tokens);
  }

  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    birdeyeTrendingCache = { updatedAt: now, tokens: [], lastStatus: "NO_API_KEY" };
    console.log("R3 DISCOVERY | Birdeye Trending 1H unavailable | no API key");
    return [];
  }

  try {
    const response = await axios.get(BIRDEYE_TRENDING_URL, {
      timeout: 10000,
      signal,
      params: {
        sort_by: "rank",
        sort_type: "asc",
        interval: "1h",
        offset: 0,
        limit: BIRDEYE_TRENDING_LIMIT
      },
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
        "x-chain": "solana"
      }
    });

    const seen = new Set();
    const tokens = [];
    for (const item of birdeyeTrendingItems(response.data)) {
      const tokenAddress =
        item?.address ||
        item?.tokenAddress ||
        item?.token_address ||
        item?.mint ||
        item?.baseToken?.address;
      if (!tokenAddress || seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);
      tokens.push({ chainId: "solana", tokenAddress, discoverySource: "Birdeye Trending 1H" });
      if (tokens.length >= BIRDEYE_TRENDING_LIMIT) break;
    }

    birdeyeTrendingCache = { updatedAt: now, tokens: structuredClone(tokens), lastStatus: "OK" };
    console.log(`R3 DISCOVERY | Birdeye Trending 1H | ${tokens.length} tokens received`);
    return tokens;
  } catch (error) {
    const status = error?.response?.status || "ERROR";
    // Keep the scanner fully functional if Birdeye is unavailable.
    birdeyeTrendingCache = { updatedAt: now, tokens: [], lastStatus: String(status) };
    console.log(`R3 DISCOVERY | Birdeye Trending 1H unavailable | ${error.message}`);
    return [];
  }
}


function geckoTokenAddressFromRelationship(relationship) {
  const rawId = relationship?.data?.id;
  if (!rawId || typeof rawId !== "string") return null;
  return rawId.startsWith("solana_") ? rawId.slice("solana_".length) : rawId;
}

function geckoPoolTokens(payload, discoverySource) {
  const seen = new Set();
  const tokens = [];
  for (const pool of Array.isArray(payload?.data) ? payload.data : []) {
    const tokenAddress = geckoTokenAddressFromRelationship(pool?.relationships?.base_token);
    if (!tokenAddress || seen.has(tokenAddress)) continue;
    seen.add(tokenAddress);
    const createdRaw = pool?.attributes?.pool_created_at;
    const parsedCreatedAt = createdRaw ? Date.parse(createdRaw) : NaN;
    tokens.push({
      chainId: "solana",
      tokenAddress,
      discoverySource,
      pairCreatedAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : null
    });
  }
  return tokens;
}

async function fetchGeckoPoolTokens(kind, signal) {
  const cache = geckoCaches[kind];
  const now = Date.now();
  const ageMs = now - cache.updatedAt;
  const endpoint = kind === "trending" ? "trending_pools" : "new_pools";
  const sourceName = kind === "trending" ? "Gecko Trending Pools" : "Gecko New Pools";

  if (cache.updatedAt && ageMs < GECKO_REFRESH_MS) {
    console.log(
      `R3 DISCOVERY | ${sourceName} | ${cache.tokens.length} cached | age ${Math.round(ageMs / 60000)}m`
    );
    return structuredClone(cache.tokens);
  }

  try {
    const response = await axios.get(`${GECKO_BASE_URL}/${endpoint}`, {
      timeout: 10000,
      signal,
      headers: { Accept: "application/json;version=20230302" }
    });
    const tokens = geckoPoolTokens(response.data, sourceName).slice(0, 20);
    geckoCaches[kind] = { updatedAt: now, tokens: structuredClone(tokens), lastStatus: "OK" };
    console.log(`R3 DISCOVERY | ${sourceName} | ${tokens.length} tokens received`);
    return tokens;
  } catch (error) {
    const status = error?.response?.status || "ERROR";
    // Fail open: discovery continues with DexScreener/Birdeye if Gecko is unavailable.
    geckoCaches[kind] = { updatedAt: now, tokens: [], lastStatus: String(status) };
    console.log(`R3 DISCOVERY | ${sourceName} unavailable | ${error.message}`);
    return [];
  }
}

function pruneFreshDiscovery(now = Date.now()) {
  for (const [tokenAddress, item] of freshDiscoveryQueue.entries()) {
    if (now - item.seenAt > FRESH_DISCOVERY_TTL_MS) {
      freshDiscoveryQueue.delete(tokenAddress);
    }
  }
}

async function refreshFreshDiscovery({ signal } = {}) {
  const tokens = await fetchGeckoPoolTokens("newPools", signal);
  const now = Date.now();
  for (const token of tokens) {
    if (!token?.tokenAddress) continue;
    freshDiscoveryQueue.set(token.tokenAddress, {
      ...token,
      discoverySource: "Gecko Fresh New Pools",
      seenAt: now
    });
  }
  pruneFreshDiscovery(now);
  console.log(`R3 FRESH DISCOVERY | queue ${freshDiscoveryQueue.size} | latest ${tokens.length}`);
  return freshDiscoveryQueue.size;
}

function getFreshDiscoveryTokens() {
  pruneFreshDiscovery();
  return [...freshDiscoveryQueue.values()].map(({ seenAt, ...token }) => ({ ...token }));
}

function reactivationStatus(tokenAddress, data, history, isEntrySignal) {
  if (!isEntrySignal) return { blocked: false, confirmed: false };

  const pairCreatedAt = Number(data?.pairCreatedAt);
  if (!Number.isFinite(pairCreatedAt) || pairCreatedAt <= 0) {
    return { blocked: false, confirmed: false };
  }

  const ageMs = Date.now() - pairCreatedAt;
  if (ageMs < REACTIVATION_AGE_MS) return { blocked: false, confirmed: false };

  const prior = (Array.isArray(history) ? history.slice(0, -1) : [])
    .slice(-REACTIVATION_LOOKBACK_OBSERVATIONS);
  if (!prior.length) return { blocked: false, confirmed: false };

  // A mature token should not erase a recently-dead baseline just because its
  // last one or two scans already contain the spike. Require at least two low-
  // activity observations in the recent history, then compare the current
  // volume against that dead baseline.
  const deadObservations = prior.filter(
    x => (Number(x?.volume5m) || 0) <= REACTIVATION_DEAD_BASELINE_VOL5M
  );
  const baselineVol5m = deadObservations.length
    ? Math.max(...deadObservations.map(x => Number(x?.volume5m) || 0))
    : Math.max(...prior.map(x => Number(x?.volume5m) || 0));
  const currentVol5m = Number(data?.volume5m) || 0;
  const growthPct = baselineVol5m > 0
    ? ((currentVol5m - baselineVol5m) / baselineVol5m) * 100
    : currentVol5m > 0 ? Infinity : 0;

  const existing = reactivationWatches.get(tokenAddress);
  if (existing) {
    const elapsed = Date.now() - Number(existing.at || 0);
    if (elapsed > REACTIVATION_CONFIRM_MAX_MS) {
      reactivationWatches.delete(tokenAddress);
    } else {
      const retainedFloor = Math.max(
        2000,
        Number(existing.triggerVolume5m || 0) * REACTIVATION_MIN_RETAINED_VOLUME_RATIO
      );
      if (currentVol5m >= retainedFloor) {
        reactivationWatches.delete(tokenAddress);
        return { blocked: false, confirmed: true, ageMs, baselineVol5m, currentVol5m };
      }
      return { blocked: true, confirmed: false, ageMs, baselineVol5m, currentVol5m };
    }
  }

  const deadBaseSpike =
    deadObservations.length >= REACTIVATION_MIN_DEAD_OBSERVATIONS &&
    baselineVol5m <= REACTIVATION_DEAD_BASELINE_VOL5M &&
    currentVol5m >= 2000 &&
    growthPct >= REACTIVATION_SPIKE_GROWTH_PCT;

  if (!deadBaseSpike) return { blocked: false, confirmed: false, ageMs, baselineVol5m, currentVol5m };

  reactivationWatches.set(tokenAddress, {
    at: Date.now(),
    triggerVolume5m: currentVol5m,
    baselineVol5m
  });
  return { blocked: true, confirmed: false, ageMs, baselineVol5m, currentVol5m };
}

async function discoverCandidatesR3({ signal } = {}) {
  const [sourceResults, birdeyeTrending, geckoTrending] = await Promise.all([
    Promise.all(DISCOVERY_SOURCES.map(source => fetchSource(source, signal))),
    fetchBirdeyeTrendingTokens(signal),
    fetchGeckoPoolTokens("trending", signal)
  ]);
  const freshNewPools = getFreshDiscoveryTokens();
  const unique = new Map();
  let ageFilteredBeforeEnrichment = 0;
  for (const token of [...freshNewPools, ...sourceResults.flat(), ...birdeyeTrending, ...geckoTrending]) {
    if (token?.chainId !== "solana" || !token.tokenAddress) continue;

    const suppliedPairCreatedAt = Number(token.pairCreatedAt);
    if (Number.isFinite(suppliedPairCreatedAt) && suppliedPairCreatedAt > 0) {
      knownPairCreatedAt.set(token.tokenAddress, suppliedPairCreatedAt);
    }
    const knownCreatedAt = Number(knownPairCreatedAt.get(token.tokenAddress));
    if (
      Number.isFinite(knownCreatedAt) &&
      knownCreatedAt > 0 &&
      Date.now() - knownCreatedAt > MAX_ENTRY_PAIR_AGE_MS
    ) {
      ageFilteredBeforeEnrichment += 1;
      continue;
    }

    const source = token.discoverySource || token.name || "DexScreener";
    const existing = unique.get(token.tokenAddress);
    if (!existing) {
      unique.set(token.tokenAddress, { ...token, discoverySources: [source] });
    } else if (!existing.discoverySources.includes(source)) {
      existing.discoverySources.push(source);
    }
  }

  if (ageFilteredBeforeEnrichment > 0) {
    console.log(`R3 AGE FILTER | skipped ${ageFilteredBeforeEnrichment} known pairs older than 48h before enrichment`);
  }

  // Process multi-source discoveries first. Keep DexScreener enrichment fast enough
  // for the 1-minute scanner, but deliberately pace requests to avoid 429 bursts.
  const TOKEN_DATA_CONCURRENCY = 4;
  const TOKEN_DATA_BATCH_DELAY_MS = 650;
  const prioritizedTokens = [...unique.values()].sort((a, b) => {
    const sourceDiff = (b.discoverySources?.length || 0) - (a.discoverySources?.length || 0);
    if (sourceDiff !== 0) return sourceDiff;
    return 0;
  });

  const enriched = [];
  for (let i = 0; i < prioritizedTokens.length; i += TOKEN_DATA_CONCURRENCY) {
    if (signal?.aborted) return [];
    const batch = prioritizedTokens.slice(i, i + TOKEN_DATA_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async token => ({
        token,
        data: await getTokenData(token.tokenAddress, { signal })
      }))
    );
    enriched.push(...results.filter(item => item.data));

    const hasMore = i + TOKEN_DATA_CONCURRENCY < prioritizedTokens.length;
    if (hasMore && !signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, TOKEN_DATA_BATCH_DELAY_MS));
    }
  }

  const candidates = [];
  let ageFilteredAfterEnrichment = 0;
  for (const { token, data } of enriched) {
    if (signal?.aborted) return [];

    const pairCreatedAt = Number(data?.pairCreatedAt);
    if (Number.isFinite(pairCreatedAt) && pairCreatedAt > 0) {
      knownPairCreatedAt.set(token.tokenAddress, pairCreatedAt);
      if (Date.now() - pairCreatedAt > MAX_ENTRY_PAIR_AGE_MS) {
        ageFilteredAfterEnrichment += 1;
        continue;
      }
    }

    const liquidity = Number(data.liquidityUsd) || 0;
    // R3 intentionally does not use 24h volume as a discovery gate.
    // Young runners are allowed into WATCH based on liquidity; live 5m/1h
    // acceleration decides whether they can become an entry.
    if (liquidity < WATCH_MIN_LIQUIDITY) continue;

    const history = remember(token.tokenAddress, data);
    const analysis = analyzeEarlyRunner(history, data);

    const isEntrySignal =
      analysis.signal === "EARLY RUNNER" ||
      analysis.signal === "PROVISIONAL EARLY RUNNER";

    const reactivation = reactivationStatus(token.tokenAddress, data, history, isEntrySignal);
    const entryNeedsSecurity = isEntrySignal && !reactivation.blocked;

    let security = { ok: true, reasons: [], lpLockedPct: null };
    if (entryNeedsSecurity) {
      const integrity = marketDataIntegritySnapshot(data, token.tokenAddress);
      if (!integrity.ok) {
        security = { ok: false, reasons: integrity.reasons, lpLockedPct: null };
      } else {
        const [tokenSecurity, liquiditySecurity] = await Promise.all([
          tokenSecuritySnapshot(token.tokenAddress, signal),
          liquiditySecuritySnapshot(token.tokenAddress, signal)
        ]);
        const reasons = [
          ...(tokenSecurity.blocked ? tokenSecurity.reasons : []),
          ...(liquiditySecurity.blocked ? liquiditySecurity.reasons : [])
        ];
        security = {
          ok: reasons.length === 0,
          reasons,
          lpLockedPct: liquiditySecurity.lpLockedPct ?? null
        };
      }
    }

    const resetOk = resetEligible(token.tokenAddress, history);
    const reentryStats = recentTokenStats(token.tokenAddress);
    const failedLaunchRetryOk =
      entryNeedsSecurity &&
      failedLaunchRetryEligible(token.tokenAddress, history, analysis, data, reentryStats);

    const signalName =
      isEntrySignal && reactivation.blocked ? "REACTIVATION WATCH" :
      entryNeedsSecurity && !security.ok ? "SECURITY VETO" :
      failedLaunchRetryOk ? "FAILED LAUNCH RETRY" :
      isEntrySignal &&
        reentryStats.losingFullExits >= MAX_LOSING_EXITS_PER_TOKEN_24H
        ? "REENTRY BLOCK"
        : isEntrySignal && !resetOk ? "RESET WAIT" :
      analysis.signal;

    const tx = Number(data.buys5m || 0) + Number(data.sells5m || 0);
    const buyRatio = tx > 0 ? Number(data.buys5m || 0) / tx : 0;
    const blockers = [];
    if (analysis.signal === "WATCH" && Number(analysis.score) >= 10) {
      if (!(Number(analysis.metrics.volume5mGrowthPct) >= 25)) blockers.push("VOL_GROWTH");
      if (!(Number(data.volume5m) >= 2000)) blockers.push("VOL5M");
      if (!(tx >= 20)) blockers.push("TX");
      if (!(buyRatio >= 0.52 && buyRatio <= 0.80)) blockers.push("BUY_RATIO");
      if (!(Number(data.priceChange5m) >= 0.10 && Number(data.priceChange5m) < 4)) blockers.push("PRICE_5M");
      if (!(Number(data.priceChange1h) >= -10 && Number(data.priceChange1h) <= 40)) blockers.push("PRICE_1H");
      if (!(Number(analysis.metrics.liquidityDrawdownPct) <= 12)) blockers.push("LIQ_DRAWDOWN");
    }

    console.log(
      `R3 WATCH | ${data.symbol} | ${signalName} | Score ${analysis.score} | Liq ${liquidity.toFixed(0)} | Vol5m ${Number(data.volume5m || 0).toFixed(0)} | LiqΔ ${analysis.metrics.liquidityGrowthPct?.toFixed?.(1) ?? "n/a"}% | Vol5mΔ ${analysis.metrics.volume5mGrowthPct?.toFixed?.(1) ?? "n/a"}%` +
      (blockers.length
        ? ` | BLOCKED ${blockers.join(",")} | 5m ${Number(data.priceChange5m || 0).toFixed(2)}% | 1h ${Number(data.priceChange1h || 0).toFixed(2)}% | Tx ${tx} | Buy ${(buyRatio * 100).toFixed(1)}%`
        : "") +
      (signalName === "REACTIVATION WATCH"
        ? ` | AGE ${(Number(reactivation.ageMs || 0) / 3600000).toFixed(1)}h | BASE_VOL5M ${Number(reactivation.baselineVol5m || 0).toFixed(0)}`
        : "")
    );

    candidates.push({
      tokenAddress: token.tokenAddress,
      ...data,
      score: analysis.score,
      signal: signalName,
      reasons: analysis.reasons,
      r3Metrics: analysis.metrics,
      r3Security: security,
      discoverySources: token.discoverySources || [token.discoverySource || "DexScreener"],
      pairAgeHours: Number(data.pairCreatedAt) > 0
        ? (Date.now() - Number(data.pairCreatedAt)) / (60 * 60 * 1000)
        : null,
      reactivationConfirmed: Boolean(reactivation.confirmed)
    });
  }

  if (ageFilteredAfterEnrichment > 0) {
    console.log(`R3 AGE FILTER | blocked ${ageFilteredAfterEnrichment} newly-resolved pairs older than 48h`);
  }

  const updatedAt = new Date().toISOString();
  lastDiscoveryTelemetry = {
    updatedAt,
    strategy: "R3-EARLY-RUNNER",
    uniqueSolanaCandidates: unique.size,
    candidatesAfterSafetyFilters: candidates.length,
    strongBuys: candidates.filter(
      x =>
        x.signal === "EARLY RUNNER" ||
        x.signal === "PROVISIONAL EARLY RUNNER" ||
        x.signal === "FAILED LAUNCH RETRY"
    ).length,
    topCandidates: candidates.slice(0, 10).map(x => ({
      symbol: x.symbol,
      tokenAddress: x.tokenAddress,
      score: x.score,
      signal: x.signal
    }))
  };

  candidates.sort((a, b) => {
    const aEntry =
      a.signal === "EARLY RUNNER" ||
      a.signal === "PROVISIONAL EARLY RUNNER" ||
      a.signal === "FAILED LAUNCH RETRY" ? 1 : 0;
    const bEntry =
      b.signal === "EARLY RUNNER" ||
      b.signal === "PROVISIONAL EARLY RUNNER" ||
      b.signal === "FAILED LAUNCH RETRY" ? 1 : 0;
    if (aEntry !== bEntry) return bEntry - aEntry;
    return b.score - a.score;
  });
  return candidates;
}

module.exports = {
  discoverCandidatesR3,
  refreshFreshDiscovery,
  FRESH_DISCOVERY_POLL_MS,
  markExhausted,
  getDiscoveryTelemetry: () => structuredClone(lastDiscoveryTelemetry),
  getCachedCandidates: () => ({ updatedAt: lastDiscoveryTelemetry.updatedAt, candidates: [] }),
  getHistory: tokenAddress => structuredClone(histories.get(tokenAddress) || []),
  getExhaustedState: tokenAddress => structuredClone(exhausted.get(tokenAddress) || null)
};
