const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { analyzeToken } = require("./strategy");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot");
const { getLockStatus, getTokenReport } = require("./lpLockChecker");
const telegram = require("./telegram");

const BOT_LABEL = "New Claude Strategy";
const STRATEGY_VERSION = "v3.2-momentum";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const CONFIG = Object.freeze({
 capital:{startingUsd:100,maxOpenPositions:4,compoundRates:[0.10,0.125,0.15],minimumTradeUsd:10,maximumLiquidityFraction:0.01,pauseAtBalanceUsd:70},
 entry:{minimumAgeMinutes:30,maximumAgeHours:48,minimumLiquidityUsd:20000,minimumVolume1hUsd:10000,maximumTop10HolderPercent:30,minimumSellQuotePercent:90,watchlistMaxTokens:20,watchlistPollIntervalSeconds:15,watchlistTimeoutMinutes:90,priceHistoryRetentionMinutes:12,volumeWindowMinutes:5,sampleTimeDriftIntervals:2,discoveryRefreshSeconds:120,safetyRecheckSeconds:120,stopLossCooldownHours:24,permanentStopLossPercent:25,initialBreakoutRisePercent:8,baseBreakdownPercent:3,baseNoNewLowMinutes:3,reentryMinGivebackPercent:25,reentryMaxGivebackPercent:50,reentryTriggerRisePercent:4,volumeSurgeMultiplier:1.5,maximumRecoveryPercent:70,baseStopBelowLowPercent:3},
 exit:{stopLossPercent:15,breakevenTriggerPercent:15,firstTargetPercent:25,firstTargetOriginalPositionPercent:40,secondTargetPercent:60,secondTargetOriginalPositionPercent:30,trailingStopPercent:20,timeStopMinutes:15,minimumGainAtTimeStopPercent:5,maximumHoldMinutes:60,liquidityDropPercent:30,stalePriceDataMs:30000},
 estimatedCosts:{poolFeePercentPerSwap:0.30,solanaFeeUsdPerSwap:0.01,priorityFeeUsdPerSwap:0.01},
 logging:{rejectedTokenCooldownSeconds:300,maxRejectedLogEntries:1000,maxWatchlistRemovalEvents:200}
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

function getSizingCycleStartedAt() {
 const file=statePath("v31BuyPriorityTestSizingCycle.json");
 try {
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  const startedAt=Date.parse(saved.startedAt);
  if(Number.isFinite(startedAt)) return startedAt;
  throw new Error("Sizing cycle state has no valid start time.");
 } catch(error) {
  if(error.code!=="ENOENT") throw error;
 }
 const startedAt=new Date().toISOString();
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({startedAt})+"\n");
 return Date.parse(startedAt);
}
function nextCompoundRate(portfolio) {
 const rates=CONFIG.capital.compoundRates;
 const startedAt=getSizingCycleStartedAt();
 const successfulBuys=(Array.isArray(portfolio.history)?portfolio.history:[]).filter(row=>
  row?.type==="BUY" &&
  row?.strategyVersion===STRATEGY_VERSION &&
  Date.parse(row.entryTime||row.timestamp||row.time||"")>=startedAt
 );
 return rates[successfulBuys.length%rates.length];
}
function getBuySizing(portfolio,coin={}){
 const positions=Array.isArray(portfolio.positions)?portfolio.positions:[];
 const realizedBalance=Number(portfolio.cashBalance||0)+positions.reduce((s,p)=>s+(Number(p.amountInvested)||0),0);
 const cash=Number(portfolio.cashBalance)||0,liquidityCap=Number(coin.liquidityUsd)*CONFIG.capital.maximumLiquidityFraction;
 const compoundRate=nextCompoundRate(portfolio);
 const requested=Math.max(realizedBalance*compoundRate,CONFIG.capital.minimumTradeUsd),amountInvested=Math.min(requested,cash,liquidityCap);
 return {compoundRate,amountInvested:Number.isFinite(amountInvested)?amountInvested:0};
}

const trader = createPaperTrader(
  statePath("v31BuyPriorityTestTradingData.json"),
  fs,
  {
    strategyVersion: STRATEGY_VERSION,
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

const rejectedTokenLogTimes = new Map();

function logPrice(value) {
  const number = optionalNumber(value);
  return number === null ? "n/a" : number.toExponential(6);
}

function logUsd(value) {
  const number = optionalNumber(value);
  return number === null ? "n/a" : "$" + number.toFixed(2);
}

function logWatchEvent(item, event, now, details = {}) {
  const peak = item.pullbackPeak ?? item.pumpPeak;
  const low = item.pullbackLow ?? item.firstPullbackLow ?? item.secondPullbackLow;
  const trigger = details.triggerPriceUsd ??
    item.lastTriggerPriceUsd ??
    item.triggerCandidate?.triggerPriceUsd;
  const states = (item.statesReached || []).map(row => row.state).join(">");

  console.info(
    "V3.2-MOMENTUM | " + event +
    " | token=" + item.tokenAddress +
    " | state=" + (item.state || "REMOVED") +
    " | states=" + (states || "none") +
    " | peak=" + logPrice(peak) +
    " | pullback_low=" + logPrice(low) +
    " | trigger_price=" + logPrice(trigger) +
    (details.reason ? " | reason=" + details.reason : "")
  );
}

function rejectToken(tokenAddress, reason, now = Date.now()) {
  const address = tokenAddress || "unknown";
  const key = address + "|" + reason;
  const previousAt = rejectedTokenLogTimes.get(key);

  if (previousAt &&
      now - previousAt <
        CONFIG.logging.rejectedTokenCooldownSeconds * 1000) return false;

  rejectedTokenLogTimes.set(key, now);
  if (rejectedTokenLogTimes.size > CONFIG.logging.maxRejectedLogEntries) {
    const oldestKey = rejectedTokenLogTimes.keys().next().value;
    if (oldestKey) rejectedTokenLogTimes.delete(oldestKey);
  }

  console.info(
    "V3.2-MOMENTUM | REJECTED | token=" + address +
    " | reason=" + reason
  );
  return false;
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
  logWatchEvent(item, "STATE:" + state, now);
}

function removeWatchedToken(tokenAddress, reason, now = Date.now()) {
  const item = watchlist.get(tokenAddress);
  if (!item) return;

  logWatchEvent(item, "REMOVED", now, {
    reason,
    triggerPriceUsd: item.triggerCandidate?.triggerPriceUsd
  });
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

  if (watchlistRemovalEvents.length > CONFIG.logging.maxWatchlistRemovalEvents) watchlistRemovalEvents.shift();
}

function addWatchedToken(tokenAddress, data, now = Date.now(), reentryContext = { isReentry: false }) {
  const blockedUntil = recentlyRemovedTokens.get(tokenAddress);
  if (blockedUntil && blockedUntil > now && !reentryContext?.isReentry) return false;
  if (blockedUntil) recentlyRemovedTokens.delete(tokenAddress);
  if (watchlist.has(tokenAddress)) return false;

  if (watchlist.size >= CONFIG.entry.watchlistMaxTokens) {
    const oldest = [...watchlist.entries()]
      .sort((a, b) => a[1].admittedAt - b[1].admittedAt)[0];
    if (oldest) removeWatchedToken(oldest[0], "watchlist_full_oldest_evicted", now);
  }

  const price = optionalNumber(data.priceUsd);
  if (!(price > 0)) return false;

  const isReentry = Boolean(reentryContext?.isReentry);
  const item = {
    tokenAddress,
    pairAddress: data.pairAddress,
    admittedAt: now,
    state: isReentry ? "REENTRY_PULLBACK" : "WATCH",
    statesReached: [{ state: isReentry ? "REENTRY_PULLBACK" : "WATCH", at: now }],
    lowSinceWatching: price,
    initialBaseLowUsd: null,
    pumpPeak: price,
    pullbackNumber: 0,
    pullbackPeak: isReentry ? reentryContext.previousPeakUsd : null,
    pullbackLow: isReentry ? price : null,
    firstPullbackLow: null,
    secondPullbackLow: null,
    noNewLowSince: isReentry ? now : null,
    recoveryPeak: null,
    reentryContext: isReentry ? { ...reentryContext } : null,
    isReentry,
    samples: [],
    lastPrice: price,
    lastSampleAt: now,
    triggerCandidate: null,
    triggerSafety: null,
    triggerSafetyCheckedAt: 0
  };

  recordWatchSample(item, data, now);
  watchlist.set(tokenAddress, item);
  logWatchEvent(item, "STATE:" + item.state, now, {
    reason: isReentry ? "one_profitable_reentry_setup" : "admitted"
  });
  return true;
}

function updateWatchedToken(tokenAddress, data, now = Date.now()) {
  const item = watchlist.get(tokenAddress);
  if (!item) return;

  if (now - item.admittedAt >= CONFIG.entry.watchlistTimeoutMinutes * 60000) {
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
    if (price >= item.lowSinceWatching * (1 + e.initialBreakoutRisePercent / 100)) {
      item.initialBaseLowUsd = item.lowSinceWatching;
      item.pullbackLow = item.initialBaseLowUsd;
      item.pumpPeak = price;
      setWatchState(item, "BREAKOUT", now);
    }
    return;
  }

  if (item.state === "BREAKOUT") {
    item.pumpPeak = Math.max(item.pumpPeak || price, price);
    if (price <= item.initialBaseLowUsd * (1 - e.baseBreakdownPercent / 100)) {
      removeWatchedToken(tokenAddress, "breakout_failed_below_base", now);
    }
    return;
  }

  if (item.state === "REENTRY_PULLBACK") {
    const context = item.reentryContext;
    if (!context || !(context.previousGainUsd > 0)) {
      removeWatchedToken(tokenAddress, "reentry_context_missing", now);
      return;
    }
    const givebackPercent =
      (context.previousPeakUsd - price) / context.previousGainUsd * 100;
    if (price <= context.previousBaseLowUsd) {
      removeWatchedToken(tokenAddress, "reentry_not_a_higher_low", now);
      return;
    }
    if (givebackPercent > e.reentryMaxGivebackPercent) {
      removeWatchedToken(tokenAddress, "reentry_pullback_too_deep", now);
      return;
    }
    if (givebackPercent < e.reentryMinGivebackPercent) {
      removeWatchedToken(tokenAddress, "reentry_pullback_recovered_before_base", now);
      return;
    }
    if (price < item.pullbackLow) {
      item.pullbackLow = price;
      item.noNewLowSince = now;
    }
    item.pumpPeak = Math.max(item.pumpPeak || price, price);
    if (now - item.noNewLowSince >= e.baseNoNewLowMinutes * 60000) {
      item.firstPullbackLow = item.pullbackLow;
      item.pullbackNumber = 1;
      setWatchState(item, "REENTRY_BASE", now);
    }
    return;
  }

  if (item.state === "REENTRY_BASE") {
    const context = item.reentryContext;
    if (price < item.pullbackLow) {
      removeWatchedToken(tokenAddress, "reentry_lower_low", now);
      return;
    }
    const givebackPercent =
      (context.previousPeakUsd - price) / context.previousGainUsd * 100;
    if (givebackPercent > e.reentryMaxGivebackPercent) {
      removeWatchedToken(tokenAddress, "reentry_pullback_too_deep", now);
    }
  }
}

async function getSafetyMetadata(tokenAddress) {
  const report = await getTokenReport(tokenAddress);
  if (!report || report.rugged !== false ||
      !Array.isArray(report.risks) ||
      !report.token || !Array.isArray(report.topHolders)) {
    return { passed: false, reason: "RUGCHECK_REPORT_MISSING_OR_FAILED" };
  }

  const revoked = value => value === null || value === false || value === "";
  if (!revoked(report.token.mintAuthority) ||
      !revoked(report.token.freezeAuthority)) {
    return { passed: false, reason: "MINT_OR_FREEZE_AUTHORITY_NOT_REVOKED" };
  }

  const holders = report.topHolders.slice(0, 10);
  if (holders.length < 10 ||
      holders.some(holder => optionalNumber(holder?.pct) === null)) {
    return { passed: false, reason: "TOP10_HOLDER_DATA_MISSING" };
  }

  const top10HolderPercent = holders.reduce(
    (sum, holder) => sum + Number(holder.pct),
    0
  );
  if (top10HolderPercent >= CONFIG.entry.maximumTop10HolderPercent) {
    return { passed: false, reason: "TOP10_HOLDERS_AT_OR_ABOVE_LIMIT" };
  }

  const unsafeRisk = report.risks.some(risk => {
    const name = String(risk?.name || "").toLowerCase();
    const level = String(risk?.level || "").toLowerCase();
    return ["danger", "critical"].includes(level) ||
      /honeypot|blacklist|freeze authority|mint authority|transfer fee|high tax/.test(name);
  });
  if (unsafeRisk) {
    return { passed: false, reason: "RUGCHECK_UNSAFE_RISK" };
  }

  return {
    passed: true,
    metadata: {
      top10HolderPercent,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      rugCheckPassed: true
    }
  };
}

function classifyHybridEntry(data) {
  const analysis = analyzeToken(data);
  return {
    score: Number(analysis.score) || 0,
    signal: analysis.signal === "STRONG BUY" ? "STRONG BUY" : "BUY",
    sourceSignal: analysis.signal,
    reasons: Array.isArray(analysis.reasons) ? analysis.reasons : []
  };
}

function buildEntryTrigger(item, now) {
  if (!item || !["BREAKOUT", "REENTRY_BASE"].includes(item.state) ||
      !item.latestData) return null;

  const data = item.latestData;
  const current = item.samples[item.samples.length - 1];
  const e = CONFIG.entry;
  const isReentry = item.state === "REENTRY_BASE";
  const baseLow = isReentry ? item.pullbackLow : item.initialBaseLowUsd;
  const requiredRisePercent = isReentry
    ? e.reentryTriggerRisePercent
    : e.initialBreakoutRisePercent;

  if (!current || current.price <= 0 || !(baseLow > 0)) return null;

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

  const riseFromBasePercent = (current.price - baseLow) / baseLow * 100;
  if (riseFromBasePercent < requiredRisePercent) return null;

  let reentryGivebackPercent = null;
  let recoveryPercent = null;
  if (isReentry) {
    const context = item.reentryContext;
    const fullDrop = context.previousPeakUsd - item.pullbackLow;
    if (!(fullDrop > 0)) return null;
    reentryGivebackPercent =
      (context.previousPeakUsd - item.pullbackLow) /
      context.previousGainUsd * 100;
    if (reentryGivebackPercent < e.reentryMinGivebackPercent ||
        reentryGivebackPercent > e.reentryMaxGivebackPercent) return null;
    recoveryPercent =
      (current.price - item.pullbackLow) / fullDrop * 100;
    if (recoveryPercent > e.maximumRecoveryPercent) return null;
  }

  if (current.buys5m === null || current.sells5m === null ||
      current.buys5m <= current.sells5m ||
      current.volume5m === null || current.volume5m <= 0) return null;

  const previousWindowAt = current.at - e.volumeWindowMinutes * 60000;
  const allowedSampleDriftMs =
    e.watchlistPollIntervalSeconds * e.sampleTimeDriftIntervals * 1000;
  const previousSample = item.samples
    .filter(sample => sample.at < current.at &&
      sample.volume5m !== null && sample.volume5m > 0)
    .sort((a, b) =>
      Math.abs(a.at - previousWindowAt) - Math.abs(b.at - previousWindowAt)
    )[0];

  if (!previousSample ||
      Math.abs(previousSample.at - previousWindowAt) > allowedSampleDriftMs ||
      current.volume5m < previousSample.volume5m * e.volumeSurgeMultiplier) return null;

  const entryAnalysis = classifyHybridEntry({
    ...data,
    priceChange5m: optionalNumber(data.priceChange5m),
    priceChange1h: optionalNumber(data.priceChange1h),
    priceChange24h: optionalNumber(data.priceChange24h),
    buys5m: current.buys5m,
    sells5m: current.sells5m
  });
  return {
    ...data,
    tokenAddress: item.tokenAddress,
    priceUsd: current.price,
    volume5m: current.volume5m,
    buys5m: current.buys5m,
    sells5m: current.sells5m,
    signal: entryAnalysis.signal,
    score: entryAnalysis.score,
    reasons: [
      STRATEGY_VERSION + (isReentry ? " profitable re-entry confirmed" : " early momentum breakout confirmed"),
      entryAnalysis.signal === "STRONG BUY"
        ? "STRONG BUY priority: existing V3.1 score and confirmation rules passed"
        : "BUY fallback: current entry and safety filters passed; Strong Buy was not required",
      ...entryAnalysis.reasons,
      "Price is " + riseFromBasePercent.toFixed(1) + "% above the " +
        (isReentry ? "higher pullback low" : "watched base low"),
      "5m volume is at least " + e.volumeSurgeMultiplier + "x the prior 5m window"
    ],
    entryMode: isReentry ? "PROFITABLE_REENTRY" : "EARLY_BREAKOUT",
    baseLowUsd: baseLow,
    previousPeakUsd: isReentry ? item.reentryContext.previousPeakUsd : null,
    reentryGivebackPercent,
    breakoutRisePercent: riseFromBasePercent,
    triggerPriceUsd: current.price,
    pullbackLowUsd: isReentry ? item.pullbackLow : null,
    pullbackPeakUsd: isReentry ? item.reentryContext.previousPeakUsd : null,
    pullbackDepthPercent: isReentry ? reentryGivebackPercent : null,
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
        if (!safety?.passed) {
          removeWatchedToken(
            tokenAddress,
            "entry_safety_recheck_failed:" + (safety?.reason || "unknown"),
            now
          );
          continue;
        }
        stillWatching.triggerSafety = safety.metadata;
        stillWatching.triggerSafetyCheckedAt = now;
      }

      if (!stillWatching.triggerCandidate) {
        stillWatching.lastTriggerPriceUsd = trigger.triggerPriceUsd;
        stillWatching.statesReached.push({
          state: "TRIGGER",
          at: now,
          price: trigger.triggerPriceUsd
        });
        logWatchEvent(stillWatching, "TRIGGER", now, {
          triggerPriceUsd: trigger.triggerPriceUsd
        });
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
const stageFile = statePath("v31BuyPriorityTestProfitStages.json");
const auditFile = statePath("v31BuyPriorityTestExitAudit.jsonl");
function readStages() {
  if (!fs.existsSync(stageFile)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(stageFile, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.stages || typeof parsed.stages !== "object" || Array.isArray(parsed.stages)) {
    throw new Error("Invalid v3.2-momentum profit-stage state; saved state was not reset.");
  }
  return new Map(Object.entries(parsed.stages).map(([id, value]) => [id, Number(value)]));
}
const profitStages = readStages();
function persistStages() {
  fs.mkdirSync(path.dirname(stageFile), { recursive: true });
  const temp = stageFile + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, stages: Object.fromEntries(profitStages) }, null, 2), { flag: "wx", flush: true });
    fs.renameSync(temp, stageFile);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function getPositionStage(position) {
  if (profitStages.has(position.id)) return Number(profitStages.get(position.id)) || 0;
  const rows = (trader.getPortfolio().history || []).filter(row => row.type === "SELL" && row.positionId === position.id);
  const completed = rows.filter(row => String(row.reason || "").startsWith("TAKE PROFIT +")).length;
  if (completed) return Math.min(3, completed);
  if (position.firstTakeProfitDone) return position.secondTakeProfitDone ? 3 : 1;
  return 0;
}

const recentPriceObservations = new Map();
async function checkEntryFilters(data, token) {
  const now = Date.now();
  const tokenAddress = token?.tokenAddress;
  const pairAddress = data?.pairAddress;
  const price = optionalNumber(data?.priceUsd);
  const pairCreatedAt = optionalNumber(data?.pairCreatedAt);

  if (!tokenAddress || !pairAddress || price === null || !(price > 0)) {
    return rejectToken(tokenAddress, "MISSING_PRICE_OR_PAIR_DATA", now);
  }
  if (pairCreatedAt === null) {
    return rejectToken(tokenAddress, "PAIR_AGE_DATA_MISSING", now);
  }

  const ageMinutes = (now - pairCreatedAt) / 60000;
  if (ageMinutes < CONFIG.entry.minimumAgeMinutes ||
      ageMinutes > CONFIG.entry.maximumAgeHours * 60) {
    return rejectToken(tokenAddress, "PAIR_AGE_OUTSIDE_30M_TO_48H", now);
  }
  if (watchlist.has(tokenAddress)) return false;

  const liquidity = optionalNumber(data.liquidityUsd);
  const volume1h = optionalNumber(data.volume1h);
  const buys1h = optionalNumber(data.buys1h);
  const sells1h = optionalNumber(data.sells1h);
  if (liquidity === null || volume1h === null ||
      buys1h === null || sells1h === null) {
    return rejectToken(tokenAddress, "REQUIRED_MARKET_DATA_MISSING", now);
  }
  if (liquidity < CONFIG.entry.minimumLiquidityUsd) {
    return rejectToken(tokenAddress, "LIQUIDITY_BELOW_MINIMUM", now);
  }
  if (volume1h < CONFIG.entry.minimumVolume1hUsd) {
    return rejectToken(tokenAddress, "ONE_HOUR_VOLUME_BELOW_MINIMUM", now);
  }
  if (buys1h <= sells1h) {
    return rejectToken(tokenAddress, "ONE_HOUR_BUYS_NOT_ABOVE_SELLS", now);
  }

  const reentryContext = getEligibleReentryContext(tokenAddress);
  if (!reentryContext) {
    return rejectToken(tokenAddress, "DO_NOT_REENTER_UNPROFITABLE_OR_REENTERED_TOKEN", now);
  }
  if (reentryContext.isReentry) {
    const givebackPercent =
      (reentryContext.previousPeakUsd - price) /
      reentryContext.previousGainUsd * 100;
    if (price <= reentryContext.previousBaseLowUsd ||
        givebackPercent < CONFIG.entry.reentryMinGivebackPercent ||
        givebackPercent > CONFIG.entry.reentryMaxGivebackPercent) {
      return rejectToken(tokenAddress, "REENTRY_PRICE_OUTSIDE_PULLBACK_BAND", now);
    }
  }

  const safety = await getSafetyMetadata(tokenAddress);
  if (!safety?.passed) {
    return rejectToken(tokenAddress, safety?.reason || "SAFETY_CHECK_FAILED", now);
  }

  Object.assign(data, safety.metadata);
  if (!addWatchedToken(tokenAddress, data, now, reentryContext)) {
    return rejectToken(tokenAddress, "RECENTLY_REMOVED_FROM_WATCHLIST", now);
  }
  return false;
}

function getEligibleReentryContext(tokenAddress, portfolio = trader.getPortfolio()) {
  const history = Array.isArray(portfolio.history) ? portfolio.history : [];
  const buys = history.filter(row =>
    row?.type === "BUY" &&
    row.tokenAddress === tokenAddress &&
    row.strategyVersion === STRATEGY_VERSION &&
    ["EARLY_BREAKOUT", "PROFITABLE_REENTRY"].includes(row.experimentEntry?.entryMode)
  );
  if (buys.length === 0) return { isReentry: false };
  if (buys.length !== 1) return null;

  const buy = buys[0];
  const sells = history.filter(row =>
    row?.type === "SELL" && row.positionId === buy.positionId
  );
  const finalSell = [...sells].reverse().find(row => Number(row.percentSold) === 100);
  if (!finalSell) return null;
  const netPnl = sells.reduce((sum, row) =>
    sum + (Number(row.netPnl ?? row.pnl) || 0), 0);
  if (!(netPnl > 0) ||
      !/TAKE PROFIT|TRAILING STOP/i.test(String(finalSell.reason || ""))) {
    return null;
  }

  const previousBaseLowUsd = optionalNumber(buy.experimentEntry?.baseLowUsd);
  const previousPeakUsd = Math.max(
    Number(buy.highestPrice) || 0,
    ...sells.map(row => Number(row.highestPrice) || 0)
  );
  const previousGainUsd = previousPeakUsd - previousBaseLowUsd;
  if (!(previousBaseLowUsd > 0) || !(previousGainUsd > 0)) return null;

  return {
    isReentry: true,
    previousBaseLowUsd,
    previousPeakUsd,
    previousGainUsd,
    previousPositionId: buy.positionId
  };
}



function getRecentStopLossGuards(portfolio, now = Date.now()) {
  const openIds = new Set((portfolio.positions || []).map(position => position.id));
  const entries = new Map();
  const sells = new Map();
  for (const row of Array.isArray(portfolio.history) ? portfolio.history : []) {
    if (!row?.positionId) continue;
    if (row.type === "BUY") entries.set(row.positionId, row);
    if (row.type === "SELL") {
      const rows = sells.get(row.positionId) || [];
      rows.push(row);
      sells.set(row.positionId, rows);
    }
  }
  const guards = new Map();
  for (const [positionId, rows] of sells) {
    if (openIds.has(positionId)) continue;
    const final = [...rows].reverse().find(row => Number(row.percentSold) === 100);
    if (!final || !/STOP LOSS|PULLBACK LOW STOP|BASE LOW STOP/i.test(String(final.reason || ""))) continue;
    const closedAt = Date.parse(final.exitTime || final.timestamp || final.createdAt);
    if (!Number.isFinite(closedAt)) continue;
    const entry = entries.get(positionId);
    const initialAmount = Number(entry?.amountInvested) || 0;
    const netPnl = rows.reduce((sum, row) => sum + Number(row.netPnl ?? row.pnl ?? 0), 0);
    const lossPercent = initialAmount > 0 ? netPnl / initialAmount * 100 : 0;
    if (lossPercent < -CONFIG.entry.permanentStopLossPercent || now - closedAt < CONFIG.entry.stopLossCooldownHours * 60 * 60 * 1000) {
      const prior = guards.get(final.tokenAddress);
      guards.set(final.tokenAddress, {
        permanent: lossPercent < -CONFIG.entry.permanentStopLossPercent || Boolean(prior?.permanent),
        until: Math.max(Number(prior?.until) || 0, closedAt + CONFIG.entry.stopLossCooldownHours * 60 * 60 * 1000),
        lossPercent
      });
    }
  }
  return guards;
}

const decimalsCache = new Map();
async function getTokenDecimals(tokenAddress) {
  if (decimalsCache.has(tokenAddress)) return decimalsCache.get(tokenAddress);
  const response = await fetch("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "v32-momentum-token-decimals",
      method: "getTokenSupply",
      params: [tokenAddress]
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return null;
  const body = await response.json();
  const decimals = Number(body?.result?.value?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  decimalsCache.set(tokenAddress, decimals);
  return decimals;
}

let lastJupiterQuoteAt = 0;
let solUsdCache = { at: 0, price: null };
async function getSolUsdPrice() {
  if (solUsdCache.price > 0 && Date.now() - solUsdCache.at < 30000) return solUsdCache.price;
  const data = await market.getTokenData(SOL_MINT);
  const price = Number(data?.priceUsd);
  if (!(price > 0)) return null;
  solUsdCache = { at: Date.now(), price };
  return price;
}

async function getSellRouteQuote(tokenAddress, amountUsd, tokenPriceUsd) {
  try {
    const decimals = await getTokenDecimals(tokenAddress);
    if (!Number.isInteger(decimals)) return { allowed: false, reason: "TOKEN_DECIMALS_UNAVAILABLE" };
    const tokenQuantity = Number(amountUsd) / Number(tokenPriceUsd);
    const rawAmount = BigInt(Math.floor(tokenQuantity * (10 ** decimals))).toString();
    if (rawAmount === "0") return { allowed: false, reason: "QUOTE_AMOUNT_ROUNDS_TO_ZERO" };
    const waitMs = Math.max(0, 2100 - (Date.now() - lastJupiterQuoteAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastJupiterQuoteAt = Date.now();
    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", tokenAddress);
    url.searchParams.set("outputMint", SOL_MINT);
    url.searchParams.set("amount", rawAmount);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { allowed: false, reason: "JUPITER_HTTP_" + response.status };
    const quote = await response.json();
    const outputAmount = Number(quote?.outAmount);
    if (!(outputAmount > 0)) return { allowed: false, reason: "NO_SELL_ROUTE" };
    const solUsd = await getSolUsdPrice();
    if (!(solUsd > 0)) return { allowed: false, reason: "SOL_USD_PRICE_UNAVAILABLE" };
    const quotedUsd = outputAmount / 1e9 * solUsd;
    const returnPercent = quotedUsd / Number(amountUsd) * 100;
    return {
      allowed: Number.isFinite(returnPercent) && returnPercent >= CONFIG.entry.minimumSellQuotePercent,
      reason: returnPercent >= CONFIG.entry.minimumSellQuotePercent ? "SELL_ROUTE_CONFIRMED" : "SELL_QUOTE_BELOW_90_PERCENT",
      returnPercent,
      quotedUsd,
      router: quote.router || null
    };
  } catch (error) {
    return { allowed: false, reason: "SELL_QUOTE_ERROR: " + error.message };
  }
}

let lastFullCandidateScanAt = 0;

async function discoverBuyPriorityCandidates(options = {}) {
  await pollWatchlist(options);
  const now = Date.now();
  if (now - lastFullCandidateScanAt >= CONFIG.entry.discoveryRefreshSeconds * 1000) {
    lastFullCandidateScanAt = now;
    await scanner.discoverCandidates({
      ...options,
      minimumLiquidityUsd: CONFIG.entry.minimumLiquidityUsd,
      minimumVolume24hUsd: 0,
      candidateFilter: checkEntryFilters,
      analyzeCandidate: () => ({ score: 1, signal: "BUY", reasons: ["v3.2-momentum watchlist admission filters passed"] })
    });
  }
  const portfolio = trader.getPortfolio();
  const openAddresses = new Set((portfolio.positions || []).map(position => position.tokenAddress));
  const guards = getRecentStopLossGuards(portfolio, now);
  for (const address of openAddresses) if (watchlist.has(address)) removeWatchedToken(address, "position_opened", now);

  const ready = [];
  for (const item of watchlist.values()) {
    const candidate = item.triggerCandidate;
    if (!candidate || openAddresses.has(candidate.tokenAddress)) continue;
    const guard = guards.get(candidate.tokenAddress);
    if (guard && (guard.permanent || guard.until > now)) {
      console.log("REENTRY BLOCK | " + candidate.symbol + " | " + (guard.permanent ? "permanent ban after loss over " + CONFIG.entry.permanentStopLossPercent + "%" : CONFIG.entry.stopLossCooldownHours + "-hour stop-loss cooldown"));
      removeWatchedToken(candidate.tokenAddress, "do_not_reenter_stop_loss_guard", now);
      continue;
    }
    const sizing = getBuySizing(portfolio, candidate);
    if (sizing.amountInvested < CONFIG.capital.minimumTradeUsd) continue;
    let quote = item.triggerSellQuote;
    if (!quote || item.triggerSellQuoteAmountUsd !== sizing.amountInvested) {
      quote = await getSellRouteQuote(candidate.tokenAddress, sizing.amountInvested, candidate.priceUsd);
      if (!quote.allowed) {
        console.log("SELL ROUTE GATE | " + candidate.symbol + " | skipped | " + quote.reason);
        removeWatchedToken(candidate.tokenAddress, "sell_route_check_failed:" + quote.reason, now);
        continue;
      }
      item.triggerSellQuote = quote;
      item.triggerSellQuoteAmountUsd = sizing.amountInvested;
    }
    ready.push({
      ...candidate,
      reasons: [...(Array.isArray(candidate.reasons) ? candidate.reasons : []), STRATEGY_VERSION + " sell route passed"],
      experimentEntry: {
        strategy: STRATEGY_VERSION,
        entryMode: candidate.entryMode,
        baseLowUsd: Number(candidate.baseLowUsd),
        previousPeakUsd: Number(candidate.previousPeakUsd) || null,
        reentryGivebackPercent: Number(candidate.reentryGivebackPercent) || null,
        breakoutRisePercent: Number(candidate.breakoutRisePercent),
        triggerPriceUsd: Number(candidate.triggerPriceUsd),
        compoundRatePercent: sizing.compoundRate * 100,
        entryMetrics: {
          pairAgeMinutes: Math.max(0, (now - Number(candidate.pairCreatedAt)) / 60000),
          liquidityUsd: Number(candidate.liquidityUsd),
          volume5mUsd: Number(candidate.volume5m) || 0,
          volume1hUsd: Number(candidate.volume1h) || 0,
          buys5m: Number(candidate.buys5m) || 0,
          sells5m: Number(candidate.sells5m) || 0,
          buys1h: Number(candidate.buys1h) || 0,
          sells1h: Number(candidate.sells1h) || 0,
          sellQuoteReturnPercent: Number(quote.returnPercent.toFixed(2)),
          sellQuoteRouter: quote.router
        },
        estimatedCostModel: {
          label: "Estimated paper execution costs",
          tradeSizeUsd: Number(sizing.amountInvested.toFixed(2)),
          entryLiquidityUsd: Number(candidate.liquidityUsd),
          estimatedEntryImpactPercent: estimatedImpactPercent(sizing.amountInvested, candidate.liquidityUsd),
          assumedPoolFeePercentPerSwap: CONFIG.estimatedCosts.poolFeePercentPerSwap,
          estimatedSolanaNetworkFeeUsdPerSwap: CONFIG.estimatedCosts.solanaFeeUsdPerSwap,
          estimatedPriorityFeeUsdPerSwap: CONFIG.estimatedCosts.priorityFeeUsdPerSwap
        }
      }
    });
  }
  ready.sort((a, b) => {
    const priority = Number(b.signal === "STRONG BUY") - Number(a.signal === "STRONG BUY");
    return priority || (Number(b.score) || 0) - (Number(a.score) || 0);
  });
  return ready;
}

const lastMarketData = new Map();
const staleRiskLogAt = new Map();
async function getPositionMarketData(tokenAddress, options = {}) {
  let data = null;
  try {
    data = await market.getTokenData(tokenAddress, options);
  } catch (_) {
    data = null;
  }
  if (data && Number(data.priceUsd) > 0) {
    const observedAt = Date.now();
    const previous = lastMarketData.get(tokenAddress);
    if (previous && previous.data.pairAddress && data.pairAddress !== previous.data.pairAddress) {
      data = { ...data, _pairChangedFrom: previous.data.pairAddress };
    }
    const value = { data: { ...data }, observedAt };
    lastMarketData.set(tokenAddress, value);
    return { ...value.data, _observedAtMs: observedAt, _priceDataAgeMs: 0 };
  }
  const previous = lastMarketData.get(tokenAddress);
  if (!previous) return null;
  return {
    ...previous.data,
    _observedAtMs: previous.observedAt,
    _priceDataAgeMs: Date.now() - previous.observedAt
  };
}

function appendExitAudit(trade, ageMs, reason) {
  const record = {
    strategyVersion: STRATEGY_VERSION,
    botLabel: BOT_LABEL,
    positionId: trade.positionId,
    tokenAddress: trade.tokenAddress,
    exitPriceActuallyUsed: trade.exitPrice,
    priceDataAgeMsAtExit: Number.isFinite(ageMs) ? ageMs : null,
    reason,
    estimatedFeesUsd: Number(trade.estimatedFeesUsd) || 0,
    estimatedSlippageUsd: Number(trade.estimatedSlippageUsd) || 0,
    pnl: Number(trade.pnl) || 0,
    exitTime: trade.exitTime
  };
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.appendFileSync(auditFile, JSON.stringify(record) + "\n", "utf8");
}

let currentExitContext = null;
const targetTrader = {
  buy: trader.buy,
  getPortfolio: trader.getPortfolio,
  updateHigh: trader.updateHigh,
  positionKey: trader.positionKey,
  sell: (...args) => {
    const result = trader.sell(...args);
    if (!result?.success) return result;
    const trade = result.trade;
    const reason = String(trade.reason || args[2]?.reason || "");
    const stage = Number(profitStages.get(trade.positionId)) || 0;
    if (reason.startsWith("TAKE PROFIT +")) {
      profitStages.set(trade.positionId, stage + 1);
      persistStages();
    } else if (Number(args[1] ?? 100) === 100) {
      profitStages.delete(trade.positionId);
      persistStages();
    }
    try {
      appendExitAudit(trade, currentExitContext?.ageMs, reason);
    } catch (error) {
      console.error("EXIT AUDIT WRITE FAILED | " + error.message);
    }
    console.log("EXIT TRADE AUDIT | " + JSON.stringify({
      strategyVersion: STRATEGY_VERSION,
      positionId: trade.positionId,
      exitPriceActuallyUsed: trade.exitPrice,
      priceDataAgeMsAtExit: Number.isFinite(currentExitContext?.ageMs) ? currentExitContext.ageMs : null,
      reason,
      estimatedFeesUsd: trade.estimatedFeesUsd,
      estimatedSlippageUsd: trade.estimatedSlippageUsd
    }));
    return result;
  }
};

function getPoolLiquidity(position, freshData) {
  if (freshData._pairChangedFrom && freshData._pairChangedFrom === position.pairAddress) {
    return { mismatch: true, liquidityUsd: 0 };
  }
  if (position.pairAddress && freshData.pairAddress !== position.pairAddress) {
    return { mismatch: true, liquidityUsd: 0 };
  }
  return { mismatch: false, liquidityUsd: Number(freshData.liquidityUsd) };
}

function evaluateExit({ position, freshData, currentPrice, now = Date.now() }) {
  const ageMs = Math.max(0, Number(freshData?._priceDataAgeMs) || 0);
  const lastLogAt = staleRiskLogAt.get(position.id) || 0;
  if (ageMs > CONFIG.exit.stalePriceDataMs) {
    if (now - lastLogAt >= CONFIG.exit.stalePriceDataMs) {
      console.error("STALE PRICE RISK | " + position.symbol + " | price data age " + Math.round(ageMs) + "ms; exits held until fresh price returns");
      staleRiskLogAt.set(position.id, now);
    }
    return null;
  }
  staleRiskLogAt.delete(position.id);
  const pool = getPoolLiquidity(position, freshData);
  if (pool.mismatch) return { reason: "liquidity_drop", percent: 100 };
  const entryLiquidity = Number(position.entryLiquidityUsd);
  if (entryLiquidity > 0 && Number.isFinite(pool.liquidityUsd) &&
      pool.liquidityUsd < entryLiquidity * (1 - CONFIG.exit.liquidityDropPercent / 100)) {
    return { reason: "liquidity_drop", percent: 100 };
  }

  const entry = Number(position.entryPrice);
  const high = Number(position.highestPrice || entry);
  const profitPercent = (currentPrice - entry) / entry * 100;
  const highProfitPercent = (high - entry) / entry * 100;
  const holdMinutes = Math.max(0, (now - new Date(position.entryTime).getTime()) / 60000);
  const dropFromHigh = high > 0 ? (high - currentPrice) / high * 100 : 0;
  const stage = getPositionStage(position);

  const baseLow = Number(position.experimentEntry?.baseLowUsd);
  const baseStopPrice = baseLow > 0
    ? baseLow * (1 - CONFIG.entry.baseStopBelowLowPercent / 100) : NaN;
  const hardStopPrice = entry * (1 - CONFIG.exit.stopLossPercent / 100);
  let activeStopPrice = Number.isFinite(baseStopPrice)
    ? Math.max(baseStopPrice, hardStopPrice) : hardStopPrice;
  if (highProfitPercent >= CONFIG.exit.breakevenTriggerPercent) {
    activeStopPrice = Math.max(activeStopPrice, entry);
  }
  if (currentPrice <= activeStopPrice) {
    if (highProfitPercent >= CONFIG.exit.breakevenTriggerPercent && activeStopPrice === entry) {
      return { reason: "BREAKEVEN STOP", percent: 100 };
    }
    const isBaseStop = Number.isFinite(baseStopPrice) && baseStopPrice >= hardStopPrice;
    return {
      reason: isBaseStop ? "BASE LOW STOP -" + CONFIG.entry.baseStopBelowLowPercent + "%" : "STOP LOSS -" + CONFIG.exit.stopLossPercent + "%",
      percent: 100
    };
  }
  if (holdMinutes >= CONFIG.exit.maximumHoldMinutes) return { reason: "MAX HOLD " + CONFIG.exit.maximumHoldMinutes + "M", percent: 100 };
  if (holdMinutes >= CONFIG.exit.timeStopMinutes && highProfitPercent < CONFIG.exit.minimumGainAtTimeStopPercent) {
    return { reason: "TIME STOP " + CONFIG.exit.timeStopMinutes + "M", percent: 100 };
  }
  if (stage >= 2 && dropFromHigh >= CONFIG.exit.trailingStopPercent) {
    return { reason: "TRAILING STOP -" + CONFIG.exit.trailingStopPercent + "%", percent: 100 };
  }
  if (stage === 0 && profitPercent >= CONFIG.exit.firstTargetPercent) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.firstTargetPercent + "% SELL " + CONFIG.exit.firstTargetOriginalPositionPercent + "% ORIGINAL",
      percent: CONFIG.exit.firstTargetOriginalPositionPercent
    };
  }
  if (stage === 1 && profitPercent >= CONFIG.exit.secondTargetPercent) {
    return {
      reason: "TAKE PROFIT +" + CONFIG.exit.secondTargetPercent + "% SELL " + CONFIG.exit.secondTargetOriginalPositionPercent + "% ORIGINAL",
      percent: CONFIG.exit.secondTargetOriginalPositionPercent / (100 - CONFIG.exit.firstTargetOriginalPositionPercent) * 100
    };
  }
  return null;
}

function logTradeSummary(event, trade = {}) {
  const entryPrice = optionalNumber(trade.entryPrice);
  const exitPrice = optionalNumber(trade.exitPrice);
  const entryCosts = trade.entryExecutionCosts || {};
  const estimatedFees = optionalNumber(trade.estimatedFeesUsd) ??
    optionalNumber(entryCosts.feesUsd) ?? 0;
  const estimatedSlippage = optionalNumber(trade.estimatedSlippageUsd) ??
    optionalNumber(entryCosts.slippageUsd) ?? 0;
  const netPnl = optionalNumber(trade.netPnl ?? trade.pnl);
  const startedAt = Date.parse(trade.entryTime || "");
  const endedAt = Date.parse(trade.exitTime || "");
  const holdMinutes = Number.isFinite(startedAt)
    ? Math.max(0, ((Number.isFinite(endedAt) ? endedAt : Date.now()) - startedAt) / 60000)
    : null;
  const reason = trade.reason || event || "UNKNOWN";

  console.info(
    "TRADE | strategy=v3.2-momentum" +
    " | event=" + (event || trade.type || "UNKNOWN") +
    " | token=" + (trade.tokenAddress || "unknown") +
    " | entry=" + logPrice(entryPrice) +
    " | exit=" + (exitPrice === null ? "open" : logPrice(exitPrice)) +
    " | reason=" + reason +
    " | pnl_after_costs=" + (netPnl === null ? "pending" : logUsd(netPnl)) +
    " | fees=" + logUsd(estimatedFees) +
    " | slippage=" + logUsd(estimatedSlippage) +
    " | hold_minutes=" + (holdMinutes === null ? "n/a" : holdMinutes.toFixed(2))
  );
}

const quietNotifier = {
  notifyTrade: async (event, trade) => logTradeSummary(event, trade),
  notifyCritical: message => telegram.notifyCritical(message)
};

const bot = createBot({
  trader: targetTrader,
  getTokenData: getPositionMarketData,
  discoverCandidates: discoverBuyPriorityCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  botLabel: BOT_LABEL + " | " + STRATEGY_VERSION,
  reentryStateFile: statePath("v31BuyPriorityTestReentryState.json"),
  maxOpenPositions: CONFIG.capital.maxOpenPositions,
  scannerIntervalMs: CONFIG.entry.watchlistPollIntervalSeconds * 1000,
  requireLiquidityLock: false,
  useReentryGuards: false,
  exitDecision: args => {
    currentExitContext = {
      ageMs: Number(args.freshData?._priceDataAgeMs) || 0,
      pairAddress: args.freshData?.pairAddress
    };
    return evaluateExit(args);
  },
  pauseEntriesAtBalance: CONFIG.capital.pauseAtBalanceUsd,
  entryPauseStateFile: statePath("v31BuyPriorityTestEntryPause.json")
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount,
  evaluateExit,
  getBuySizing,
  getRecentStopLossGuards,
  classifyHybridEntry
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
    strategyVersion: STRATEGY_VERSION,
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
