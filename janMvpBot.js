const market = require("./dexscreener");
const telegram = require("./telegram");
const scanner = require("./scanner");
const { createJanMvpTrader } = require("./janMvpTrader");
const { createTokenLossGuard } = require("./tokenLossGuard");
const paperTrader = require("./paperTrader");
const { getLockStatus } = require("./lpLockChecker");

const POSITION_MONITOR_MS = 5000;
const OG_FOLLOW_INTERVAL_MS = 2000;
const SWARM_CACHE_FILL_INTERVAL_MS = 5000;
const SWARM_DISCOVERY_INTERVAL_MS = 120000;
const SWARM_CACHE_MAX_AGE_MS = 3 * 60 * 1000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;

const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 25;
const PROFIT_LOCK_TRIGGER_PERCENT = 10;
const PROFIT_LOCK_FLOOR_PERCENT = 4;
const TAKE_PROFIT_2_PERCENT = 30;
const TAKE_PROFIT_2_SELL_PERCENT = 35;
const TRAILING_STOP_PERCENT = 8;
const MOMENTUM_EXIT_MIN_LOSS = -2;
const MOMENTUM_EXIT_5M = -3;
const MOMENTUM_EXIT_STRONG_LOSS = -5;
const MOMENTUM_EXIT_STRONG_5M = -1;
const MOMENTUM_EXIT_BUY_RATIO = 0.45;
const MOMENTUM_EXIT_MIN_TRANSACTIONS = 10;

function createJanMvpBot({
  trader = createJanMvpTrader(),
  getTokenData = market.getTokenData,
  getOgPortfolio = paperTrader.getPortfolio,
  discoverCandidates = scanner.discoverCandidates,
  checkLiquidityLock = getLockStatus,
  timers = globalThis,
  notifier = telegram
} = {}) {
  let activeSession = null;
  let followInterval = null;
  let fillInterval = null;
  let monitorInterval = null;
  let followBusy = false;
  let fillBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const tokenLossGuard = createTokenLossGuard({
    getHistory: () => trader.getState().executions,
    scannerIntervalMs: SWARM_DISCOVERY_INTERVAL_MS
  });
  const blockedMirrorNotices = new Set();
  let candidateCache = [];
  let candidateCacheAt = 0;
  const livePositionSnapshots = new Map();
  const isActive = session => activeSession === session && !session.signal.aborted;

  async function notifyMilestones() {
    // Routine Swarm slot milestones are trade notifications and stay muted with the other bot updates.
    return { sent: false, reason: "routine bot trade notifications muted" };
  }

  function notifySwarmSell(execution, position) {
    if (!execution) return;
    void notifier.notifyTrade(execution.reason || "SELL", {
      ...execution,
      entryPrice: position.entryPrice,
      exitPrice: execution.price,
      amountInvested: Number(position.amountInvested) * Number(execution.percentSold) / 100
    });
  }

  function ogPositionId(position) {
    return String(position?.id || [position?.tokenAddress, position?.entryTime].join("|"));
  }

  function alreadyMirrored(sourceOgPositionId) {
    const state = trader.getState();
    return state.slots.some(slot => slot.position?.sourceOgPositionId === sourceOgPositionId) ||
      state.executions.some(execution =>
        execution.type === "BUY" && execution.sourceOgPositionId === sourceOgPositionId
      );
  }

  function chooseFreeSlot() {
    return trader.getState().slots
      .filter(slot => !slot.position && Number(slot.cashBalance) > 0)
      .sort((a, b) =>
        Number(a.completedTrades || 0) - Number(b.completedTrades || 0) ||
        Number(a.id) - Number(b.id)
      )[0] || null;
  }

  async function followOgEntry(session) {
    const og = getOgPortfolio();
    const position = og?.position;
    if (!position || !isActive(session)) return;
    if (tokenLossGuard.lossStreak(position.tokenAddress) >= 2) {
      if (!blockedMirrorNotices.has(position.tokenAddress)) {
        blockedMirrorNotices.add(position.tokenAddress);
        console.log(`SWARM TOKEN LOSS LOCK | ${position.symbol} | refusing mirror after two consecutive losses`);
      }
      return;
    }
    blockedMirrorNotices.delete(position.tokenAddress);

    const sourceOgPositionId = ogPositionId(position);
    if (alreadyMirrored(sourceOgPositionId)) return;

    const slot = chooseFreeSlot();
    if (!slot) return;

    const coin = {
      symbol: position.symbol,
      name: position.name,
      tokenAddress: position.tokenAddress,
      pairAddress: position.pairAddress || null,
      priceUsd: Number(position.entryPrice),
      signal: position.entrySignal || "STRONG BUY",
      score: Number(position.entryScore) || 0,
      priceChange5m: Number(position.entryPriceChange5m) || 0,
      priceChange1h: Number(position.entryPriceChange1h) || 0,
      priceChange24h: Number(position.entryPriceChange24h) || 0,
      liquidityUsd: Number(position.entryLiquidityUsd) || 0,
      volume5m: Number(position.entryVolume5m) || 0,
      volume1h: Number(position.entryVolume1h) || 0,
      volume24h: Number(position.entryVolume24h) || 0,
      discoverySources: Array.isArray(position.entryDiscoverySources) ? [...position.entryDiscoverySources] : [],
      currentActivity: position.entryCurrentActivity ? structuredClone(position.entryCurrentActivity) : null,
      postPump: position.entryPostPump ? structuredClone(position.entryPostPump) : null,
      preDiscoveryPump: position.entryPreDiscoveryPump ? structuredClone(position.entryPreDiscoveryPump) : null,
      marketDataIntegrity: position.entryMarketDataIntegrity ? structuredClone(position.entryMarketDataIntegrity) : null,
      smartMoney: position.entrySmartMoney ? structuredClone(position.entrySmartMoney) : null,
      buys5m: Number(position.entryBuys5m) || 0,
      sells5m: Number(position.entrySells5m) || 0
    };

    const result = trader.buy(slot.id, coin, {
      source: "OG_MIRROR",
      sourceOgPositionId
    });

    if (result.success) {
      console.log(
        `JAN MVP MIRROR BUY | Slot ${slot.id} | ${coin.symbol} | OG entry ${Number(position.entryPrice).toFixed(10)} | Slot ${Number(result.trade.amountInvested).toFixed(2)}`
      );
      void notifier.notifyTrade("BUY", result.trade);
    }
  }

  function occupiedTokenAddresses() {
    return new Set(
      trader.getState().slots
        .map(slot => slot.position?.tokenAddress)
        .filter(Boolean)
    );
  }

  function freeSlots() {
    return trader.getState().slots
      .filter(slot => !slot.position && Number(slot.cashBalance) > 0)
      .sort((a, b) =>
        Number(a.completedTrades || 0) - Number(b.completedTrades || 0) ||
        Number(a.id) - Number(b.id)
      );
  }

  async function fillFreeSlotsFromCache(session) {
    const slots = freeSlots();
    if (!slots.length || !isActive(session)) return;

    const now = Date.now();
    if (!candidateCacheAt || now - candidateCacheAt >= SWARM_DISCOVERY_INTERVAL_MS) {
      candidateCache = await discoverCandidates(session.signal) || [];
      candidateCacheAt = Date.now();
    }
    const discovered = candidateCache;
    if (!isActive(session)) return;
    const occupied = occupiedTokenAddresses();
    const usable = (discovered || []).filter(coin =>
      coin.signal === "STRONG BUY" &&
      coin.tokenAddress &&
      !occupied.has(coin.tokenAddress)
    );

    let candidateIndex = 0;
    for (const slot of slots) {
      if (!isActive(session)) return;
      let coin = null;
      while (candidateIndex < usable.length) {
        const candidate = usable[candidateIndex++];
        if (occupied.has(candidate.tokenAddress)) continue;
        if (!tokenLossGuard.allows(candidate)) continue;
        const lock = await checkLiquidityLock(candidate.tokenAddress);
        if (!lock?.allowed || Number(lock.lockedPercent) < 85) {
          console.log("SWARM LP LOCK GATE | " + candidate.symbol + " | skipped | " + (lock?.reason || "LOCK_STATUS_UNAVAILABLE"));
          continue;
        }
        coin = candidate;
        break;
      }
      if (!coin) break;
      const result = trader.buy(slot.id, coin, { source: "SWARM_V31_DISCOVERY" });
      if (result.success) {
        occupied.add(coin.tokenAddress);
        console.log(`SWARM BUY | Slot ${slot.id} | ${coin.symbol} | ${Number(result.trade.amountInvested).toFixed(2)}`);
        void notifier.notifyTrade("BUY", result.trade);
      }
    }
  }

  async function monitorSlot(session, slotSnapshot) {
    const position = slotSnapshot.position;
    if (!position) return;
    const expectedPosition = trader.positionKey(position);
    const fresh = await getTokenData(position.tokenAddress, {
      signal: session.signal,
      pairAddress: position.pairAddress || undefined,
      referencePrice: Number(position.highestPrice || position.entryPrice) || undefined
    });
    if (!isActive(session) || !fresh) return;

    const latestSlot = trader.getState().slots.find(s => s.id === slotSnapshot.id);
    if (!latestSlot?.position || trader.positionKey(latestSlot.position) !== expectedPosition) return;

    const currentPrice = Number(fresh.priceUsd);
    if (!(currentPrice > 0)) return;

    trader.updateHigh(slotSnapshot.id, expectedPosition, currentPrice);
    const slot = trader.getState().slots.find(s => s.id === slotSnapshot.id);
    const p = slot.position;
    if (!p || trader.positionKey(p) !== expectedPosition) return;

    const entryPrice = Number(p.entryPrice);
    const livePnl = Number(p.quantity || 0) * currentPrice - Number(p.amountInvested || 0);
    livePositionSnapshots.set(slotSnapshot.id, {
      currentPrice,
      currentValue: Number(p.quantity || 0) * currentPrice,
      pnl: livePnl,
      pnlPercent: Number(p.amountInvested) > 0 ? livePnl / Number(p.amountInvested) * 100 : null,
      maxGainPercent: entryPrice > 0 ? (Number(p.highestPrice || entryPrice) - entryPrice) / entryPrice * 100 : null,
      holdTimeMs: Math.max(0, Date.now() - new Date(p.entryTime).getTime()),
      pairAddress: p.pairAddress || fresh.pairAddress || null
    });
    const profitPercent = (currentPrice - entryPrice) / entryPrice * 100;
    const highestProfitPercent = (Number(p.highestPrice) - entryPrice) / entryPrice * 100;
    const dropFromHigh = (Number(p.highestPrice) - currentPrice) / Number(p.highestPrice) * 100;
    const momentum5m = Number(fresh.priceChange5m) || 0;
    const buys5m = Number(fresh.buys5m) || 0;
    const sells5m = Number(fresh.sells5m) || 0;
    const totalTransactions = buys5m + sells5m;
    const buyRatio = totalTransactions ? buys5m / totalTransactions : 0;

    const exit = async (reason, percent = 100) => {
      const result = trader.sell(slot.id, currentPrice, percent, { expectedPosition, reason });
      if (result.success) notifySwarmSell(result.execution, p);
      if (result.success && result.closedTrade) {
        await notifyMilestones(result.closedTrade, result.newlyReached);
        void tick("fill", session);
      }
      return result;
    };

    if (profitPercent <= HARD_STOP_PERCENT) { await exit("HARD STOP"); return; }

    const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
    const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
    const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS && momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
    const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS && momentum5m <= MOMENTUM_EXIT_STRONG_5M;
    if (momentumExitA || momentumExitB) { await exit("MOMENTUM EXIT"); return; }

    const profitLockActive = highestProfitPercent >= PROFIT_LOCK_TRIGGER_PERCENT &&
      !p.secondTakeProfitDone;
    if (profitLockActive && profitPercent <= PROFIT_LOCK_FLOOR_PERCENT) {
      await exit("PROFIT LOCK"); return;
    }

    if (profitPercent >= TAKE_PROFIT_1_PERCENT && !p.firstTakeProfitDone) {
      const result = trader.sell(slot.id, currentPrice, TAKE_PROFIT_1_SELL_PERCENT, {
        expectedPosition, takeProfit:"firstTakeProfitDone", reason:"TAKE PROFIT 1"
      });
      if (result.success) notifySwarmSell(result.execution, p);
      return;
    }

    if (profitPercent >= TAKE_PROFIT_2_PERCENT && p.firstTakeProfitDone && !p.secondTakeProfitDone) {
      const result = trader.sell(slot.id, currentPrice, TAKE_PROFIT_2_SELL_PERCENT, {
        expectedPosition, takeProfit:"secondTakeProfitDone", reason:"TAKE PROFIT 2"
      });
      if (result.success) notifySwarmSell(result.execution, p);
      return;
    }

    if (p.secondTakeProfitDone && dropFromHigh >= TRAILING_STOP_PERCENT) {
      await exit("TRAILING STOP"); return;
    }
  }

  async function monitorPositions(session) {
    const open = trader.getState().slots.filter(slot => slot.position);
    if (!open.length || !isActive(session)) return;
    const results = await Promise.allSettled(
      open.map(slot => monitorSlot(session, slot))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("SWARM SLOT MONITOR ERROR:", result.reason?.message || result.reason);
      }
    }
  }

  async function tick(kind, session = activeSession) {
    if (!session || !isActive(session)) return;
    if (kind === "follow" && followBusy) return;
    if (kind === "fill" && fillBusy) return;
    if (kind === "monitor" && monitorBusy) return;
    if (kind === "follow") followBusy = true;
    else if (kind === "fill") fillBusy = true;
    else monitorBusy = true;

    try {
      if (kind === "follow") await followOgEntry(session);
      else if (kind === "fill") await fillFreeSlotsFromCache(session);
      else await monitorPositions(session);
    } catch (error) {
      if (isActive(session)) {
        lastError = error.message;
        console.error("SWARM error:", error.message);
      }
    } finally {
      if (kind === "follow") followBusy = false;
      else if (kind === "fill") fillBusy = false;
      else monitorBusy = false;
    }
  }

  async function closeAllPositions(reason = "MANUAL PAPER CLOSE") {
    const slots = trader.getDashboardState().slots || [];
    const results = [];
    for (const slot of slots) {
      const position = slot && slot.position;
      if (!position) continue;
      try {
        const quote = await getTokenData(position.tokenAddress, { pairAddress: position.pairAddress });
        const currentPrice = Number(quote && quote.priceUsd) || Number(slot.live && slot.live.currentPrice) || 0;
        if (!(currentPrice > 0)) {
          results.push({ success: false, slotId: slot.id, symbol: position.symbol, message: "No current price; position left open." });
          continue;
        }
        const expectedPosition = trader.positionKey(position);
        const result = trader.sell(slot.id, currentPrice, 100, { expectedPosition, reason });
        results.push({ ...result, slotId: slot.id, symbol: position.symbol });
      } catch (error) {
        results.push({ success: false, slotId: slot.id, symbol: position.symbol, message: error.message });
      }
    }
    const closedCount = results.filter(result => result.success).length;
    return { success: results.every(result => result.success), closedCount, results };
  }

  function start() {
    if (activeSession) return;
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("SWARM STARTED | 5 concurrent slots | V3.1 discovery cached 120s");
    monitorInterval = timers.setInterval(() => tick("monitor", session), POSITION_MONITOR_MS);
    followInterval = timers.setInterval(() => tick("follow", session), OG_FOLLOW_INTERVAL_MS);
    fillInterval = timers.setInterval(() => tick("fill", session), SWARM_CACHE_FILL_INTERVAL_MS);
    void tick("monitor", session);
    void tick("follow", session);
    void tick("fill", session);
  }

  function stop() {
    if (!activeSession) return;
    activeSession.abort();
    activeSession = null;
    timers.clearInterval(followInterval);
    timers.clearInterval(fillInterval);
    timers.clearInterval(monitorInterval);
    followInterval = fillInterval = monitorInterval = null;
    console.log("SWARM STOPPED");
  }

  return {
    start, stop,
    getStatus: () => activeSession !== null,
    getLastError: () => lastError,
    getDashboardState: () => {
      const dashboard = trader.getDashboardState();
      return {
        ...dashboard,
        slots: dashboard.slots.map(slot => {
          if (!slot.position) {
            livePositionSnapshots.delete(slot.id);
            return slot;
          }
          return { ...slot, live: livePositionSnapshots.get(slot.id) || null };
        })
      };
    },
    getState: () => trader.getState(),
    closeAllPositions
  };
}

module.exports = { createJanMvpBot, ...createJanMvpBot() };
