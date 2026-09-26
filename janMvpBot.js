const market = require("./dexscreener");
const scanner = require("./scanner");
const telegram = require("./telegram");
const { createJanMvpTrader } = require("./janMvpTrader");

const POSITION_MONITOR_MS = 5000;
const SCANNER_INTERVAL_MS = 120000;
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
  discoverCandidates = scanner.discoverCandidates,
  timers = globalThis,
  notifier = telegram
} = {}) {
  let activeSession = null;
  let scannerInterval = null;
  let monitorInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const tokenCooldowns = new Map();

  const isActive = session => activeSession === session && !session.signal.aborted;

  function startCooldown(tokenAddress) {
    tokenCooldowns.set(tokenAddress, Date.now());
  }

  function availableByCooldown(tokenAddress) {
    const started = tokenCooldowns.get(tokenAddress);
    if (!started) return true;
    if (Date.now() - started >= TOKEN_COOLDOWN_MS) {
      tokenCooldowns.delete(tokenAddress);
      return true;
    }
    return false;
  }

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

  async function runScanner(session) {
    const state = trader.getState();
    const freeSlots = state.slots.filter(slot => !slot.position && Number(slot.cashBalance) > 0);
    if (!freeSlots.length) return;

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session)) return;

    const occupiedTokens = new Set(
      trader.getState().slots.map(slot => slot.position?.tokenAddress).filter(Boolean)
    );
    const strong = candidates.filter(coin =>
      coin.signal === "STRONG BUY" &&
      !occupiedTokens.has(coin.tokenAddress) &&
      availableByCooldown(coin.tokenAddress)
    );

    let candidateIndex = 0;
    for (const slot of freeSlots) {
      if (!isActive(session)) return;
      const coin = strong[candidateIndex++];
      if (!coin) break;
      const result = trader.buy(slot.id, coin);
      if (result.success) {
        occupiedTokens.add(coin.tokenAddress);
        console.log(`JAN MVP BUY | Slot ${slot.id} | ${coin.symbol} | $${Number(result.trade.amountInvested).toFixed(2)}`);
      }
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
        startCooldown(position.tokenAddress);
        await notifyMilestones(result.closedTrade, result.newlyReached);
      }
      return result;
    };

    if (profitPercent <= HARD_STOP_PERCENT) return void await exit("HARD STOP");

    const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
    const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
    const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS && momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
    const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS && momentum5m <= MOMENTUM_EXIT_STRONG_5M;
    if (momentumExitA || momentumExitB) return void await exit("MOMENTUM EXIT");

    const profitLockActive = !p.secondTakeProfitDone && highestProfitPercent >= PROFIT_LOCK_TRIGGER_PERCENT;
    if (profitLockActive && profitPercent <= profitLockFloor) return void await exit("PROFIT LOCK");

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
      return void await exit("TRAILING STOP");
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
    if (kind === "scanner" ? scannerBusy : monitorBusy) return;
    if (kind === "scanner") scannerBusy = true;
    else monitorBusy = true;

    try {
      if (kind === "scanner") await runScanner(session);
      else await monitorPositions(session);
    } catch (error) {
      if (isActive(session)) {
        lastError = error.message;
        console.error("JAN MVP error:", error.message);
      }
    } finally {
      if (kind === "scanner") scannerBusy = false;
      else monitorBusy = false;
    }
  }

  function start() {
    if (activeSession) return;
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("JAN MVP STARTED | Independent 5-slot paper simulation");
    monitorInterval = timers.setInterval(() => tick("monitor", session), POSITION_MONITOR_MS);
    scannerInterval = timers.setInterval(() => tick("scanner", session), SCANNER_INTERVAL_MS);
    void tick("monitor", session);
    void tick("scanner", session);
  }

  function stop() {
    if (!activeSession) return;
    activeSession.abort();
    activeSession = null;
    timers.clearInterval(scannerInterval);
    timers.clearInterval(monitorInterval);
    scannerInterval = monitorInterval = null;
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
