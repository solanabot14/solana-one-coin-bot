const fs = require("node:fs");
const path = require("node:path");
const market = require("./dexscreener");
const scanner = require("./scanner");
const { createTokenLossGuard } = require("./tokenLossGuard");
const { liquidityLockAllowsEntry } = require("./liquidityLockGate");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");
const { getLockStatus } = require("./lpLockChecker");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const REENTRY_MIN_VOLUME_5M = 3000;
const REENTRY_MIN_VOLUME_ACCELERATION = 1.25;
const REENTRY_MIN_MOMENTUM_5M = 0.25;
const REENTRY_MAX_MOMENTUM_5M = 4;
const REENTRY_MIN_TRANSACTIONS_5M = 20;
const REENTRY_MIN_BUY_RATIO = 0.52;
const REENTRY_MAX_BUY_RATIO = 0.80;
const REENTRY_MIN_LP_LOCK_PERCENT = 85;
const ENTRY_MIN_LP_LOCK_PERCENT = 70;
const REENTRY_MAX_LIQUIDITY_DRAWDOWN = 0.12;
const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 20;
const TAKE_PROFIT_1_ORIGINAL_POSITION_PERCENT = 40;
const TAKE_PROFIT_2_PERCENT = 40;
const TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT = 80;
const TRAILING_STOP_PERCENT = 12;
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
  return path.join(path.resolve(directory), "v31ReentryState.json");
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

function getOriginalPositionExitProgress(position, history) {
  if (!position) return { originalQuantity: 0, quantitySold: 0, soldPercent: 0 };
  const positionId = position.id || position.positionId;
  const events = Array.isArray(history)
    ? history.filter(row => row && row.positionId === positionId)
    : [];
  const buy = events.find(row => row.type === "BUY");
  const quantitySold = events
    .filter(row => row.type === "SELL")
    .reduce((sum, row) => sum + Math.max(0, Number(row.quantitySold) || 0), 0);
  const originalQuantity = Math.max(
    0,
    Number(buy && buy.quantity) || Number(position.quantity) + quantitySold
  );
  return {
    originalQuantity,
    quantitySold,
    soldPercent: originalQuantity > 0 ? quantitySold / originalQuantity * 100 : 0
  };
}

function percentOfRemainingToReachOriginalTarget(position, history, targetPercent) {
  const progress = getOriginalPositionExitProgress(position, history);
  if (!(position && Number(position.quantity) > 0 && progress.originalQuantity > 0)) return 0;
  const targetQuantity = progress.originalQuantity * Number(targetPercent) / 100;
  const quantityToSell = Math.max(0, Math.min(Number(position.quantity), targetQuantity - progress.quantitySold));
  return quantityToSell / Number(position.quantity) * 100;
}

function createBot({
  trader = paperTrader,
  getTokenData = market.getTokenData,
  getTokensData = market.getTokensData,
  batchPositionPrices = false,
  lockPositionPair = false,
  discoverCandidates = scanner.discoverCandidates,
  timers = globalThis,
  notifier = telegram,
  checkLiquidityLock = getLockStatus,
  positionMonitorMs = POSITION_MONITOR_MS,
  scannerIntervalMs = SCANNER_INTERVAL_MS,
  botLabel = "New V3.1 Version - Original Entries",
  reentryStateFile = defaultReentryStateFile(),
  maxOpenPositions = MAX_OPEN_POSITIONS,
  maxCandidateAgeMinutes = null,
  minimumLiquidityUsd = 25000,
  minimumVolume24hUsd = 100000,
  minimumLiquidityLockPercent = ENTRY_MIN_LP_LOCK_PERCENT,
  acceptedSignals = ["STRONG BUY"],
  requireLiquidityLock = true,
  allowUnknownLiquidityLock = false,
  useReentryGuards = false,
  useSimpleCooldown = true,
  exitDecision = null,
  pauseEntriesAtBalance = null,
  entryPauseStateFile = null
} = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
  const configuredLockPercent = Number(minimumLiquidityLockPercent);
  const minimumEntryLockPercent = Number.isFinite(configuredLockPercent) && configuredLockPercent >= 0 && configuredLockPercent <= 100
    ? configuredLockPercent
    : ENTRY_MIN_LP_LOCK_PERCENT;
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
  let entriesPaused = false;
  let pauseAlertSent = false;
  if (entryPauseStateFile && fs.existsSync(entryPauseStateFile)) {
    try {
      entriesPaused = JSON.parse(fs.readFileSync(entryPauseStateFile, "utf8")).paused === true;
      pauseAlertSent = entriesPaused;
    } catch (error) {
      throw new Error("Unable to read entry-pause state: " + error.message);
    }
  }
  const tokenCooldowns = loadReentryGuards(reentryStateFile);
  const simpleCooldowns = new Map();
  const isActive = session => activeSession === session && !session.signal.aborted;
  const getPositions = () => {
    const portfolio = getPortfolio();
    return Array.isArray(portfolio.positions)
      ? portfolio.positions
      : (portfolio.position ? [portfolio.position] : []);
  };
  const getCurrentBalance = () => {
    const portfolio = getPortfolio();
    return (Number(portfolio.cashBalance) || 0) +
      getPositions().reduce((sum, position) => sum + (Number(position.amountInvested) || 0), 0);
  };
  const entriesPausedByBalance = () => {
    if (entriesPaused) return true;
    const threshold = Number(pauseEntriesAtBalance);
    if (Number.isFinite(threshold) && threshold > 0 && getCurrentBalance() <= threshold) {
      entriesPaused = true;
      if (entryPauseStateFile) {
        try {
          fs.mkdirSync(path.dirname(entryPauseStateFile), { recursive: true });
          const temporary = entryPauseStateFile + "." + process.pid + "." + Date.now() + ".tmp";
          fs.writeFileSync(temporary, JSON.stringify({ paused: true, balance: getCurrentBalance(), threshold, at: new Date().toISOString() }), { flag: "wx" });
          fs.renameSync(temporary, entryPauseStateFile);
        } catch (error) {
          console.error("Unable to persist entry-pause state:", error.message);
        }
      }
      if (!pauseAlertSent) {
        pauseAlertSent = true;
        const message = botLabel + " paused new entries: balance reached $" + threshold.toFixed(2) + ". Existing positions remain monitored.";
        console.error(message);
        void notifier.notifyCritical(message);
      }
    }
    return entriesPaused;
  };

  function startCooldown(tokenAddress, symbol, reason) {
    simpleCooldowns.set(tokenAddress, Date.now());
    console.log(`COOLDOWN STARTED | ${symbol} | 60 minutes | ${reason}`);
  }

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
    if (entriesPausedByBalance()) return;
    if (getPositions().length >= maxOpenPositions) {
      console.log("All " + maxOpenPositions + " " + botLabel + " slots are occupied. Skipping new entry.");
      return;
    }

    const discoveredCandidates = await discoverCandidates({
      signal: session.signal,
      minimumLiquidityUsd,
      minimumVolume24hUsd
    });
    const maxAgeMinutes = Number(maxCandidateAgeMinutes);
    const candidates = Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0
      ? discoveredCandidates.filter(coin => {
        const createdAt = Number(coin.pairCreatedAt);
        const ageMs = Date.now() - createdAt;
        return Number.isFinite(createdAt) && createdAt > 0 &&
          ageMs >= 0 && ageMs <= maxAgeMinutes * 60 * 1000;
      })
      : discoveredCandidates;
    if (Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0) {
      console.log(`NEW TOKEN AGE FILTER | max ${maxAgeMinutes}m | ${candidates.length}/${discoveredCandidates.length} candidates kept`);
    }
    if (!isActive(session) || entriesPausedByBalance() || getPositions().length >= maxOpenPositions) return;
    if (useReentryGuards) syncClosedTokenGuards();
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const openTokens = new Set(getPositions().map(position => position.tokenAddress));
    const availableCandidates = candidates.filter(coin => {
      if (openTokens.has(coin.tokenAddress)) return false;
      if (!useSimpleCooldown || useReentryGuards) return true;
      const closedAt = simpleCooldowns.get(coin.tokenAddress);
      if (!closedAt) return true;
      if (Date.now() - closedAt >= TOKEN_COOLDOWN_MS) {
        simpleCooldowns.delete(coin.tokenAddress);
        return true;
      }
      return false;
    });
    const freeSlots = Math.max(0, maxOpenPositions - getPositions().length);
    const buyCandidates = availableCandidates.filter(
      coin => acceptedSignals.includes(coin.signal) && !openTokens.has(coin.tokenAddress)
    );
    const selected = [];

    for (const coin of buyCandidates) {
      if (!tokenLossGuard.allows(coin)) continue;
      let lock = null;
      if (requireLiquidityLock) {
        lock = await checkLiquidityLock(coin.tokenAddress);
        if (!isActive(session)) return;
        if (!liquidityLockAllowsEntry(lock, minimumEntryLockPercent, allowUnknownLiquidityLock)) {
          const rawLockPercent = lock?.lockedPercent;
          const lockPercent = Number(rawLockPercent);
          const lockDisplay = rawLockPercent === null || rawLockPercent === undefined ||
            (typeof rawLockPercent === "string" && rawLockPercent.trim() === "") || !Number.isFinite(lockPercent)
            ? "unknown"
            : lockPercent.toFixed(1) + "%";
          console.log(`LP LOCK GATE | ${coin.symbol} | skipped | locked ${lockDisplay} | required ${minimumEntryLockPercent}% | ${lock?.reason || "LOCK_STATUS_UNAVAILABLE"}`);
          continue;
        }
        if (lock?.lockedPercent === null || lock?.lockedPercent === undefined) {
          console.log(`LP LOCK GATE | ${coin.symbol} | PAPER entry allowed | RugCheck status unavailable; lock is unconfirmed`);
          coin.reasons = [
            ...(Array.isArray(coin.reasons) ? coin.reasons : []),
            "Paper-only entry allowed with unavailable LP lock status; lock is unconfirmed"
          ];
        } else {
          coin.reasons = [
            ...(Array.isArray(coin.reasons) ? coin.reasons : []),
            `LP lock ${Number(lock.lockedPercent).toFixed(1)}% confirmed by RugCheck`
          ];
        }
      }
      const guard = useReentryGuards ? tokenCooldowns.get(coin.tokenAddress) : null;
      if (guard && !guard.released && !observeReentry(coin, lock)) continue;
      selected.push(coin);
      if (selected.length >= freeSlots) break;
    }

    if (!selected.length) {
      console.log(`No BUY or STRONG BUY candidate with confirmed LP lock >=${minimumEntryLockPercent}% available.`);
      return;
    }

    for (const coin of selected) {
      if (!isActive(session) || entriesPausedByBalance() || getPositions().length >= maxOpenPositions) break;
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
    const snapshots = getPositions();
    let batchPrices = null;
    if (batchPositionPrices && snapshots.length) {
      try {
        batchPrices = await getTokensData(snapshots.map(position => position.tokenAddress), { signal: session.signal,
          ...(lockPositionPair ? { pairAddresses: new Map(snapshots.map(p => [p.tokenAddress, p.pairAddress])) } : {}) });
      } catch (error) {
        if (isActive(session)) console.warn("Batched position price refresh failed:", error.message);
        return;
      }
    }
    for (const snapshot of snapshots) {
      if (!isActive(session)) return;
      const expectedPosition = positionKey(snapshot);
      const tokenAddress = snapshot.tokenAddress;
      const freshData = batchPrices ? (batchPrices.get(tokenAddress) || null) : await getTokenData(tokenAddress, { signal: session.signal, ...(lockPositionPair ? { pairAddress: snapshot.pairAddress } : {}) });
      let position = getPositions().find(item => positionKey(item) === expectedPosition);
      if (!isActive(session) || !position || !freshData) continue;

      if (lockPositionPair && (!position.pairAddress || freshData.pairAddress !== position.pairAddress || freshData.tokenAddress !== tokenAddress)) continue;
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
        const result = sell(currentPrice, percent, { expectedPosition, reason, liquidityUsd: freshData.liquidityUsd });
        if (result.success) {
          if (percent === 100) {
            if (useReentryGuards) syncClosedTokenGuards();
            if (useSimpleCooldown) startCooldown(tokenAddress, position.symbol, reason);
          }
          void notifier.notifyTrade(reason, result.trade);
        }
        return result;
      };

      if (typeof exitDecision === "function") {
        const action = exitDecision({ position, freshData, currentPrice, profitPercent, now: Date.now() });
        if (action) {
          const result = action.writeOff && typeof trader.writeOff === "function"
            ? trader.writeOff(expectedPosition, action.reason)
            : sell(currentPrice, action.percent ?? 100, {
            expectedPosition,
            reason: action.reason,
            takeProfit: action.takeProfit,
            liquidityUsd: freshData.liquidityUsd
          });
          if (result.success) {
            if ((action.percent ?? 100) === 100 && useReentryGuards) syncClosedTokenGuards();
            void notifier.notifyTrade(action.reason, result.trade);
          }
        }
        continue;
      }

      if (profitPercent <= HARD_STOP_PERCENT) {
        exit("HARD STOP");
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

      const history = getPortfolio().history;
      const exitProgress = getOriginalPositionExitProgress(position, history);
      if (profitPercent >= TAKE_PROFIT_1_PERCENT &&
          exitProgress.soldPercent < TAKE_PROFIT_1_ORIGINAL_POSITION_PERCENT) {
        const percentToSell = percentOfRemainingToReachOriginalTarget(
          position, history, TAKE_PROFIT_1_ORIGINAL_POSITION_PERCENT
        );
        if (percentToSell > 0) {
          const result = sell(currentPrice, percentToSell, {
            expectedPosition,
            targetOriginalPositionPercent: TAKE_PROFIT_1_ORIGINAL_POSITION_PERCENT,
            reason: "TAKE PROFIT 1",
            liquidityUsd: freshData.liquidityUsd
          });
          if (result.success) void notifier.notifyTrade("TAKE PROFIT 1", result.trade);
        }
        continue;
      }
      if (profitPercent >= TAKE_PROFIT_2_PERCENT &&
          exitProgress.soldPercent < TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT) {
        const percentToSell = percentOfRemainingToReachOriginalTarget(
          position, history, TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT
        );
        if (percentToSell > 0) {
          const result = sell(currentPrice, percentToSell, {
            expectedPosition,
            targetOriginalPositionPercent: TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT,
            reason: "TAKE PROFIT 2",
            liquidityUsd: freshData.liquidityUsd
          });
          if (result.success) void notifier.notifyTrade("TAKE PROFIT 2", result.trade);
        }
        continue;
      }
      if (exitProgress.soldPercent >= TAKE_PROFIT_2_CUMULATIVE_ORIGINAL_POSITION_PERCENT &&
          dropFromHigh >= TRAILING_STOP_PERCENT) {
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

  function writeOffPosition(expectedPosition, reason = "MANUAL PAPER WRITE-OFF · NO LIQUIDITY") {
    if (typeof trader.writeOff !== "function") return { success: false, message: "Paper write-off is unavailable." };
    const result = trader.writeOff(expectedPosition, reason);
    if (result.success) {
      if (useReentryGuards) syncClosedTokenGuards();
      void notifier.notifyTrade(reason, result.trade);
    }
    return result;
  }

  function closePosition(expectedPosition, currentPrice, liquidityUsd, reason = "MANUAL EMERGENCY EXIT") {
    const position = getPositions().find(item => positionKey(item) === expectedPosition);
    if (!position) return { success: false, error: "Position is no longer open." };
    const result = sell(Number(currentPrice), 100, { expectedPosition, reason, liquidityUsd: Number(liquidityUsd) });
    if (result.success) {
      if (useReentryGuards) syncClosedTokenGuards();
      void notifier.notifyTrade(reason, result.trade);
    }
    return result;
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
    closePosition,
    writeOffPosition,
    getBotStatus: () => activeSession !== null,
    getLastError: () => lastError,
    getEntriesPaused: () => entriesPaused || entriesPausedByBalance()
  };
}

module.exports = {
  createBot,
  getOriginalPositionExitProgress,
  percentOfRemainingToReachOriginalTarget,
  ...createBot()
};
