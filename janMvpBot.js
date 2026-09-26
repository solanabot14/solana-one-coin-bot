const market = require("./dexscreener");
const telegram = require("./telegram");
const { createJanMvpTrader } = require("./janMvpTrader");
const paperTrader = require("./paperTrader");

const POSITION_MONITOR_MS = 5000;
const OG_FOLLOW_INTERVAL_MS = 2000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;

const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 15;
const TAKE_PROFIT_2_PERCENT = 30;
const TAKE_PROFIT_2_SELL_PERCENT = 35;
const TRAILING_STOP_PERCENT = 8;
const PROFIT_LOCK_TRIGGER_PERCENT = 10;
const PROFIT_LOCK_TRAIL_POINTS = 8;
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
  timers = globalThis,
  notifier = telegram
} = {}) {
  let activeSession = null;
  let followInterval = null;
  let monitorInterval = null;
  let followBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const isActive = session => activeSession === session && !session.signal.aborted;

  async function notifyMilestones(closedTrade, milestones) {
    for (const milestone of milestones || []) {
      const state = trader.getDashboardState();
      const slot = state.slots.find(s => s.id === closedTrade.slotId);
      const nextTarget = slot?.currentTarget;
      await notifier.sendTelegramMessage([
        "JAN MVP | SLOT MILESTONE",
        `Slot: ${closedTrade.slotId}`,
        `Reached: $${Number(milestone).toFixed(2)}`,
        `Balance: $${Number(closedTrade.endingBalance).toFixed(2)}`,
        nextTarget == null ? "Next target: COMPLETE" : `Next target: $${Number(nextTarget).toFixed(2)}`,
        `Coin: ${closedTrade.symbol}`,
        `Trade return: ${Number(closedTrade.returnPercent).toFixed(2)}%`
      ].join("\n"));
    }
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
      volume24h: Number(position.entryVolume24h) || 0,
      buys5m: Number(position.entryBuys5m) || 0,
      sells5m: Number(position.entrySells5m) || 0
    };

    const result = trader.buy(slot.id, coin, {
      source: "OG_MIRROR",
      sourceOgPositionId
    });

    if (result.success) {
      console.log(
        `JAN MVP MIRROR BUY | Slot ${slot.id} | ${coin.symbol} | OG entry $${Number(position.entryPrice).toFixed(10)} | Slot $${Number(result.trade.amountInvested).toFixed(2)}`
      );
    }
  }

  async function monitorSlot(session, slotSnapshot) {
    const position = slotSnapshot.position;
    if (!position) return;
    const expectedPosition = trader.positionKey(position);
    const fresh = await getTokenData(position.tokenAddress, { signal: session.signal });
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
    const profitPercent = (currentPrice - entryPrice) / entryPrice * 100;
    const highestProfitPercent = (Number(p.highestPrice) - entryPrice) / entryPrice * 100;
    const profitLockFloor = highestProfitPercent - PROFIT_LOCK_TRAIL_POINTS;
    const dropFromHigh = (Number(p.highestPrice) - currentPrice) / Number(p.highestPrice) * 100;
    const momentum5m = Number(fresh.priceChange5m) || 0;
    const buys5m = Number(fresh.buys5m) || 0;
    const sells5m = Number(fresh.sells5m) || 0;
    const totalTransactions = buys5m + sells5m;
    const buyRatio = totalTransactions ? buys5m / totalTransactions : 0;

    const exit = async (reason, percent = 100) => {
      const result = trader.sell(slot.id, currentPrice, percent, { expectedPosition, reason });
      if (result.success && result.closedTrade) {
        await notifyMilestones(result.closedTrade, result.newlyReached);
      }
      return result;
    };

    if (profitPercent <= HARD_STOP_PERCENT) { await exit("HARD STOP"); return; }

    const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
    const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
    const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS && momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
    const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS && momentum5m <= MOMENTUM_EXIT_STRONG_5M;
    if (momentumExitA || momentumExitB) { await exit("MOMENTUM EXIT"); return; }

    const profitLockActive = !p.secondTakeProfitDone && highestProfitPercent >= PROFIT_LOCK_TRIGGER_PERCENT;
    if (profitLockActive && profitPercent <= profitLockFloor) { await exit("PROFIT LOCK"); return; }

    if (profitPercent >= TAKE_PROFIT_1_PERCENT && !p.firstTakeProfitDone) {
      return void trader.sell(slot.id, currentPrice, TAKE_PROFIT_1_SELL_PERCENT, {
        expectedPosition, takeProfit:"firstTakeProfitDone", reason:"TAKE PROFIT 1"
      });
    }

    if (profitPercent >= TAKE_PROFIT_2_PERCENT && p.firstTakeProfitDone && !p.secondTakeProfitDone) {
      return void trader.sell(slot.id, currentPrice, TAKE_PROFIT_2_SELL_PERCENT, {
        expectedPosition, takeProfit:"secondTakeProfitDone", reason:"TAKE PROFIT 2"
      });
    }

    if (p.secondTakeProfitDone && dropFromHigh >= TRAILING_STOP_PERCENT) {
      await exit("TRAILING STOP"); return;
    }
  }

  async function monitorPositions(session) {
    const open = trader.getState().slots.filter(slot => slot.position);
    for (const slot of open) {
      if (!isActive(session)) return;
      await monitorSlot(session, slot);
    }
  }

  async function tick(kind, session = activeSession) {
    if (!session || !isActive(session)) return;
    if (kind === "follow" ? followBusy : monitorBusy) return;
    if (kind === "follow") followBusy = true;
    else monitorBusy = true;

    try {
      if (kind === "follow") await followOgEntry(session);
      else await monitorPositions(session);
    } catch (error) {
      if (isActive(session)) {
        lastError = error.message;
        console.error("JAN MVP error:", error.message);
      }
    } finally {
      if (kind === "follow") followBusy = false;
      else monitorBusy = false;
    }
  }

  function start() {
    if (activeSession) return;
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("JAN MVP STARTED | Mirroring OG coin entries into independent slots");
    monitorInterval = timers.setInterval(() => tick("monitor", session), POSITION_MONITOR_MS);
    followInterval = timers.setInterval(() => tick("follow", session), OG_FOLLOW_INTERVAL_MS);
    void tick("monitor", session);
    void tick("follow", session);
  }

  function stop() {
    if (!activeSession) return;
    activeSession.abort();
    activeSession = null;
    timers.clearInterval(followInterval);
    timers.clearInterval(monitorInterval);
    followInterval = monitorInterval = null;
    console.log("JAN MVP STOPPED");
  }

  return {
    start, stop,
    getStatus: () => activeSession !== null,
    getLastError: () => lastError,
    getDashboardState: () => trader.getDashboardState(),
    getState: () => trader.getState()
  };
}

module.exports = { createJanMvpBot, ...createJanMvpBot() };
