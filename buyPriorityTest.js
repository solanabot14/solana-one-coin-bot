const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus, getTokenReport } = require("./lpLockChecker");
const telegram = require("./telegram");

const BOT_LABEL = "New Claude Strategy";
const CONFIG = Object.freeze({
  capital: {
    startingUsd: 100,
    maxOpenPositions: 4,
    tradeFraction: 0.10,
    minimumTradeUsd: 10,
    maximumLiquidityFraction: 0.01,
    pauseAtBalanceUsd: 70
  },
  entry: {
    minimumAgeMinutes: 30,
    maximumAgeHours: 6,
    minimumLiquidityUsd: 20000,
    minimumVolume1hUsd: 10000,
    maximumTop10HolderPercent: 30,

    watchlistMaxTokens: 20,
    watchlistPollIntervalSeconds: 15,
    watchlistTimeoutMinutes: 90,
    priceHistoryRetentionMinutes: 12,
    discoveryRefreshSeconds: 120,
    safetyRecheckSeconds: 120,

    pumpRisePercent: 40,
    pullbackMinPercent: 20,
    pullbackMaxPercent: 40,
    removeAfterDropPercent: 50,
    baseNoNewLowMinutes: 3,
    triggerRisePercent: 8,
    volumeSurgeMultiplier: 1.5,
    maximumRecoveryPercent: 70,
    pullbackStopBelowLowPercent: 3
  },
  exit: {
    stopLossPercent: 15,
    breakevenTriggerPercent: 15,
    firstTargetPercent: 25,
    firstTargetOriginalPositionPercent: 40,
    secondTargetPercent: 60,
    secondTargetOriginalPositionPercent: 30,
    trailingStopPercent: 20,
    timeStopMinutes: 15,
    minimumGainAtTimeStopPercent: 5
  },
  estimatedCosts: {
    poolFeePercentPerSwap: 0.30,
    solanaFeeUsdPerSwap: 0.01,
    priorityFeeUsdPerSwap: 0.01
  }
});

function statePath(fileName) {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the BUY priority paper test.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), fileName);
}

function estimatedImpactPercent(tradeUsd, liquidityUsd) {
  const trade = Number(tradeUsd);
  const liquidity = Number(liquidityUsd);
  if (!(trade > 0) || !(liquidity > 0)) return null;
  const approximateUsdReserve = liquidity / 2;
  return trade / (approximateUsdReserve + trade) * 100;
}

function estimateExecutionCosts({ amountUsd, liquidityUsd, position } = {}) {
  const amount = Number(amountUsd);
  const liquidity = Number(liquidityUsd || position?.entryLiquidityUsd);
  const impactPercent = estimatedImpactPercent(amount, liquidity);
  if (!(amount > 0) || impactPercent === null) return null;
  const poolFeeUsd = amount * CONFIG.estimatedCosts.poolFeePercentPerSwap / 100;
  const solanaFeeUsd = CONFIG.estimatedCosts.solanaFeeUsdPerSwap;
  const priorityFeeUsd = CONFIG.estimatedCosts.priorityFeeUsdPerSwap;
  return {
    feesUsd: poolFeeUsd + solanaFeeUsd + priorityFeeUsd,
    slippageUsd: amount * impactPercent / 100,
    poolFeeUsd,
    solanaFeeUsd,
    priorityFeeUsd
  };
}

function nextCompoundRate() {
  return CONFIG.capital.tradeFraction;
}

function getBuySizing(portfolio, coin = {}) {
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const realizedBalance = Number(portfolio.cashBalance || 0) +
    positions.reduce((sum, position) => sum + (Number(position.amountInvested) || 0), 0);
  const cash = Number(portfolio.cashBalance) || 0;
  const liquidityCap = Number(coin.liquidityUsd) * CONFIG.capital.maximumLiquidityFraction;
  const requested = Math.max(realizedBalance * nextCompoundRate(), CONFIG.capital.minimumTradeUsd);
  const amountInvested = Math.min(requested, cash, liquidityCap);
  return {
    compoundRate: nextCompoundRate(),
    amountInvested: Number.isFinite(amountInvested) ? amountInvested : 0
  };
}

const trader = createPaperTrader(
  statePath("v31BuyPriorityTestTradingData.json"),
  fs,
  {
    strategyVersion: "v3.2-momentum",
    getBuySizing,
    maxOpenPositions: CONFIG.capital.maxOpenPositions,
    startingBalance: CONFIG.capital.startingUsd,
    estimateExecutionCosts
  }
);

const watchlist = new Map();
const watchlistRemovalEvents = [];
const recentlyRemovedTokens = new Map();

let watchlistPollBusy = false;

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recordWatchSample(item, data, now) {
  const price = optionalNumber(data.priceUsd);
  if (!(price > 0)) return false;

  item.samples.push({
    at: now,
    price,
    volume5m: optionalNumber(data.volume5m),
    buys5m: optionalNumber(data.buys5m),
    sells5m: optionalNumber(data.sells5m)
  });

  const cutoff = now - CONFIG.entry.priceHistoryRetentionMinutes * 60000;
  item.samples = item.samples.filter(sample => sample.at >= cutoff);
  item.lastPrice = price;
  item.lastSampleAt = now;
  item.latestData = { ...data };
  return true;
}

function setWatchState(item, state, now) {
  if (item.state === state) return;
  item.state = state;
  item.statesReached.push({ state, at: now });
}

function removeWatchedToken(tokenAddress, reason, now = Date.now()) {
  const item = watchlist.get(tokenAddress);
  if (!item) return;

  watchlist.delete(tokenAddress);
  recentlyRemovedTokens.set(
    tokenAddress,
    now + CONFIG.entry.watchlistTimeoutMinutes * 60000
  );

  watchlistRemovalEvents.push({
    tokenAddress,
    pairAddress: item.pairAddress,
    reason,
    removedAt: now,
    statesReached: item.statesReached,
    peakPrice: item.pumpPeak,
    firstPullbackLow: item.firstPullbackLow,
    secondPullbackLow: item.secondPullbackLow
  });

  if (watchlistRemovalEvents.length > 200) watchlistRemovalEvents.shift();
}

function addWatchedToken(tokenAddress, data, now = Date.now()) {
  const blockedUntil = recentlyRemovedTokens.get(tokenAddress);
  if (blockedUntil && blockedUntil > now) return false;
  if (blockedUntil) recentlyRemovedTokens.delete(tokenAddress);
  if (watchlist.has(tokenAddress)) return false;

  if (watchlist.size >= CONFIG.entry.watchlistMaxTokens) {
    const oldest = [...watchlist.entries()]
      .sort((a, b) => a[1].admittedAt - b[1].admittedAt)[0];
    if (oldest) {
      removeWatchedToken(oldest[0], "watchlist_full_oldest_evicted", now);
    }
  }

  const price = optionalNumber(data.priceUsd);
  if (!(price > 0)) return false;

  const item = {
    tokenAddress,
    pairAddress: data.pairAddress,
    admittedAt: now,
    state: "WATCH",
    statesReached: [{ state: "WATCH", at: now }],
    lowSinceWatching: price,
    pumpPeak: null,
    pullbackNumber: 0,
    pullbackPeak: null,
    pullbackLow: null,
    firstPullbackLow: null,
    secondPullbackLow: null,
    noNewLowSince: null,
    recoveryPeak: null,
    samples: [],
    lastPrice: price,
    lastSampleAt: now,
    triggerCandidate: null,
    triggerSafety: null,
    triggerSafetyCheckedAt: 0
  };

  recordWatchSample(item, data, now);
  watchlist.set(tokenAddress, item);
  return true;
}

function updateWatchedToken(tokenAddress, data, now = Date.now()) {
  const item = watchlist.get(tokenAddress);
  if (!item) return;

  if (now - item.admittedAt >=
      CONFIG.entry.watchlistTimeoutMinutes * 60000) {
    removeWatchedToken(tokenAddress, "no_trigger_within_90_minutes", now);
    return;
  }

  if (!data || data.pairAddress !== item.pairAddress) {
    if (data?.pairAddress && data.pairAddress !== item.pairAddress) {
      removeWatchedToken(tokenAddress, "pair_changed", now);
    }
    return;
  }

  const price = optionalNumber(data.priceUsd);
  if (!(price > 0) || !recordWatchSample(item, data, now)) return;

  const e = CONFIG.entry;

  if (item.state === "WATCH") {
    item.lowSinceWatching = Math.min(item.lowSinceWatching, price);
    if (price >= item.lowSinceWatching * (1 + e.pumpRisePercent / 100)) {
      item.pumpPeak = price;
      setWatchState(item, "PUMP", now);
    }
    return;
  }

  if (item.state === "PUMP") {
    item.pumpPeak = Math.max(item.pumpPeak || price, price);
    const dropPercent = (item.pumpPeak - price) / item.pumpPeak * 100;

    if (dropPercent > e.removeAfterDropPercent) {
      removeWatchedToken(tokenAddress, "drop_over_50_percent", now);
      return;
    }

    if (dropPercent >= e.pullbackMinPercent &&
        dropPercent <= e.pullbackMaxPercent) {
      item.pullbackNumber = 1;
      item.pullbackPeak = item.pumpPeak;
      item.pullbackLow = price;
      item.noNewLowSince = now;
      setWatchState(item, "PULLBACK", now);
    }
    return;
  }

  if (item.state === "PULLBACK") {
    const dropPercent = (item.pullbackPeak - price) / item.pullbackPeak * 100;

    if (dropPercent > e.removeAfterDropPercent) {
      removeWatchedToken(tokenAddress, "drop_over_50_percent", now);
      return;
    }

    if (price < item.pullbackLow) {
      if (item.pullbackNumber === 2 &&
          price <= item.firstPullbackLow) {
        removeWatchedToken(tokenAddress, "second_pullback_lower_low", now);
        return;
      }
      item.pullbackLow = price;
      item.noNewLowSince = now;
    }

    if (now - item.noNewLowSince >= e.baseNoNewLowMinutes * 60000) {
      if (item.pullbackNumber === 1) {
        item.firstPullbackLow = item.pullbackLow;
      } else {
        item.secondPullbackLow = item.pullbackLow;
      }
      item.recoveryPeak = price;
      setWatchState(item, "BASE", now);
    }
    return;
  }

  if (item.state === "BASE") {
    if (item.pullbackNumber === 1 &&
        item.firstPullbackLow !== null &&
        price < item.firstPullbackLow) {
      removeWatchedToken(tokenAddress, "later_lower_low", now);
      return;
    }

    item.recoveryPeak = Math.max(item.recoveryPeak || price, price);
    const dropPercent = (item.recoveryPeak - price) / item.recoveryPeak * 100;

    if (dropPercent > e.removeAfterDropPercent) {
      removeWatchedToken(tokenAddress, "drop_over_50_percent", now);
      return;
    }

    if (item.pullbackNumber === 1 &&
        dropPercent >= e.pullbackMinPercent &&
        dropPercent <= e.pullbackMaxPercent) {
      if (price <= item.firstPullbackLow) {
        removeWatchedToken(tokenAddress, "second_pullback_lower_low", now);
        return;
      }

      item.pullbackNumber = 2;
      item.pullbackPeak = item.recoveryPeak;
      item.pullbackLow = price;
      item.noNewLowSince = now;
      setWatchState(item, "PULLBACK", now);
    }
  }
}

async function getSafetyMetadata(tokenAddress) {
  const report = await getTokenReport(tokenAddress);
  if (!report || report.rugged !== false ||
      !Array.isArray(report.risks) ||
      !report.token || !Array.isArray(report.topHolders)) return null;

  const revoked = value => value === null || value === false || value === "";
  if (!revoked(report.token.mintAuthority) ||
      !revoked(report.token.freezeAuthority)) return null;

  const holders = report.topHolders.slice(0, 10);
  if (holders.length < 10 ||
      holders.some(holder => optionalNumber(holder?.pct) === null)) return null;

  const top10HolderPercent = holders.reduce(
    (sum, holder) => sum + Number(holder.pct),
    0
  );
  if (top10HolderPercent >= CONFIG.entry.maximumTop10HolderPercent) return null;

  const unsafeRisk = report.risks.some(risk => {
    const name = String(risk?.name || "").toLowerCase();
    const level = String(risk?.level || "").toLowerCase();
    return ["danger", "critical"].includes(level) ||
      /honeypot|blacklist|freeze authority|mint authority|transfer fee|high tax/.test(name);
  });
  if (unsafeRisk) return null;

  return {
    top10HolderPercent,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    rugCheckPassed: true
  };
}

function buildEntryTrigger(item, now) {
  if (!item || item.state !== "BASE" || !item.latestData) return null;

  const data = item.latestData;
  const current = item.samples[item.samples.length - 1];
  const e = CONFIG.entry;

  if (!current || current.price <= 0 ||
      !(item.pullbackPeak > 0) || !(item.pullbackLow > 0)) return null;

  const pairCreatedAt = optionalNumber(data.pairCreatedAt);
  const ageMinutes = pairCreatedAt === null
    ? NaN
    : (now - pairCreatedAt) / 60000;
  const liquidity = optionalNumber(data.liquidityUsd);
  const volume1h = optionalNumber(data.volume1h);
  const buys1h = optionalNumber(data.buys1h);
  const sells1h = optionalNumber(data.sells1h);

  if (!Number.isFinite(ageMinutes) ||
      ageMinutes < e.minimumAgeMinutes ||
      ageMinutes > e.maximumAgeHours * 60 ||
      liquidity === null || liquidity < e.minimumLiquidityUsd ||
      volume1h === null || volume1h < e.minimumVolume1hUsd ||
      buys1h === null || sells1h === null || buys1h <= sells1h) return null;

  const pullbackDepthPercent =
    (item.pullbackPeak - item.pullbackLow) / item.pullbackPeak * 100;
  if (pullbackDepthPercent < e.pullbackMinPercent ||
      pullbackDepthPercent > e.pullbackMaxPercent) return null;

  const riseFromLowPercent =
    (current.price - item.pullbackLow) / item.pullbackLow * 100;
  if (riseFromLowPercent < e.triggerRisePercent) return null;

  const fullDrop = item.pullbackPeak - item.pullbackLow;
  if (!(fullDrop > 0)) return null;
  const recoveryPercent =
    (current.price - item.pullbackLow) / fullDrop * 100;
  if (recoveryPercent > e.maximumRecoveryPercent) return null;

  if (current.buys5m === null || current.sells5m === null ||
      current.buys5m <= current.sells5m ||
      current.volume5m === null || current.volume5m <= 0) return null;

  const previousWindowAt = current.at - 5 * 60 * 1000;
  const allowedSampleDriftMs =
    e.watchlistPollIntervalSeconds * 2000;
  const previousSample = item.samples
    .filter(sample => sample.at < current.at &&
      sample.volume5m !== null && sample.volume5m > 0)
    .sort((a, b) =>
      Math.abs(a.at - previousWindowAt) -
      Math.abs(b.at - previousWindowAt)
    )[0];

  if (!previousSample ||
      Math.abs(previousSample.at - previousWindowAt) > allowedSampleDriftMs ||
      current.volume5m < previousSample.volume5m * e.volumeSurgeMultiplier) {
    return null;
  }

  return {
    ...data,
    tokenAddress: item.tokenAddress,
    priceUsd: current.price,
    volume5m: current.volume5m,
    buys5m: current.buys5m,
    sells5m: current.sells5m,
    signal: "BUY",
    score: 1,
    reasons: [
      "v3.2-momentum pullback recovery confirmed",
      "Price is " + riseFromLowPercent.toFixed(1) + "% above pullback low",
      "5m volume is at least " + e.volumeSurgeMultiplier + "x the prior 5m window"
    ],
    pullbackLowUsd: item.pullbackLow,
    pullbackPeakUsd: item.pullbackPeak,
    triggerPriceUsd: current.price,
    pullbackDepthPercent,
    triggerRecoveryPercent: recoveryPercent
  };
}

async function pollWatchlist({ signal } = {}) {
  if (watchlistPollBusy || watchlist.size === 0) return;
  watchlistPollBusy = true;

  try {
    const now = Date.now();
    const addresses = [...watchlist.keys()];
    const dataByAddress = await market.getTokensData(addresses, { signal });
    if (signal?.aborted) return;

    for (const tokenAddress of addresses) {
      const item = watchlist.get(tokenAddress);
      if (!item) continue;

      const data = dataByAddress.get(tokenAddress);
      if (!data || optionalNumber(data.priceUsd) === null) {
        item.triggerCandidate = null;
        continue;
      }

      updateWatchedToken(tokenAddress, data, now);
      const stillWatching = watchlist.get(tokenAddress);
      if (!stillWatching) continue;

      const latestSample = stillWatching.samples[stillWatching.samples.length - 1];
      if (!latestSample || latestSample.at !== now) {
        stillWatching.triggerCandidate = null;
        continue;
      }

      const trigger = buildEntryTrigger(stillWatching, now);
      if (!trigger) {
        stillWatching.triggerCandidate = null;
        continue;
      }

      if (!stillWatching.triggerSafety ||
          now - stillWatching.triggerSafetyCheckedAt >=
            CONFIG.entry.safetyRecheckSeconds * 1000) {
        const safety = await getSafetyMetadata(tokenAddress);
        if (!safety) {
          removeWatchedToken(tokenAddress, "entry_safety_recheck_failed", now);
          continue;
        }
        stillWatching.triggerSafety = safety;
        stillWatching.triggerSafetyCheckedAt = now;
      }

      stillWatching.triggerCandidate = {
        ...trigger,
        ...stillWatching.triggerSafety
      };
    }
  } finally {
    watchlistPollBusy = false;
  }
}

async function checkEntryFilters(data, token) {
  const now = Date.now();
  const tokenAddress = token?.tokenAddress;
  const pairAddress = data?.pairAddress;
  const price = optionalNumber(data?.priceUsd);
  const pairCreatedAt = optionalNumber(data?.pairCreatedAt);
  const ageMinutes = pairCreatedAt === null
    ? NaN
    : (now - pairCreatedAt) / 60000;

  if (!tokenAddress || !pairAddress || !(price > 0) ||
      !Number.isFinite(ageMinutes) ||
      ageMinutes < CONFIG.entry.minimumAgeMinutes ||
      ageMinutes > CONFIG.entry.maximumAgeHours * 60) return false;

  if (watchlist.has(tokenAddress)) return false;

  const liquidity = optionalNumber(data.liquidityUsd);
  const volume1h = optionalNumber(data.volume1h);
  const buys1h = optionalNumber(data.buys1h);
  const sells1h = optionalNumber(data.sells1h);

  if (liquidity === null || volume1h === null ||
      buys1h === null || sells1h === null ||
      liquidity < CONFIG.entry.minimumLiquidityUsd ||
      volume1h < CONFIG.entry.minimumVolume1hUsd ||
      buys1h <= sells1h) return false;

  const safety = await getSafetyMetadata(tokenAddress);
  if (!safety) return false;

  Object.assign(data, safety);
  addWatchedToken(tokenAddress, data, now);
  return false;
}

let lastFullCandidateScanAt = 0;

async function discoverBuyPriorityCandidates(options = {}) {
  await pollWatchlist(options);
  const now = Date.now();
  let candidates = [];

  if (now - lastFullCandidateScanAt >=
      CONFIG.entry.discoveryRefreshSeconds * 1000) {
    lastFullCandidateScanAt = now;
    candidates = await scanner.discoverCandidates({
      ...options,
      minimumLiquidityUsd: CONFIG.entry.minimumLiquidityUsd,
      minimumVolume24hUsd: 0,
      candidateFilter: checkEntryFilters,
      analyzeCandidate: () => ({
        score: 1,
        signal: "BUY",
        reasons: ["v3.2-momentum watchlist admission filters passed"]
      })
    });
  }

  const portfolio = trader.getPortfolio();
  const openTokenAddresses = new Set(
    (Array.isArray(portfolio.positions) ? portfolio.positions : [])
      .map(position => position.tokenAddress)
  );

  for (const tokenAddress of openTokenAddresses) {
    if (watchlist.has(tokenAddress)) {
      removeWatchedToken(tokenAddress, "position_opened", now);
    }
  }

  const readyCandidates = [...watchlist.values()]
    .map(item => item.triggerCandidate)
    .filter(candidate => candidate && !openTokenAddresses.has(candidate.tokenAddress));

  const unique = new Map();
  for (const candidate of [...candidates, ...readyCandidates]) {
    if (candidate?.tokenAddress) unique.set(candidate.tokenAddress, candidate);
  }

  return [...unique.values()].map(candidate => {
    const sizing = getBuySizing(portfolio, candidate);
    return {
      ...candidate,
      reasons: [
        ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
        "v3.2-momentum"
      ],
      experimentEntry: {
        strategy: "v3.2-momentum",
        pullbackLowUsd: Number(candidate.pullbackLowUsd),
        pullbackPeakUsd: Number(candidate.pullbackPeakUsd),
        triggerPriceUsd: Number(candidate.triggerPriceUsd),
        pullbackDepthPercent: Number(candidate.pullbackDepthPercent),
        triggerRecoveryPercent: Number(candidate.triggerRecoveryPercent),
        compoundRatePercent: sizing.compoundRate * 100,
        estimatedCostModel: {
          label: "Estimated paper execution costs",
          tradeSizeUsd: Number(sizing.amountInvested.toFixed(2)),
          entryLiquidityUsd: Number(candidate.liquidityUsd),
          estimatedEntryImpactPercent:
            estimatedImpactPercent(sizing.amountInvested, candidate.liquidityUsd),
          assumedPoolFeePercentPerSwap: CONFIG.estimatedCosts.poolFeePercentPerSwap,
          estimatedSolanaNetworkFeeUsdPerSwap: CONFIG.estimatedCosts.solanaFeeUsdPerSwap,
          estimatedPriorityFeeUsdPerSwap: CONFIG.estimatedCosts.priorityFeeUsdPerSwap
        }
      }
    };
  });
}

function evaluateExit({ position, currentPrice, now = Date.now() }) {
  const entry = Number(position.entryPrice);
  const high = Number(position.highestPrice || entry);
  const profitPercent = (currentPrice - entry) / entry * 100;
  const highProfitPercent = (high - entry) / entry * 100;
  const holdMinutes = Math.max(0, (now - new Date(position.entryTime).getTime()) / 60000);
  const dropFromHigh = high > 0 ? (high - currentPrice) / high * 100 : 0;

  if (position.secondTakeProfitDone && dropFromHigh >= CONFIG.exit.trailingStopPercent) {
    return { reason: "TRAILING STOP " + CONFIG.exit.trailingStopPercent + "%", percent: 100 };
  }
  if (!position.secondTakeProfitDone &&
      highProfitPercent >= CONFIG.exit.breakevenTriggerPercent &&
      profitPercent <= 0) {
    return { reason: "BREAKEVEN STOP", percent: 100 };
  }

  const pullbackLow = Number(position.experimentEntry?.pullbackLowUsd);
  const pullbackStopPrice = pullbackLow > 0
    ? pullbackLow * (1 - CONFIG.entry.pullbackStopBelowLowPercent / 100)
    : NaN;
  const hardStopPrice = entry * (1 - CONFIG.exit.stopLossPercent / 100);
  const activeStopPrice = Number.isFinite(pullbackStopPrice)
    ? Math.max(pullbackStopPrice, hardStopPrice)
    : hardStopPrice;

  if (currentPrice <= activeStopPrice) {
    const reason = Number.isFinite(pullbackStopPrice) &&
      pullbackStopPrice > hardStopPrice
      ? "PULLBACK LOW STOP -" + CONFIG.entry.pullbackStopBelowLowPercent + "%"
      : "STOP LOSS -" + CONFIG.exit.stopLossPercent + "%";
    return { reason, percent: 100 };
  }

  if (holdMinutes >= CONFIG.exit.timeStopMinutes &&
      highProfitPercent < CONFIG.exit.minimumGainAtTimeStopPercent) {
    return { reason: "TIME STOP 15M", percent: 100 };
  }
  if (profitPercent >= CONFIG.exit.firstTargetPercent && !position.firstTakeProfitDone) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.firstTargetPercent + "% SELL " + CONFIG.exit.firstTargetOriginalPositionPercent + "%",
      percent: CONFIG.exit.firstTargetOriginalPositionPercent,
      takeProfit: "firstTakeProfitDone"
    };
  }
  if (profitPercent >= CONFIG.exit.secondTargetPercent &&
      position.firstTakeProfitDone && !position.secondTakeProfitDone) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.secondTargetPercent + "% SELL " + CONFIG.exit.secondTargetOriginalPositionPercent + "%",
      percent: CONFIG.exit.secondTargetOriginalPositionPercent /
        (100 - CONFIG.exit.firstTargetOriginalPositionPercent) * 100,
      takeProfit: "secondTakeProfitDone"
    };
  }
  return null;
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: message => telegram.notifyCritical(message)
};

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  discoverCandidates: discoverBuyPriorityCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  botLabel: BOT_LABEL,
  reentryStateFile: statePath("v31BuyPriorityTestReentryState.json"),
  maxOpenPositions: CONFIG.capital.maxOpenPositions,
  scannerIntervalMs: CONFIG.entry.watchlistPollIntervalSeconds * 1000,
  requireLiquidityLock: false,
  useReentryGuards: true,
  exitDecision: evaluateExit,
  pauseEntriesAtBalance: CONFIG.capital.pauseAtBalanceUsd,
  entryPauseStateFile: statePath("v31BuyPriorityTestEntryPause.json")
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount
};

function buildDashboardAccount() {
  const account = trader.getPortfolio();
  const history = Array.isArray(account.history) ? account.history.map(row => {
    if (row.type !== "SELL") return row;
    return {
      ...row,
      grossPnl: Number(row.grossPnl ?? row.pnl ?? 0),
      netPnl: Number(row.netPnl ?? row.pnl ?? 0),
      estimatedFeesUsd: Number(row.estimatedFeesUsd || 0),
      estimatedSlippageUsd: Number(row.estimatedSlippageUsd || 0),
      estimatedCostUsd: Number(row.estimatedCostUsd || 0),
      costEstimateAvailable: true
    };
  }) : [];
  return {
    ...account,
    label: BOT_LABEL,
    history,
    positions: account.positions || [],
    position: (account.positions || [])[0] || null,
    completedTrades: [],
    stats: null,
    running: bot.getBotStatus(),
    entriesPaused: bot.getEntriesPaused(),
    costModel: {
      label: "Estimated paper execution costs",
      poolFeePercentPerSwap: CONFIG.estimatedCosts.poolFeePercentPerSwap,
      solanaFeeUsdPerSwap: CONFIG.estimatedCosts.solanaFeeUsdPerSwap,
      priorityFeeUsdPerSwap: CONFIG.estimatedCosts.priorityFeeUsdPerSwap,
      slippageMethod: "Approximate constant-product impact using DexScreener liquidity",
      warning: "All costs are estimates; real swap routes, fees, priority fees and fills can differ."
    }
  };
}
