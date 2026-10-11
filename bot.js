const market = require("./dexscreener");
const scanner = require("./scanner");
const { createTokenLossGuard } = require("./tokenLossGuard");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");
const { getLockStatus } = require("./lpLockChecker");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 30000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const HARD_STOP_PERCENT = -8;
const PROFIT_PROTECTION_ARM_PERCENT = 10;
const PROFIT_PROTECTION_FLOOR_NET_PERCENT = 1.5;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 30;
const TAKE_PROFIT_2_PERCENT = 30;
// Sell 30% of the original position from the 70% remaining after TP1.
const TAKE_PROFIT_2_SELL_PERCENT = (30 / 70) * 100;
const TRAILING_STOP_PERCENT = 15;
const MOMENTUM_EXIT_CONFIRM_MS = SCANNER_INTERVAL_MS;
const MOMENTUM_EXIT_MIN_LOSS = -2;
const MOMENTUM_EXIT_5M = -3;
const MOMENTUM_EXIT_STRONG_LOSS = -5;
const MOMENTUM_EXIT_STRONG_5M = -1;
const MOMENTUM_EXIT_BUY_RATIO = 0.45;
const MOMENTUM_EXIT_MIN_TRANSACTIONS = 10;
const MAX_OPEN_POSITIONS = 2;

function createBot({
  trader = paperTrader,
  getTokenData = market.getTokenData,
  discoverCandidates = scanner.discoverCandidates,
  timers = globalThis,
  notifier = telegram,
  checkLiquidityLock = getLockStatus,
  positionMonitorMs = POSITION_MONITOR_MS,
  scannerIntervalMs = SCANNER_INTERVAL_MS,
  momentumExitConfirmMs = MOMENTUM_EXIT_CONFIRM_MS,
  now = () => Date.now(),
  botLabel = "B3.1 Profitability Lab - Paper Only"
} = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
  const tokenLossGuard = createTokenLossGuard({
    getHistory: () => getPortfolio().history,
    scannerIntervalMs
  });
  let activeSession = null;
  let scannerInterval = null;
  let positionInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const tokenCooldowns = new Map();
  const labObservations = new Map();
  const momentumExitObservations = new Map();
  const isActive = session => activeSession === session && !session.signal.aborted;
  const getPositions = () => {
    const portfolio = getPortfolio();
    return Array.isArray(portfolio.positions)
      ? portfolio.positions
      : (portfolio.position ? [portfolio.position] : []);
  };

  function getOriginalPositionInvestment(position) {
    const history = getPortfolio().history;
    const entryTrade = (Array.isArray(history) ? history : [])
      .find(trade => trade.type === "BUY" && trade.positionId === position.id);
    return Number(entryTrade?.amountInvested) || Number(position.amountInvested) || 0;
  }

  function getNetTradePnl(position, currentPrice) {
    const portfolio = getPortfolio();
    const realizedPnl = (Array.isArray(portfolio.history) ? portfolio.history : [])
      .filter(trade => trade.type === "SELL" && trade.positionId === position.id)
      .reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0);
    const executionCostBps = Math.max(0, Math.min(500, Number(position.executionCostBps) || 80));
    const estimatedNetExitValue =
      Number(position.quantity) * currentPrice * (1 - executionCostBps / 10000);
    return realizedPnl + estimatedNetExitValue - (Number(position.amountInvested) || 0);
  }

  function confirmLabSignal(coin, now) {
    const momentum5m = Number(coin.priceChange5m);
    const volume5m = Number(coin.volume5m);
    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const transactions5m = buys5m + sells5m;
    const buyRatio = transactions5m ? buys5m / transactions5m : 0;
    const activeMomentum = ["BUY", "STRONG BUY", "WAIT"].includes(coin.signal) &&
      Number.isFinite(momentum5m) && momentum5m >= 0.25 && momentum5m <= 8 &&
      volume5m >= 1500 && transactions5m >= 8 && buyRatio >= 0.52;
    if (!activeMomentum || !coin.tokenAddress) {
      if (coin.tokenAddress) labObservations.delete(coin.tokenAddress);
      return false;
    }
    const current = { at: now, momentum5m, volume5m };
    const previous = labObservations.get(coin.tokenAddress);
    if (previous && now - previous.at <= scannerIntervalMs * 2 &&
        current.momentum5m >= previous.momentum5m - 1 &&
        current.volume5m >= previous.volume5m * 0.75) {
      labObservations.delete(coin.tokenAddress);
      return true;
    }
    labObservations.set(coin.tokenAddress, current);
    return false;
  }

  function confirmMomentumExit(positionId, shouldExit, nowMs) {
    if (!shouldExit) {
      momentumExitObservations.delete(positionId);
      return false;
    }
    const observation = momentumExitObservations.get(positionId);
    if (!observation) {
      momentumExitObservations.set(positionId, { confirmations: 1, lastConfirmedAt: nowMs });
      return false;
    }
    if (nowMs - observation.lastConfirmedAt >= momentumExitConfirmMs) {
      observation.confirmations += 1;
      observation.lastConfirmedAt = nowMs;
    }
    return observation.confirmations >= 2;
  }

  function startCooldown(tokenAddress, symbol, reason) {
    tokenCooldowns.set(tokenAddress, Date.now());
    console.log(`COOLDOWN STARTED | ${symbol} | 60 minutes | ${reason}`);
  }

  async function runScanner(session) {
    console.log("\nStarting automatic Solana scan...\n");
    if (getPositions().length >= MAX_OPEN_POSITIONS) {
      console.log("Both lab slots are occupied. Skipping new entry.");
      return;
    }

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || getPositions().length >= MAX_OPEN_POSITIONS) return;
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const now = Date.now();
    const availableCandidates = candidates.filter(coin => {
      const started = tokenCooldowns.get(coin.tokenAddress);
      if (!started) return true;
      if (now - started >= TOKEN_COOLDOWN_MS) {
        tokenCooldowns.delete(coin.tokenAddress);
        return true;
      }
      return false;
    });
    const openTokens = new Set(getPositions().map(position => position.tokenAddress));
    const freeSlots = Math.max(0, MAX_OPEN_POSITIONS - getPositions().length);
    const buyCandidates = availableCandidates.filter(coin =>
      !openTokens.has(coin.tokenAddress) && confirmLabSignal(coin, now)
    );
    const selected = [];

    for (const coin of buyCandidates) {
      if (!tokenLossGuard.allows(coin)) continue;
      const lock = await checkLiquidityLock(coin.tokenAddress);
      if (!isActive(session)) return;
      if (!Number.isFinite(Number(lock?.lockedPercent)) || Number(lock.lockedPercent) < 60) {
        console.log(`LP LOCK GATE | ${coin.symbol} | skipped | ${lock?.reason || "LOCK_STATUS_UNAVAILABLE"}`);
        continue;
      }
      coin.signal = "FAST MOMENTUM PAPER BUY";
      coin.reasons = [
        ...(Array.isArray(coin.labReasons) ? coin.labReasons : []),
        `LP lock ${Number(lock.lockedPercent).toFixed(1)}% confirmed by RugCheck`
      ];
      coin.experimentEntry = {
        lane: "FAST_MOMENTUM_REBOUND_PAPER",
        sizing: "10% compounding; $10 minimum, cash-capped"
      };
      selected.push(coin);
      if (selected.length >= freeSlots) break;
    }

    if (!selected.length) {
      console.log("No FAST MOMENTUM paper candidate with confirmed LP lock >=60%.");
      return;
    }

    for (const coin of selected) {
      if (!isActive(session) || getPositions().length >= MAX_OPEN_POSITIONS) break;
      console.log("\nBOT SELECTED:");
      console.log(`${coin.symbol} - ${coin.name}`);
      console.log(`Score: ${coin.score}`);
      console.log(`Signal: ${coin.signal}`);
      console.log(`5m Momentum: ${coin.priceChange5m}%`);
      console.log(`1h Momentum: ${coin.priceChange1h}%`);
      console.log(`5m Buys/Sells: ${coin.buys5m}/${coin.sells5m}`);

      const trade = buy(coin);
      if (trade.success) {
        openTokens.add(coin.tokenAddress);
        void notifier.notifyTrade("BUY", trade.trade);
      }
      console.log("\nPAPER TRADE:", trade);
    }

    console.log("\nPORTFOLIO:", getPortfolio());
    console.log("\nTOP SOLANA CANDIDATES:\n");
    availableCandidates.slice(0, 5).forEach((coin, index) => {
      console.log(`#${index + 1} ${coin.symbol} - ${coin.name}`);
      console.log(`Score: ${coin.score}`);
      console.log(`Signal: ${coin.signal}`);
      console.log(`Price: $${coin.priceUsd}`);
      console.log(`Liquidity: $${coin.liquidityUsd}`);
      console.log(`24h Volume: $${coin.volume24h}`);
      console.log(`5m Momentum: ${coin.priceChange5m}%`);
      console.log(`5m Buys/Sells: ${coin.buys5m}/${coin.sells5m}`);
      console.log(`Address: ${coin.tokenAddress}`);
      console.log("----------------------------");
    });
  }

  async function monitorPosition(session) {
    for (const snapshot of getPositions()) {
      if (!isActive(session)) return;
      const expectedPosition = positionKey(snapshot);
      const tokenAddress = snapshot.tokenAddress;
      const freshData = await getTokenData(tokenAddress, { signal: session.signal });
      let position = getPositions().find(item => positionKey(item) === expectedPosition);
      if (!isActive(session) || !position || !freshData) continue;

      const currentPrice = Number(freshData.priceUsd);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
      updateHigh(expectedPosition, currentPrice);
      position = getPositions().find(item => positionKey(item) === expectedPosition);
      if (!position) continue;

      const entryPrice = Number(position.entryPrice);
      const nowMs = now();
      const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      const dropFromHigh = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
      const momentum5m = Number(freshData.priceChange5m) || 0;
      const buys5m = Number(freshData.buys5m) || 0;
      const sells5m = Number(freshData.sells5m) || 0;
      const totalTransactions = buys5m + sells5m;
      const buyRatio = totalTransactions ? buys5m / totalTransactions : 0;
      console.log(`POSITION MONITOR | ${position.symbol} | P/L: ${profitPercent.toFixed(2)}% | 5m: ${momentum5m.toFixed(2)}% | Buy Ratio: ${(buyRatio * 100).toFixed(1)}% | Drop High: ${dropFromHigh.toFixed(2)}%`);

      const exit = (reason, percent = 100) => {
        console.log(`EXIT | ${position.symbol} | ${reason}`);
        const result = sell(currentPrice, percent, { expectedPosition, reason });
        if (result.success) {
          if (percent === 100) {
            momentumExitObservations.delete(expectedPosition);
            startCooldown(tokenAddress, position.symbol, reason);
          }
          void notifier.notifyTrade(reason, result.trade);
        }
        return result;
      };

      if (profitPercent <= HARD_STOP_PERCENT + 1e-9) {
        exit("HARD STOP");
        continue;
      }

      const profitProtectionArmed =
        position.highestPrice >= entryPrice * (1 + PROFIT_PROTECTION_ARM_PERCENT / 100);
      const profitProtectionFloorUsd =
        getOriginalPositionInvestment(position) * PROFIT_PROTECTION_FLOOR_NET_PERCENT / 100;
      if (
        profitProtectionArmed &&
        getNetTradePnl(position, currentPrice) <= profitProtectionFloorUsd
      ) {
        exit("PROFIT PROTECTION +1.5% NET FLOOR");
        continue;
      }

      const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
      const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
      const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS &&
        momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
      const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS &&
        momentum5m <= MOMENTUM_EXIT_STRONG_5M;
      const momentumExitConfirmed = confirmMomentumExit(
        expectedPosition,
        momentumExitA || momentumExitB,
        nowMs
      );
      if (momentumExitConfirmed) {
        exit("MOMENTUM EXIT");
        continue;
      }

      if (profitPercent >= TAKE_PROFIT_1_PERCENT - 1e-9 && !position.firstTakeProfitDone) {
        const result = sell(currentPrice, TAKE_PROFIT_1_SELL_PERCENT, {
          expectedPosition,
          takeProfit: "firstTakeProfitDone",
          reason: "TAKE PROFIT 1"
        });
        if (result.success) void notifier.notifyTrade("TAKE PROFIT 1", result.trade);
        continue;
      }
      if (profitPercent >= TAKE_PROFIT_2_PERCENT - 1e-9 &&
          position.firstTakeProfitDone && !position.secondTakeProfitDone) {
        const result = sell(currentPrice, TAKE_PROFIT_2_SELL_PERCENT, {
          expectedPosition,
          takeProfit: "secondTakeProfitDone",
          reason: "TAKE PROFIT 2"
        });
        if (result.success) void notifier.notifyTrade("TAKE PROFIT 2", result.trade);
        continue;
      }
      if (position.secondTakeProfitDone && dropFromHigh + 1e-9 >= TRAILING_STOP_PERCENT) {
        exit("TRAILING STOP");
      }
    }
  }

  async function tick(kind, session = activeSession) {
    if (!session || !isActive(session)) return;
    if (kind === "scanner" ? scannerBusy : monitorBusy) return;
    if (kind === "scanner") scannerBusy = true;
    else monitorBusy = true;
    try {
      await (kind === "scanner" ? runScanner(session) : monitorPosition(session));
    } catch (error) {
      if (isActive(session)) {
        lastError = error.message;
        console.error("Trading paused:", error.message);
        void notifier.notifyCritical(`Trading paused: ${error.message}`);
        stopBot();
      }
    } finally {
      if (kind === "scanner") scannerBusy = false;
      else monitorBusy = false;
    }
  }

  function startBot() {
    if (activeSession) return;
    getPortfolio();
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("BOT STARTED | " + botLabel);
    positionInterval = timers.setInterval(() => tick("monitor", session), positionMonitorMs);
    scannerInterval = timers.setInterval(() => tick("scanner", session), scannerIntervalMs);
    void tick("monitor", session);
    void tick("scanner", session);
  }

  function stopBot() {
    if (!activeSession) return;
    activeSession.abort();
    activeSession = null;
    timers.clearInterval(scannerInterval);
    timers.clearInterval(positionInterval);
    scannerInterval = positionInterval = null;
    console.log("BOT STOPPED | Open positions remain saved; automatic exits are paused.");
  }

  return {
    startBot,
    stopBot,
    getBotStatus: () => activeSession !== null,
    getLastError: () => lastError
  };
}

module.exports = { createBot, ...createBot() };
