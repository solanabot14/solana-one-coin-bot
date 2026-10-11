const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createPaperTrader } = require("./paperTrader");
const { createBot } = require("./bot85");
const { getLockStatus } = require("./lpLockChecker85");

const BOT_LABEL = "V3.1 BUY Priority Test - 60% LP Lock";
const BUY_TO_STRONG_BUY_RATIO = 2;
const COMPOUND_RATES = [0.10, 0.125, 0.15];
const MINIMUM_BUY_USD = 10;
const POOL_FEE_PERCENT_ESTIMATE = 0.30;
const NETWORK_FEE_USD_ESTIMATE = 0.01;

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

function nextCompoundRate(portfolio) {
  const completedEntries = (portfolio.history || []).filter(row => row.type === "BUY").length;
  return COMPOUND_RATES[completedEntries % COMPOUND_RATES.length];
}

function getBuySizing(portfolio) {
  const rate = nextCompoundRate(portfolio);
  const equity = Number(portfolio.startingBalance) > 0
    ? Number(portfolio.cashBalance) + (portfolio.positions || []).reduce((sum, position) => sum + Number(position.amountInvested || 0), 0)
    : 100;
  const cash = Number(portfolio.cashBalance) || 0;
  return {
    compoundRate: rate,
    amountInvested: Math.min(Math.max(equity * rate, MINIMUM_BUY_USD), cash)
  };
}

const trader = createPaperTrader(
  statePath("v31BuyPriorityLock85TradingData.json"),
  fs,
  {
    strategyVersion: "V3.1-BUY-Priority-60LP-2to1-CostEstimate",
    getBuySizing
  }
);

async function discoverBuyPriorityCandidates(options = {}) {
  const candidates = await scanner.discoverCandidates({
    ...options,
    minimumLiquidityUsd: 20000,
    minimumVolume24hUsd: 25000
  });
  const history = trader.getPortfolio().history || [];
  const entryRecords = history.filter(row => row.type === "BUY");
  const buyCount = entryRecords.filter(row => row.entrySignal === "BUY").length;
  const strongBuyCount = entryRecords.filter(row => row.entrySignal === "STRONG BUY").length;
  const strongBuyAllowance = Math.max(
    0,
    Math.floor(buyCount / BUY_TO_STRONG_BUY_RATIO) - strongBuyCount
  );

  const buyCandidates = candidates
    .filter(candidate => candidate.signal === "BUY")
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const strongBuyCandidates = candidates
    .filter(candidate => candidate.signal === "STRONG BUY")
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, strongBuyAllowance);

  return [...buyCandidates, ...strongBuyCandidates].map(candidate => {
    const portfolio = trader.getPortfolio();
    const sizing = getBuySizing(portfolio);
    const tradeUsd = sizing.amountInvested;
    return {
      ...candidate,
      reasons: [
        ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
        candidate.signal === "BUY"
          ? "BUY-priority test: BUY signals are selected before STRONG BUY"
          : "BUY-priority test: STRONG BUY admitted only within the 2:1 BUY-to-STRONG-BUY target"
      ],
      experimentEntry: {
        signalBucket: candidate.signal,
        buyToStrongBuyTarget: "2:1",
        compoundRatePercent: sizing.compoundRate * 100,
        estimatedCostModel: {
          label: "Paper estimate; not a live quote",
          tradeSizeUsd: Number(tradeUsd.toFixed(2)),
          entryLiquidityUsd: Number(candidate.liquidityUsd) || null,
          estimatedEntryImpactPercent: estimatedImpactPercent(tradeUsd, candidate.liquidityUsd),
          assumedPoolFeePercentPerSwap: POOL_FEE_PERCENT_ESTIMATE,
          estimatedSolanaNetworkFeeUsdPerSwap: NETWORK_FEE_USD_ESTIMATE,
          method: "Approximate constant-product impact from DexScreener displayed liquidity; fees are fixed assumptions."
        }
      }
    };
  });
}

const quietNotifier = {
  notifyTrade: async () => {},
  notifyCritical: async () => {}
};

const bot = createBot({
  trader,
  getTokenData: market.getTokenData,
  discoverCandidates: discoverBuyPriorityCandidates,
  notifier: quietNotifier,
  checkLiquidityLock: getLockStatus,
  acceptedSignals: ["BUY", "STRONG BUY"],
  botLabel: BOT_LABEL,
  reentryStateFile: statePath("v31BuyPriorityLock85ReentryState.json")
});

module.exports = {
  ...bot,
  getPortfolio: trader.getPortfolio,
  buildDashboardAccount
};

function buildDashboardAccount() {
  const account = trader.getPortfolio();
  const history = Array.isArray(account.history) ? account.history : [];
  const buyByPosition = new Map(
    history.filter(row => row.type === "BUY").map(row => [row.positionId || row.id, row])
  );

  const costByPosition = new Map();
  const enrichedHistory = history.map(row => {
    if (row.type !== "SELL") return row;
    const buy = buyByPosition.get(row.positionId);
    const assumptions = buy?.experimentEntry?.estimatedCostModel;
    if (!buy || !assumptions) return { ...row, costEstimateAvailable: false };

    const boughtQuantity = Number(buy.quantity) || 0;
    const soldQuantity = Number(row.quantitySold) || 0;
    const saleValue = Number(row.saleValue) || 0;
    const allocatedShare = boughtQuantity > 0 ? soldQuantity / boughtQuantity : 0;
    const fullEntryUsd = Number(buy.amountInvested) || 0;
    const entryImpactPct = Number(assumptions.estimatedEntryImpactPercent) || 0;
    const poolFeeRate = Number(assumptions.assumedPoolFeePercentPerSwap) / 100;
    const entrySlippage = fullEntryUsd * entryImpactPct / 100 * allocatedShare;
    const entryPoolFee = fullEntryUsd * poolFeeRate * allocatedShare;
    const exitImpactPct = estimatedImpactPercent(saleValue, assumptions.entryLiquidityUsd) || 0;
    const exitSlippage = saleValue * exitImpactPct / 100;
    const exitPoolFee = saleValue * poolFeeRate;
    const networkFee = NETWORK_FEE_USD_ESTIMATE * (1 + allocatedShare);
    const estimatedSlippageUsd = entrySlippage + exitSlippage;
    const estimatedFeesUsd = entryPoolFee + exitPoolFee + networkFee;
    const estimatedCostUsd = estimatedSlippageUsd + estimatedFeesUsd;
    const netPnl = Number(row.pnl || 0) - estimatedCostUsd;

    const prior = costByPosition.get(row.positionId) || {
      estimatedSlippageUsd: 0,
      estimatedFeesUsd: 0,
      estimatedCostUsd: 0,
      netPnl: 0
    };
    costByPosition.set(row.positionId, {
      estimatedSlippageUsd: prior.estimatedSlippageUsd + estimatedSlippageUsd,
      estimatedFeesUsd: prior.estimatedFeesUsd + estimatedFeesUsd,
      estimatedCostUsd: prior.estimatedCostUsd + estimatedCostUsd,
      netPnl: prior.netPnl + netPnl
    });

    return {
      ...row,
      grossPnl: Number(row.pnl || 0),
      netPnl,
      estimatedSlippageUsd,
      estimatedFeesUsd,
      estimatedCostUsd,
      costEstimateAvailable: true
    };
  });

  const openPositions = (account.positions || []).map(position => {
    const assumptions = position.experimentEntry?.estimatedCostModel;
    if (!assumptions) return position;
    const remainingUsd = Number(position.amountInvested) || 0;
    const originalUsd = Number(assumptions.tradeSizeUsd) || remainingUsd;
    const remainingShare = originalUsd > 0 ? Math.min(1, remainingUsd / originalUsd) : 1;
    const entryImpactPct = Number(assumptions.estimatedEntryImpactPercent) || 0;
    return {
      ...position,
      estimatedEntryCostUsd: remainingUsd * (entryImpactPct / 100 + Number(assumptions.assumedPoolFeePercentPerSwap) / 100) +
        NETWORK_FEE_USD_ESTIMATE * remainingShare
    };
  });

  return {
    ...account,
    positions: openPositions,
    position: openPositions[0] || null,
    history: enrichedHistory,
    completedTrades: [],
    stats: null,
    running: bot.getBotStatus(),
    costModel: {
      label: "Estimated paper execution costs",
      poolFeePercentPerSwap: POOL_FEE_PERCENT_ESTIMATE,
      networkFeeUsdPerSwap: NETWORK_FEE_USD_ESTIMATE,
      slippageMethod: "Approximate constant-product impact using entry liquidity from DexScreener",
      warning: "These are estimates; live swap routes, pool fees, priority fees and fills can differ."
    }
  };
}
