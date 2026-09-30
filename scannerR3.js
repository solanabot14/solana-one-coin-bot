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

const WATCH_MIN_LIQUIDITY = 25000;
const HISTORY_TTL_MS = 45 * 60 * 1000;
const RESET_MIN_MS = 10 * 60 * 1000;
const REENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_TOKEN_24H = 2;
const MAX_LOSING_EXITS_PER_TOKEN_24H = 2;
const RESET_MIN_POST_COOL_OBS = 2;
const RESET_MIN_VOL5M_GROWTH_PCT = 25;
const RESET_MAX_LIQUIDITY_DRAWDOWN_PCT = 12;
const histories = new Map();
const exhausted = new Map();

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
      for (const trade of Array.isArray(data?.history) ? data.history : []) {
        if (trade?.tokenAddress !== tokenAddress) continue;
        const when = Date.parse(trade.type === "BUY" ? trade.entryTime : trade.exitTime);
        if (!Number.isFinite(when) || when < cutoff) continue;
        if (trade.type === "BUY") entries++;
        if (
          trade.type === "SELL" &&
          Number(trade.percentSold) === 100 &&
          Number(trade.pnlPercent) < 0
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

function resetEligible(tokenAddress, history) {
  const state = exhausted.get(tokenAddress);
  if (!state) return true;

  const stats = recentTokenStats(tokenAddress);
  if (
    stats.entries >= MAX_ENTRIES_PER_TOKEN_24H ||
    stats.losingFullExits >= MAX_LOSING_EXITS_PER_TOKEN_24H
  ) {
    return false;
  }

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

  const freshAcceleration =
    volGrowthPct !== null &&
    volGrowthPct >= RESET_MIN_VOL5M_GROWTH_PCT &&
    latestVol >= 3000 &&
    Number(latest.priceChange5m) >= 0.25 &&
    Number(latest.priceChange5m) < 4 &&
    tx >= 20 &&
    buyRatio >= 0.52 &&
    buyRatio <= 0.80 &&
    liqDrawdownPct <= RESET_MAX_LIQUIDITY_DRAWDOWN_PCT;

  return freshAcceleration;
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

async function discoverCandidatesR3({ signal } = {}) {
  const sourceResults = await Promise.all(DISCOVERY_SOURCES.map(source => fetchSource(source, signal)));
  const unique = new Map();
  for (const token of sourceResults.flat()) {
    if (token?.chainId !== "solana" || !token.tokenAddress) continue;
    if (!unique.has(token.tokenAddress)) unique.set(token.tokenAddress, token);
  }

  const candidates = [];
  for (const token of unique.values()) {
    if (signal?.aborted) return [];
    const data = await getTokenData(token.tokenAddress, { signal });
    if (!data) continue;

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

    let security = { ok: true, reasons: [], lpLockedPct: null };
    if (isEntrySignal) {
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
    const signalName =
      isEntrySignal && !security.ok ? "SECURITY VETO" :
      isEntrySignal &&
        (reentryStats.entries >= MAX_ENTRIES_PER_TOKEN_24H ||
         reentryStats.losingFullExits >= MAX_LOSING_EXITS_PER_TOKEN_24H)
        ? "REENTRY BLOCK"
        : isEntrySignal && !resetOk ? "RESET WAIT" :
      analysis.signal;

    console.log(
      `R3 WATCH | ${data.symbol} | ${signalName} | Score ${analysis.score} | Liq $${liquidity.toFixed(0)} | Vol5m $${Number(data.volume5m || 0).toFixed(0)} | LiqΔ ${analysis.metrics.liquidityGrowthPct?.toFixed?.(1) ?? "n/a"}% | Vol5mΔ ${analysis.metrics.volume5mGrowthPct?.toFixed?.(1) ?? "n/a"}%`
    );

    candidates.push({
      tokenAddress: token.tokenAddress,
      ...data,
      score: analysis.score,
      signal: signalName,
      reasons: analysis.reasons,
      r3Metrics: analysis.metrics,
      r3Security: security
    });
  }

  const updatedAt = new Date().toISOString();
  lastDiscoveryTelemetry = {
    updatedAt,
    strategy: "R3-EARLY-RUNNER",
    uniqueSolanaCandidates: unique.size,
    candidatesAfterSafetyFilters: candidates.length,
    strongBuys: candidates.filter(
      x => x.signal === "EARLY RUNNER" || x.signal === "PROVISIONAL EARLY RUNNER"
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
      a.signal === "EARLY RUNNER" || a.signal === "PROVISIONAL EARLY RUNNER" ? 1 : 0;
    const bEntry =
      b.signal === "EARLY RUNNER" || b.signal === "PROVISIONAL EARLY RUNNER" ? 1 : 0;
    if (aEntry !== bEntry) return bEntry - aEntry;
    return b.score - a.score;
  });
  return candidates;
}

module.exports = {
  discoverCandidatesR3,
  markExhausted,
  getDiscoveryTelemetry: () => structuredClone(lastDiscoveryTelemetry),
  getCachedCandidates: () => ({ updatedAt: lastDiscoveryTelemetry.updatedAt, candidates: [] }),
  getHistory: tokenAddress => structuredClone(histories.get(tokenAddress) || []),
  getExhaustedState: tokenAddress => structuredClone(exhausted.get(tokenAddress) || null)
};
