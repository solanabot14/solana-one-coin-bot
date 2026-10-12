const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const market = require("./dexscreener");
const geckoTerminal = require("./geckoTerminal");
const { analyzeToken } = require("./strategy");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus } = require("./lpLockChecker");

const MAX_PAIR_AGE_MS = 30 * 60 * 1000;
const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_24H_USD = 25000;
const MIN_VOLUME_5M_USD = 1500;
const MIN_TRANSACTIONS_5M = 12;
const MIN_BUY_RATIO_5M = 0.55;
const DEXSCREENER_PAIR_API = "https://api.dexscreener.com/latest/dex/pairs/solana";
const MAX_PAIR_ADDRESSES_PER_REQUEST = 30;
const MAX_TRACKED_NEW_POOLS = 60;
const PAIR_REQUEST_TIMEOUT_MS = 10000;
const trackedLaunchPools = new Map();
let lastScanDiagnostics = null;

function statePath(fileName = "launchSniperPaperTradingData.json") {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the launch watcher.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), fileName);
}

function addressFromResourceId(id) {
  return typeof id === "string" ? id.replace(/^solana_/, "") : "";
}

function toTimestamp(value) {
  if (Number.isFinite(Number(value))) {
    const number = Number(value);
    return number > 1e12 ? number : number * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeNewPool(pool) {
  const attributes = pool?.attributes || {};
  const relationships = pool?.relationships || {};
  const poolAddress = attributes.address || addressFromResourceId(pool?.id);
  const tokenAddress = attributes.base_token_address ||
    addressFromResourceId(relationships.base_token?.data?.id);
  const createdAt = toTimestamp(attributes.pool_created_at || attributes.created_at);
  if (!poolAddress || !tokenAddress || !createdAt) return null;
  return { poolAddress, tokenAddress, createdAt };
}

function qualifiesLaunchCandidate(data, now = Date.now(), minimumLiquidityUsd = MIN_LIQUIDITY_USD, minimumVolume24hUsd = MIN_VOLUME_24H_USD) {
  if (!data || typeof data !== "object") return false;
  const createdAt = Number(data.pairCreatedAt);
  const ageMs = now - createdAt;
  const liquidity = Number(data.liquidityUsd);
  const volume24h = Number(data.volume24h);
  const volume5m = Number(data.volume5m);
  const buys5m = Number(data.buys5m);
  const sells5m = Number(data.sells5m);
  const transactions5m = buys5m + sells5m;
  const buyRatio5m = transactions5m > 0 ? buys5m / transactions5m : 0;
  return Number.isFinite(createdAt) && ageMs >= 0 && ageMs <= MAX_PAIR_AGE_MS &&
    Number.isFinite(liquidity) && liquidity >= minimumLiquidityUsd &&
    Number.isFinite(volume24h) && volume24h >= minimumVolume24hUsd &&
    Number.isFinite(volume5m) && volume5m >= MIN_VOLUME_5M_USD &&
    transactions5m >= MIN_TRANSACTIONS_5M && buyRatio5m >= MIN_BUY_RATIO_5M;
}

function estimateExecutionCosts({ amountUsd, liquidityUsd }) {
  const amount = Number(amountUsd);
  const liquidity = Number(liquidityUsd);
  if (!(amount > 0) || !(liquidity > 0)) return null;
  const impactPercent = amount / (liquidity / 2 + amount) * 100;
  const slippageUsd = amount * impactPercent / 100;
  const poolFeeUsd = amount * 0.003;
  const solanaFeeUsd = 0.01;
  return {
    feesUsd: poolFeeUsd + solanaFeeUsd,
    slippageUsd,
    poolFeeUsd,
    solanaFeeUsd,
    priorityFeeUsd: 0
  };
}

const trader = createPaperTrader(
  statePath(),
  fs,
  {
    strategyVersion: "Paper-Launch-Watcher-v1",
    startingBalance: 100,
    maxOpenPositions: 3,
    getBuySizing: () => ({ amountInvested: 10, compoundRate: 0.10 }),
    estimateExecutionCosts
  }
);

async function fetchDexPairs(poolAddresses, signal) {
  const pairs = [];
  for (let start = 0; start < poolAddresses.length; start += MAX_PAIR_ADDRESSES_PER_REQUEST) {
    if (signal?.aborted) break;
    const batch = poolAddresses.slice(start, start + MAX_PAIR_ADDRESSES_PER_REQUEST);
    const response = await axios.get(DEXSCREENER_PAIR_API + "/" + batch.join(","), {
      timeout: PAIR_REQUEST_TIMEOUT_MS,
      signal
    });
    if (Array.isArray(response?.data?.pairs)) pairs.push(...response.data.pairs);
  }
  return pairs;
}

function mapLaunchPair(pair, descriptor) {
  if (!pair || !descriptor || pair.chainId !== "solana" ||
      pair.pairAddress !== descriptor.poolAddress ||
      pair.baseToken?.address !== descriptor.tokenAddress) return null;
  const data = {
    name: pair.baseToken?.name,
    symbol: pair.baseToken?.symbol,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidity?.usd,
    volume5m: pair.volume?.m5,
    volume24h: pair.volume?.h24,
    priceChange5m: pair.priceChange?.m5,
    priceChange1h: pair.priceChange?.h1,
    priceChange24h: pair.priceChange?.h24,
    buys5m: pair.txns?.m5?.buys,
    sells5m: pair.txns?.m5?.sells,
    tokenAddress: descriptor.tokenAddress,
    pairAddress: descriptor.poolAddress,
    pairCreatedAt: descriptor.createdAt,
    newPoolCreatedAt: new Date(descriptor.createdAt).toISOString(),
    discoverySource: "GECKOTERMINAL_NEW_POOL"
  };
  const analysis = analyzeToken(data);
  return { ...data, score: analysis.score, signal: analysis.signal, reasons: analysis.reasons };
}

function measureCandidateGates(candidates, now = Date.now(), minimumLiquidityUsd = MIN_LIQUIDITY_USD, minimumVolume24hUsd = MIN_VOLUME_24H_USD) {
  const gates = {
    pairsMatched: candidates.length,
    age: 0,
    liquidity: 0,
    volume24h: 0,
    volume5m: 0,
    transactions5m: 0,
    buyRatio5m: 0,
    eligible: 0
  };
  for (const data of candidates) {
    const createdAt = Number(data.pairCreatedAt);
    const ageMs = now - createdAt;
    if (!Number.isFinite(createdAt) || ageMs < 0 || ageMs > MAX_PAIR_AGE_MS) continue;
    gates.age++;
    if (!(Number(data.liquidityUsd) >= minimumLiquidityUsd)) continue;
    gates.liquidity++;
    if (!(Number(data.volume24h) >= minimumVolume24hUsd)) continue;
    gates.volume24h++;
    if (!(Number(data.volume5m) >= MIN_VOLUME_5M_USD)) continue;
    gates.volume5m++;
    const buys = Number(data.buys5m);
    const sells = Number(data.sells5m);
    const transactions = buys + sells;
    if (!(transactions >= MIN_TRANSACTIONS_5M)) continue;
    gates.transactions5m++;
    if (!(buys / transactions >= MIN_BUY_RATIO_5M)) continue;
    gates.buyRatio5m++;
    gates.eligible++;
  }
  return gates;
}

async function discoverLaunchCandidates({ signal, minimumLiquidityUsd = MIN_LIQUIDITY_USD, minimumVolume24hUsd = MIN_VOLUME_24H_USD } = {}) {
  const now = Date.now();
  const diagnostics = {
    updatedAt: new Date(now).toISOString(),
    source: "GeckoTerminal new pools + DexScreener pair data",
    poolsReceived: 0,
    poolsInAgeWindow: 0,
    poolsTracked: 0,
    dexPairsReturned: 0,
    gates: null,
    error: null
  };
  try {
    const freshPools = await geckoTerminal.getNewSolanaPools({ signal });
    diagnostics.poolsReceived = Array.isArray(freshPools) ? freshPools.length : 0;
    for (const pool of Array.isArray(freshPools) ? freshPools : []) {
      const descriptor = describeNewPool(pool);
      if (!descriptor || descriptor.createdAt > now + 60000 ||
          now - descriptor.createdAt > MAX_PAIR_AGE_MS) continue;
      trackedLaunchPools.set(descriptor.poolAddress, descriptor);
    }
    for (const [address, descriptor] of trackedLaunchPools) {
      if (descriptor.createdAt > now + 60000 || now - descriptor.createdAt > MAX_PAIR_AGE_MS) {
        trackedLaunchPools.delete(address);
      }
    }
    if (trackedLaunchPools.size > MAX_TRACKED_NEW_POOLS) {
      const newest = [...trackedLaunchPools.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_TRACKED_NEW_POOLS);
      trackedLaunchPools.clear();
      for (const descriptor of newest) trackedLaunchPools.set(descriptor.poolAddress, descriptor);
    }

    diagnostics.poolsInAgeWindow = trackedLaunchPools.size;
    diagnostics.poolsTracked = trackedLaunchPools.size;
    if (signal?.aborted || !trackedLaunchPools.size) {
      diagnostics.gates = measureCandidateGates([], now, minimumLiquidityUsd, minimumVolume24hUsd);
      lastScanDiagnostics = diagnostics;
      console.log("PAPER LAUNCH SCAN | pools received: " + diagnostics.poolsReceived +
        " | recent pools tracked: " + diagnostics.poolsTracked + " | no pairs queried");
      return [];
    }

    const descriptors = [...trackedLaunchPools.values()];
    const dexPairs = await fetchDexPairs(descriptors.map(pool => pool.poolAddress), signal);
    diagnostics.dexPairsReturned = dexPairs.length;
    const descriptorByPool = new Map(descriptors.map(pool => [pool.poolAddress, pool]));
    const mapped = dexPairs
      .map(pair => mapLaunchPair(pair, descriptorByPool.get(pair?.pairAddress)))
      .filter(Boolean);
    const gates = measureCandidateGates(mapped, now, minimumLiquidityUsd, minimumVolume24hUsd);
    const eligibleCandidates = mapped.filter(candidate => qualifiesLaunchCandidate(candidate, now, minimumLiquidityUsd, minimumVolume24hUsd));
    const signalCounts = {};
    for (const candidate of eligibleCandidates) {
      signalCounts[candidate.signal] = (signalCounts[candidate.signal] || 0) + 1;
    }
    diagnostics.gates = gates;
    diagnostics.signalCounts = signalCounts;
    lastScanDiagnostics = diagnostics;
    const signalSummary = Object.entries(signalCounts).map(([signal, count]) =>
      signal + " " + count
    ).join(", ") || "none";
    console.log("PAPER LAUNCH SCAN | pools received: " + diagnostics.poolsReceived +
      " | recent pools: " + diagnostics.poolsTracked + " | Dex pairs: " + diagnostics.dexPairsReturned +
      " | exact pool matches: " + gates.pairsMatched + " | age: " + gates.age +
      " | liquidity: " + gates.liquidity + " | 24h volume: " + gates.volume24h +
      " | 5m volume: " + gates.volume5m + " | 5m trades: " + gates.transactions5m +
      " | buy flow: " + gates.buyRatio5m + " | eligible: " + gates.eligible +
      " | activity-qualified signals: " + signalSummary);
    return eligibleCandidates;
  } catch (error) {
    diagnostics.error = error.message;
    diagnostics.gates = measureCandidateGates([], now, minimumLiquidityUsd, minimumVolume24hUsd);
    lastScanDiagnostics = diagnostics;
    if (!signal?.aborted) console.warn("PAPER LAUNCH DISCOVERY UNAVAILABLE | " + error.message);
    return [];
  }
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: async () => {}
};

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  discoverCandidates: discoverLaunchCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  positionMonitorMs: 5000,
  scannerIntervalMs: 30000,
  botLabel: "Paper Launch Watcher",
  reentryStateFile: statePath("launchSniperPaperReentryState.json"),
  maxOpenPositions: 3,
  maxCandidateAgeMinutes: 30,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  minimumVolume24hUsd: MIN_VOLUME_24H_USD,
  acceptedSignals: ["BUY", "STRONG BUY"],
  requireLiquidityLock: true,
  allowUnknownLiquidityLock: true,
  useSimpleCooldown: true
});

function getStatus() {
  return {
    running: bot.getBotStatus(),
    error: bot.getLastError(),
    mode: "PAPER",
    execution: "No wallet connection or live swaps",
    scanIntervalMs: 30000,
    positionMonitorIntervalMs: 5000,
    maximumPairAgeMinutes: 30,
    minimumLiquidityLockPercent: 70,
    allowUnknownLiquidityLockInPaper: true,
    scanDiagnostics: lastScanDiagnostics
  };
}

module.exports = {
  ...bot,
  getStatus,
  getPortfolio: trader.getPortfolio,
  discoverLaunchCandidates,
  qualifiesLaunchCandidate,
  estimateExecutionCosts,
  thresholds: {
    maximumPairAgeMinutes: 30,
    minimumLiquidityUsd: MIN_LIQUIDITY_USD,
    minimumVolume24hUsd: MIN_VOLUME_24H_USD,
    minimumVolume5mUsd: MIN_VOLUME_5M_USD,
    minimumTransactions5m: MIN_TRANSACTIONS_5M,
    minimumBuyRatio5m: MIN_BUY_RATIO_5M,
    maximumOpenPositions: 3,
    paperEntryUsd: 10
  }
};
