const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");
const { getLockStatus } = require("./lpLockChecker");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const REENTRY_MIN_VOLUME_5M = 3000;
const REENTRY_MIN_VOLUME_ACCELERATION = 1.25;
const REENTRY_MIN_MOMENTUM_5M = 0.25;
const REENTRY_MAX_MOMENTUM_5M = 4;
const REENTRY_MIN_TRANSACTIONS_5M = 20;
const REENTRY_MIN_BUY_RATIO = 0.52;
const REENTRY_MAX_BUY_RATIO = 0.80;
const REENTRY_MIN_LP_LOCK_PERCENT = 90;
const REENTRY_MAX_LIQUIDITY_DRAWDOWN = 0.12;
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

function defaultReentryStateFile() {
  if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error("Attach a Railway volume before starting the V3.1 reentry guard.");
  }
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "pubxV31ReentryState.json");
}

function loadReentryGuards(file, io = fs) {
  if (!io.existsSync(file)) return new Map();
  const parsed = JSON.parse(io.readFileSync(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.guards || typeof parsed.guards !== "object" || Array.isArray(parsed.guards)) {
    throw new Error("Invalid V3.1 reentry state. Restore a verified backup; the state has not been reset.");
  }
  return new Map(Object.entries(parsed.guards));
}

function persistReentryGuards(guards, file, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    io.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, guards: Object.fromEntries(guards) }, null, 2), { flag: "wx", flush: true });
    io.renameSync(temporary, file);
  } finally {
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
}

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
  botLabel = "V3.1 Original - 2 Slots",
  reentryStateFile = defaultReentryStateFile()
} = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
  let activeSession = null;
  let scannerInterval = null;
  let positionInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const tokenCooldowns = loadReentryGuards(reentryStateFile);
  const isActive = session => activeSession === session && !session.signal.aborted;
  const getPositions = () => {
    const portfolio = getPortfolio();
    return Array.isArray(portfolio.positions)
      ? portfolio.positions
      : (portfolio.position ? [portfolio.position] : []);
  };

  function syncClosedTokenGuards() {
    const portfolio = getPortfolio();
    const openTokens = new Set(getPositions().map(position => position.tokenAddress));
    const latestTradeByToken = new Map();
    for (const trade of Array.isArray(portfolio.history) ? portfolio.history : []) {
      if (trade?.tokenAddress) latestTradeByToken.set(trade.tokenAddress, trade);
    }
    let changed = false;
    for (const [tokenAddress, trade] of latestTradeByToken) {
      if (trade.type !== "SELL" || Number(trade.percentSold) !== 100 || openTokens.has(tokenAddress)) continue;
      const exitTime = trade.exitTime || trade.timestamp || trade.createdAt;
      if (!exitTime) continue;
      const current = tokenCooldowns.get(tokenAddress);
      if (current?.exitTime === exitTime) continue;
      tokenCooldowns.set(tokenAddress, {
        exitTime,
        observations: 0,
        previousVolume5m: null,
        peakLiquidityUsd: 0,
        released: false
      });
      console.log(`REENTRY LOCKED | ${trade.symbol || tokenAddress} | awaiting renewed activity after full exit`);
      changed = true;
    }
    if (changed) persistReentryGuards(tokenCooldowns, reentryStateFile);
  }

  function observeReentry(coin, lock) {
    const guard = tokenCooldowns.get(coin.tokenAddress);
    if (!guard || guard.released) return true;
    const volume5m = Number(coin.volume5m) || 0;
    const momentum5m = Number(coin.priceChange5m) || 0;
    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const transactions5m = buys5m + sells5m;
    const buyRatio = transactions5m ? buys5m / transactions5m : 0;
    const liquidityUsd = Number(coin.liquidityUsd) || 0;
    const peakLiquidityUsd = Math.max(Number(guard.peakLiquidityUsd) || 0, liquidityUsd);
    const liquidityHealthy = liquidityUsd > 0 && liquidityUsd >= peakLiquidityUsd * (1 - REENTRY_MAX_LIQUIDITY_DRAWDOWN);
    const lpHealthy = Boolean(lock?.allowed) && Number(lock.lockedPercent) >= REENTRY_MIN_LP_LOCK_PERCENT;
    const active = lpHealthy && volume5m >= REENTRY_MIN_VOLUME_5M &&
      momentum5m >= REENTRY_MIN_MOMENTUM_5M && momentum5m < REENTRY_MAX_MOMENTUM_5M &&
      transactions5m >= REENTRY_MIN_TRANSACTIONS_5M &&
      buyRatio >= REENTRY_MIN_BUY_RATIO && buyRatio <= REENTRY_MAX_BUY_RATIO && liquidityHealthy;
    if (!active) {
      tokenCooldowns.set(coin.tokenAddress, { ...guard, observations: 0, previousVolume5m: null, peakLiquidityUsd });
      persistReentryGuards(tokenCooldowns, reentryStateFile);
      console.log(`REENTRY GATE | ${coin.symbol} | locked | renewed activity criteria not met`);
      return false;
    }

    const accelerated = guard.observations >= 1 && Number(guard.previousVolume5m) > 0 &&
      volume5m >= Number(guard.previousVolume5m) * REENTRY_MIN_VOLUME_ACCELERATION;
    if (accelerated) {
      tokenCooldowns.set(coin.tokenAddress, { ...guard, observations: 2, previousVolume5m: volume5m, peakLiquidityUsd, released: true });
      persistReentryGuards(tokenCooldowns, reentryStateFile);
      console.log(`REENTRY GATE | ${coin.symbol} | released after two activity checks and 25% volume acceleration`);
      return true;
    }

    tokenCooldowns.set(coin.tokenAddress, { ...guard, observations: 1, previousVolume5m: volume5m, peakLiquidityUsd, released: false });
    persistReentryGuards(tokenCooldowns, reentryStateFile);
    console.log(`REENTRY GATE | ${coin.symbol} | 1 of 2 activity checks; waiting for >=25% 5m volume acceleration`);
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
    syncClosedTokenGuards();
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const openTokens = new Set(getPositions().map(position => position.tokenAddress));
    const availableCandidates = candidates.filter(coin => !openTokens.has(coin.tokenAddress));
    const freeSlots = Math.max(0, MAX_OPEN_POSITIONS - getPositions().length);
    const buyCandidates = availableCandidates.filter(
      coin => (coin.signal === "BUY" || coin.signal === "STRONG BUY") && !openTokens.has(coin.tokenAddress)
    );
    const selected = [];

    for (const coin of buyCandidates) {
      const lock = await checkLiquidityLock(coin.tokenAddress);
      onLiquidityLockCheck(lock, coin);
      if (!isActive(session)) return;
      if (!lock?.allowed || Number(lock.lockedPercent) < REENTRY_MIN_LP_LOCK_PERCENT) {
        console.log(`LP LOCK GATE | ${coin.symbol} | skipped | ${lock?.reason || "LOCK_STATUS_UNAVAILABLE"}`);
        continue;
      }
      const guard = tokenCooldowns.get(coin.tokenAddress);
      if (guard && !guard.released && !observeReentry(coin, lock)) continue;
      coin.reasons = [
        ...(Array.isArray(coin.reasons) ? coin.reasons : []),
        `LP lock ${Number(lock.lockedPercent).toFixed(1)}% confirmed by RugCheck`
      ];
      selected.push(coin);
      if (selected.length >= freeSlots) break;
    }

    if (!selected.length) {
      console.log("No BUY or STRONG BUY candidate with confirmed LP lock >=90% available.");
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
        if (tokenCooldowns.delete(coin.tokenAddress)) persistReentryGuards(tokenCooldowns, reentryStateFile);
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
          if (percent === 100) syncClosedTokenGuards();
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
