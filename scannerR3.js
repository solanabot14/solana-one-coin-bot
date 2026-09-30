const axios = require("axios");
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
const histories = new Map();
const exhausted = new Map();
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
  return histories.get(tokenAddress);
}

function markExhausted(tokenAddress, context = {}) {
  exhausted.set(tokenAddress, {
    at: Date.now(),
    reason: context.reason || "EXIT",
    high: Number(context.highestPrice) || null
  });
}

function resetEligible(tokenAddress, history) {
  const state = exhausted.get(tokenAddress);
  if (!state) return true;
  const now = Date.now();
  if (now - state.at < RESET_MIN_MS) return false;
  const postExit = history.filter(x => x.at > state.at);
  if (postExit.length < 3) return false;
  // Require at least one cooling observation before allowing a fresh setup.
  const cooled = postExit.some(x => x.priceChange5m <= 1.5);
  if (!cooled) return false;
  exhausted.delete(tokenAddress);
  return true;
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

    let security = { ok: true, reasons: [], lpLockedPct: null };
    if (analysis.signal === "EARLY RUNNER") {
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
    const signalName =
      analysis.signal === "EARLY RUNNER" && !security.ok ? "SECURITY VETO" :
      analysis.signal === "EARLY RUNNER" && !resetOk ? "RESET WAIT" :
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
    strongBuys: candidates.filter(x => x.signal === "EARLY RUNNER").length,
    topCandidates: candidates.slice(0, 10).map(x => ({
      symbol: x.symbol,
      tokenAddress: x.tokenAddress,
      score: x.score,
      signal: x.signal
    }))
  };

  candidates.sort((a, b) => {
    const aEntry = a.signal === "EARLY RUNNER" ? 1 : 0;
    const bEntry = b.signal === "EARLY RUNNER" ? 1 : 0;
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
