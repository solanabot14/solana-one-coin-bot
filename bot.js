const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createTokenLossGuard } = require("./tokenLossGuard");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");
const { getLockStatus } = require("./lpLockChecker");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const ENTRY_MIN_LP_LOCK_PERCENT = 60;
const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 40;
const TRAILING_STOP_PERCENT = 8;
const PROFIT_LOCK_TRIGGER_PERCENT = 10;
const PROFIT_LOCK_FLOOR_PERCENT = 4;
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
  onLiquidityLockCheck = () => {},
  positionMonitorMs = POSITION_MONITOR_MS,
  scannerIntervalMs = SCANNER_INTERVAL_MS,
  botLabel = "V3.1 Original - 2 Slots"
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
  const isActive = session => activeSession === session && !session.signal.aborted;
  const getPositions = () => {
    const portfolio = getPortfolio();
    return Array.isArray(portfolio.positions)
      ? portfolio.positions
      : (portfolio.position ? [portfolio.position] : []);
  };

  const momentumEntryObservations = new Map();

  function confirmMomentumEntry(coin, now) {
    const tokenAddress = coin.tokenAddress;
    const momentum5m = Number(coin.priceChange5m);
    const volume5m = Number(coin.volume5m);
    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const transactions5m = buys5m + sells5m;
    const buyRatio = transactions5m ? buys5m / transactions5m : 0;
    const qualifies = tokenAddress && Number.isFinite(momentum5m) &&
      momentum5m >= 0.25 && momentum5m <= 8 && volume5m >= 1500 &&
      transactions5m >= 8 && buyRatio >= 0.52;
    if (!qualifies) {
      if (tokenAddress) momentumEntryObservations.delete(tokenAddress);
      return false;
    }
    const current = { at: now, momentum5m, volume5m };
    const previous = momentumEntryObservations.get(tokenAddress);
    if (previous && now - previous.at <= scannerIntervalMs * 2 &&
        momentum5m >= previous.momentum5m - 1 &&
        volume5m >= previous.volume5m * 0.75) {
      momentumEntryObservations.delete(tokenAddress);
      return true;
    }
    momentumEntryObservations.set(tokenAddress, current);
    return false;
  }

  async function runScanner(session) {
    console.log("\nStarting automatic Solana scan...\n");
    if (getPositions().length >= MAX_OPEN_POSITIONS) {
      console.log("Both V3.1 slots are occupied. Skipping new entry.");
      return;
    }

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || getPositions().length >= MAX_OPEN_POSITIONS) return;
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const openTokens = new Set(getPositions().map(position => position.tokenAddress));
    const availableCandidates = candidates.filter(coin => !openTokens.has(coin.tokenAddress));
    const freeSlots = Math.max(0, MAX_OPEN_POSITIONS - getPositions().length);
    const buyCandidates = availableCandidates.filter(coin => {
      if (openTokens.has(coin.tokenAddress)) return false;
      if (coin.signal === "BUY" || coin.signal === "STRONG BUY") return true;
      return coin.signal === "WAIT" && confirmMomentumEntry(coin, Date.now());
    });
    const selected = [];

    for (const coin of buyCandidates) {
      if (!tokenLossGuard.allows(coin)) continue;
			const lock = await checkLiquidityLock(coin.tokenAddress, coin);
      onLiquidityLockCheck(lock, coin);
      if (!isActive(session)) return;
      const rawLockedPercent = lock?.lockedPercent;
      const lockStatusUnavailable = rawLockedPercent === null ||
        rawLockedPercent === undefined || rawLockedPercent === "" ||
        lock?.reason === "LOCK_STATUS_UNAVAILABLE";
      const lockedPercent = lockStatusUnavailable ? NaN : Number(rawLockedPercent);
		const canonicalPumpSwapMigration = lock?.canonicalPumpSwapMigration === true;
		const confirmedLowLock = !canonicalPumpSwapMigration && Number.isFinite(lockedPercent) &&
        lockedPercent < ENTRY_MIN_LP_LOCK_PERCENT;

      // Confirmed low-lock pools remain unsafe; verified canonical migrations are checked separately.
      // If RugCheck has no lock data, only a WAIT setup confirmed on two scans
      // may use the alternate path; direct BUY signals still need confirmed LP.
		const confirmedLock = canonicalPumpSwapMigration || (Number.isFinite(lockedPercent) &&
		lockedPercent >= ENTRY_MIN_LP_LOCK_PERCENT);
      const momentumConfirmedWithoutLock = lockStatusUnavailable &&
        (coin.signal === "WAIT" || confirmMomentumEntry(coin, Date.now()));
      if (confirmedLowLock || (!confirmedLock && !momentumConfirmedWithoutLock)) {
        console.log(`LP LOCK GATE | ${coin.symbol} | skipped | ${lock?.reason || "LOCK_STATUS_UNAVAILABLE"}`);
        continue;
      }
      if (confirmedLock && (coin.signal === "BUY" || coin.signal === "STRONG BUY")) {
        momentumEntryObservations.delete(coin.tokenAddress);
      }
      if (coin.signal === "WAIT") {
        coin.signal = "CONFIRMED MOMENTUM PAPER BUY";
        coin.reasons = [
          ...(Array.isArray(coin.reasons) ? coin.reasons : []),
          "WAIT signal admitted after two scans with rising 5m momentum, volume and buy pressure"
        ];
      }
		coin.reasons = [
			...(Array.isArray(coin.reasons) ? coin.reasons : []),
			canonicalPumpSwapMigration
				? "Canonical PumpSwap migration verified on-chain; migration LP tokens are burned"
				: `LP lock ${Number(lock.lockedPercent).toFixed(1)}% confirmed by RugCheck`
		];
      selected.push(coin);
      if (selected.length >= freeSlots) break;
    }

    if (!selected.length) {
		console.log(`No eligible BUY candidate with confirmed LP lock >=${ENTRY_MIN_LP_LOCK_PERCENT}% or verified canonical PumpSwap migration.`);
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
          void notifier.notifyTrade(reason, result.trade);
        }
        return result;
      };

      if (profitPercent <= HARD_STOP_PERCENT) {
        exit("HARD STOP");
        continue;
      }

      const highestProfitPercent = ((Number(position.highestPrice) - entryPrice) / entryPrice) * 100;
      const profitLockActive = highestProfitPercent >= PROFIT_LOCK_TRIGGER_PERCENT;
      const profitLockFloorPrice = Math.max(
        entryPrice * (1 + PROFIT_LOCK_FLOOR_PERCENT / 100),
        Number(position.highestPrice) * (1 - TRAILING_STOP_PERCENT / 100)
      );
      if (profitLockActive && currentPrice <= profitLockFloorPrice) {
        console.log(`PROFIT LOCK FLOOR | ${position.symbol} | protected price: ${profitLockFloorPrice.toPrecision(8)}`);
        exit("PROFIT LOCK");
        continue;
      }

      const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
      const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
      const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS &&
        momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
      const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS &&
        momentum5m <= MOMENTUM_EXIT_STRONG_5M;
      if (momentumExitA || momentumExitB) {
        exit("MOMENTUM EXIT");
        continue;
      }

      if (profitPercent >= TAKE_PROFIT_1_PERCENT && !position.firstTakeProfitDone) {
        const result = sell(currentPrice, TAKE_PROFIT_1_SELL_PERCENT, {
          expectedPosition,
          takeProfit: "firstTakeProfitDone",
          reason: "TAKE PROFIT 1"
        });
        if (result.success) void notifier.notifyTrade("TAKE PROFIT 1", result.trade);
        continue;
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
