const market = require("./dexscreener");
const scanner = require("./scanner");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const ENTRY_CONFIRMATION_MS = 60 * 1000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const TOKEN_DIVERSITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LOSS_ENTRIES_PER_TOKEN_24H = 2;
const MAX_RUNNER_ENTRIES_PER_TOKEN_24H = 3;
const RUNNER_MAX_GAIN_PERCENT = 30;
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


function recentTokenStats(history = [], now = Date.now()) {
  const cutoff = now - TOKEN_DIVERSITY_WINDOW_MS;
  const positions = new Map();

  for (const trade of history) {
    if (!trade?.tokenAddress || !trade?.entryTime) continue;
    const entryMs = Date.parse(trade.entryTime);
    if (!Number.isFinite(entryMs)) continue;

    const key = trade.positionId || `${trade.tokenAddress}|${trade.entryTime}`;
    if (!positions.has(key)) {
      positions.set(key, {
        tokenAddress: trade.tokenAddress,
        entryTime: entryMs,
        quantityBought: 0,
        quantitySold: 0,
        pnl: 0,
        completed: false,
        maxGainPercent: null,
        lastExitAt: null
      });
    }

    const position = positions.get(key);
    if (trade.type === "BUY") {
      position.quantityBought += Number(trade.quantity) || 0;
    } else if (trade.type === "SELL") {
      position.quantitySold += Number(trade.quantitySold) || 0;
      position.pnl += Number(trade.pnl) || 0;
      const exitMs = Date.parse(trade.exitTime);
      if (Number.isFinite(exitMs)) position.lastExitAt = Math.max(position.lastExitAt || 0, exitMs);
      if (Number(trade.percentSold) === 100) position.completed = true;
    }

    const entryPrice = Number(trade.entryPrice);
    const highestPrice = Number(trade.highestPrice);
    if (entryPrice > 0 && highestPrice > 0) {
      const gain = (highestPrice - entryPrice) / entryPrice * 100;
      position.maxGainPercent = position.maxGainPercent == null
        ? gain
        : Math.max(position.maxGainPercent, gain);
    }
  }

  const byToken = new Map();
  for (const position of positions.values()) {
    if (
      !position.completed &&
      position.quantityBought > 0 &&
      position.quantitySold >= position.quantityBought * (1 - 1e-10)
    ) {
      position.completed = true;
    }

    const enteredRecently = position.entryTime >= cutoff;
    const exitedRecently = Number.isFinite(position.lastExitAt) && position.lastExitAt >= cutoff;
    if (!enteredRecently && !exitedRecently) continue;

    if (!byToken.has(position.tokenAddress)) {
      byToken.set(position.tokenAddress, {
        entries: 0,
        winningCompletions: 0,
        losingCompletions: 0,
        maxGainPercent: null,
        lastExitAt: null
      });
    }

    const stats = byToken.get(position.tokenAddress);
    if (enteredRecently) stats.entries++;
    if (position.completed && exitedRecently) {
      if (position.pnl > 0) stats.winningCompletions++;
      else if (position.pnl < 0) stats.losingCompletions++;
    }
    if ((enteredRecently || exitedRecently) && Number.isFinite(position.maxGainPercent)) {
      stats.maxGainPercent = stats.maxGainPercent == null
        ? position.maxGainPercent
        : Math.max(stats.maxGainPercent, position.maxGainPercent);
    }
    if (exitedRecently) {
      stats.lastExitAt = Math.max(stats.lastExitAt || 0, position.lastExitAt);
    }
  }

  return byToken;
}

function buyRatio5m(coin) {
  const buys = Number(coin?.buys5m) || 0;
  const sells = Number(coin?.sells5m) || 0;
  const total = buys + sells;
  return total > 0 ? buys / total : 0;
}

function exceptionalRunnerReentry(coin) {
  const change5m = Number(coin?.priceChange5m) || 0;
  const change1h = Number(coin?.priceChange1h) || 0;
  const transactions = (Number(coin?.buys5m) || 0) + (Number(coin?.sells5m) || 0);
  return (
    coin?.signal === "STRONG BUY" &&
    Number(coin?.score) >= 10 &&
    change5m >= 0.50 &&
    change5m < 4 &&
    change1h >= 1 &&
    change1h <= 20 &&
    buyRatio5m(coin) >= 0.60 &&
    transactions >= 20
  );
}

function diversityDecision(coin, stats) {
  if (!stats) {
    return { eligible: true, priority: 0, reason: "NEW TOKEN" };
  }

  const runner = Number(stats.maxGainPercent) >= RUNNER_MAX_GAIN_PERCENT;

  if (runner) {
    if (
      stats.entries < MAX_RUNNER_ENTRIES_PER_TOKEN_24H &&
      exceptionalRunnerReentry(coin)
    ) {
      return { eligible: true, priority: 2, reason: "RUNNER REENTRY" };
    }
    return { eligible: false, priority: 99, reason: "RUNNER WAITING FOR EXCEPTIONAL REENTRY" };
  }

  if (stats.winningCompletions > 0) {
    return { eligible: false, priority: 99, reason: "NORMAL WINNER REST 24H" };
  }

  if (stats.losingCompletions > 0 || stats.entries > 0) {
    if (stats.entries >= MAX_LOSS_ENTRIES_PER_TOKEN_24H) {
      return { eligible: false, priority: 99, reason: "LOSS REENTRY LIMIT 24H" };
    }
    return { eligible: true, priority: 1, reason: "LOSS SECOND CHANCE" };
  }

  return { eligible: true, priority: 0, reason: "NEW TOKEN" };
}

function createBot({ trader = paperTrader, getTokenData = market.getTokenData,
  discoverCandidates = scanner.discoverCandidates, timers = globalThis,
  notifier = telegram } = {}) {
  const { buy, sell, getPortfolio, enableRiskManagement, updateHigh, positionKey } = trader;
  let activeSession = null;
  let scannerInterval = null;
  let positionInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const isActive = session => activeSession === session && !session.signal.aborted;
  const tokenCooldowns = new Map();

  function startCooldown(tokenAddress, symbol, reason) {
    tokenCooldowns.set(tokenAddress, Date.now());
    console.log(`COOLDOWN STARTED | ${symbol} | 60 minutes | ${reason}`);
  }

  async function runScanner(session) {
    console.log("\nStarting automatic Solana scan...\n");
    const portfolio = getPortfolio();
    if (portfolio.position) {
      console.log(`Position already active: ${portfolio.position.symbol}. Skipping new entry.`);
      return;
    }

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || getPortfolio().position) return;
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const now = Date.now();
    const statsByToken = recentTokenStats(getPortfolio().history, now);
    const rankedCandidates = [];

    for (const coin of candidates) {
      const stats = statsByToken.get(coin.tokenAddress);
      const memoryCooldown = tokenCooldowns.get(coin.tokenAddress);
      const persistentCooldown = stats?.lastExitAt || 0;
      const cooldownStarted = Math.max(memoryCooldown || 0, persistentCooldown);

      if (cooldownStarted && now - cooldownStarted < TOKEN_COOLDOWN_MS) {
        continue;
      }
      if (memoryCooldown && now - memoryCooldown >= TOKEN_COOLDOWN_MS) {
        tokenCooldowns.delete(coin.tokenAddress);
      }

      const diversity = diversityDecision(coin, stats);
      if (!diversity.eligible) {
        console.log(
          `DIVERSITY SKIP | ${coin.symbol} | ${diversity.reason} | Entries24h: ${stats?.entries || 0} | MaxGain: ${Number(stats?.maxGainPercent || 0).toFixed(2)}%`
        );
        continue;
      }

      rankedCandidates.push({ coin, diversity });
    }

    rankedCandidates.sort((a, b) =>
      a.diversity.priority - b.diversity.priority ||
      Number(b.coin.score || 0) - Number(a.coin.score || 0) ||
      Number(a.coin.discoveryPriority ?? 3) - Number(b.coin.discoveryPriority ?? 3)
    );

    const availableCandidates = rankedCandidates.map(item => item.coin);
    if (!availableCandidates.length) {
      console.log("No candidates available after cooldown and diversity rules.");
      return;
    }

    const bestEntry = rankedCandidates.find(item => item.coin.signal === "STRONG BUY");
    const bestCoin = bestEntry?.coin;
    if (!bestCoin) {
      console.log("No STRONG BUY candidate available.");
      return;
    }

    console.log(
      `DIVERSITY SELECT | ${bestCoin.symbol} | ${bestEntry.diversity.reason} | Priority ${bestEntry.diversity.priority}`
    );

    console.log("\nBOT SELECTED FOR CONFIRMATION:");
    console.log(`${bestCoin.symbol} - ${bestCoin.name}`);
    console.log(`Score: ${bestCoin.score}`);
    console.log(`Signal: ${bestCoin.signal}`);
    console.log(`5m Momentum: ${bestCoin.priceChange5m}%`);
    console.log(`1h Momentum: ${bestCoin.priceChange1h}%`);
    console.log(`5m Buys/Sells: ${bestCoin.buys5m}/${bestCoin.sells5m}`);
    console.log(`5m Volume: ${Number(bestCoin.volume5m || 0).toFixed(2)}`);
    console.log(`15m Observed Extension: ${Number(bestCoin.postPump?.extensionPercent || 0).toFixed(2)}%`);
    if (bestCoin.smartMoney) {
      console.log(`Smart Money: Net $ ${Number(bestCoin.smartMoney.netFlow || 0).toFixed(2)} | Traders: ${Number(bestCoin.smartMoney.smartTraders || 0)}`);
    }

    console.log(`ENTRY CONFIRMATION START | ${bestCoin.symbol} | Waiting ${ENTRY_CONFIRMATION_MS / 1000}s for fresh requalification`);
    await new Promise(resolve => (timers.setTimeout || globalThis.setTimeout)(resolve, ENTRY_CONFIRMATION_MS));

    if (!isActive(session) || getPortfolio().position) return;

    const confirmedCoin = await scanner.analyzeDiscoveredToken(bestCoin, session.signal);
    if (!isActive(session) || getPortfolio().position) return;

    if (!confirmedCoin || confirmedCoin.signal !== "STRONG BUY") {
      console.log(
        `ENTRY CONFIRMATION FAIL | ${bestCoin.symbol} | Signal: ${confirmedCoin?.signal || "NO DATA"} | 5m: ${Number(confirmedCoin?.priceChange5m || 0).toFixed(2)}% | Buy Ratio: ${(
          (() => {
            const buys = Number(confirmedCoin?.buys5m) || 0;
            const sells = Number(confirmedCoin?.sells5m) || 0;
            return buys + sells > 0 ? buys / (buys + sells) * 100 : 0;
          })()
        ).toFixed(1)}%`
      );
      return;
    }

    confirmedCoin.smartMoney = bestCoin.smartMoney ? structuredClone(bestCoin.smartMoney) : null;
    confirmedCoin.entryConfirmation = {
      requiredMs: ENTRY_CONFIRMATION_MS,
      passedAt: new Date().toISOString(),
      initialPrice: Number(bestCoin.priceUsd) || null,
      confirmedPrice: Number(confirmedCoin.priceUsd) || null,
      priceMovePercent:
        Number(bestCoin.priceUsd) > 0 && Number(confirmedCoin.priceUsd) > 0
          ? (Number(confirmedCoin.priceUsd) - Number(bestCoin.priceUsd)) / Number(bestCoin.priceUsd) * 100
          : null,
      initial5m: Number(bestCoin.priceChange5m) || 0,
      confirmed5m: Number(confirmedCoin.priceChange5m) || 0,
      initialScore: Number(bestCoin.score) || 0,
      confirmedScore: Number(confirmedCoin.score) || 0
    };

    console.log(
      `ENTRY CONFIRMATION PASS | ${confirmedCoin.symbol} | Score: ${confirmedCoin.score} | 5m: ${Number(confirmedCoin.priceChange5m || 0).toFixed(2)}% | Price move during confirmation: ${Number(confirmedCoin.entryConfirmation.priceMovePercent || 0).toFixed(2)}%`
    );

    const trade = buy(confirmedCoin);
    if (trade.success) void notifier.notifyTrade("BUY", trade.trade);
    console.log("\nPAPER TRADE:", trade);
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
    const portfolio = getPortfolio();
    if (!portfolio.position) return;
    let position = portfolio.position;
    const expectedPosition = positionKey(position);
    const tokenAddress = position.tokenAddress;
    const freshData = await getTokenData(tokenAddress, { signal: session.signal, pairAddress: position.pairAddress || undefined });
    if (!isActive(session) || positionKey(getPortfolio().position) !== expectedPosition) return;
    if (!freshData) {
      console.log(`POSITION DATA UNAVAILABLE | ${position.symbol} | Pair lock: ${position.pairAddress || "legacy/unlocked"}`);
      return;
    }

    const currentPrice = Number(freshData.priceUsd);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const manualExitPositionId = String(process.env.MANUAL_EXIT_POSITION_ID || "").trim();
    if (manualExitPositionId && expectedPosition === manualExitPositionId) {
      console.log(`MANUAL EXIT TARGET MATCH | ${position.symbol} | ${expectedPosition}`);
      const result = sell(currentPrice, 100, {
        expectedPosition,
        reason: "MANUAL EXIT"
      });
      if (result.success) {
        console.log(`MANUAL EXIT COMPLETED | ${position.symbol} | Price: ${currentPrice}`);
        void notifier.notifyTrade("MANUAL EXIT", result.trade);
      } else {
        console.log(`MANUAL EXIT FAILED | ${position.symbol} | ${result.message}`);
      }
      return;
    }

    updateHigh(expectedPosition, currentPrice);
    position = getPortfolio().position;
    const entryPrice = Number(position.entryPrice);
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const highestProfitPercent = ((position.highestPrice - entryPrice) / entryPrice) * 100;
    const profitLockFloor = highestProfitPercent - PROFIT_LOCK_TRAIL_POINTS;
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
        startCooldown(tokenAddress, position.symbol, reason);
        void notifier.notifyTrade(reason, result.trade);
      }
      return result;
    };
    if (profitPercent <= HARD_STOP_PERCENT) return void exit("HARD STOP");

    const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
    const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
    const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS && momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
    const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS && momentum5m <= MOMENTUM_EXIT_STRONG_5M;
    if (momentumExitA || momentumExitB) return void exit("MOMENTUM EXIT");

    const profitLockEligible =
      position.riskManagementVersion === "V3.4" ||
      position.strategyVersion === "V3.3" ||
      position.strategyVersion === "V3.4";
    const profitLockActive =
      profitLockEligible &&
      !position.secondTakeProfitDone &&
      highestProfitPercent >= PROFIT_LOCK_TRIGGER_PERCENT;
    if (profitLockActive && profitPercent <= profitLockFloor) {
      return void exit("PROFIT LOCK");
    }

    if (profitPercent >= TAKE_PROFIT_1_PERCENT && !position.firstTakeProfitDone) {
      const result = sell(currentPrice, TAKE_PROFIT_1_SELL_PERCENT, { expectedPosition, takeProfit: "firstTakeProfitDone", reason: "TAKE PROFIT 1" });
      if (result.success) void notifier.notifyTrade("TAKE PROFIT 1", result.trade);
      return;
    }
    if (profitPercent >= TAKE_PROFIT_2_PERCENT && position.firstTakeProfitDone && !position.secondTakeProfitDone) {
      const result = sell(currentPrice, TAKE_PROFIT_2_SELL_PERCENT, { expectedPosition, takeProfit: "secondTakeProfitDone", reason: "TAKE PROFIT 2" });
      if (result.success) void notifier.notifyTrade("TAKE PROFIT 2", result.trade);
      return;
    }
    if (position.secondTakeProfitDone && dropFromHigh >= TRAILING_STOP_PERCENT) exit("TRAILING STOP");
  }

  async function tick(kind, session = activeSession) {
    if (!session || !isActive(session)) return;
    if (kind === "scanner" ? scannerBusy : monitorBusy) return;
    if (kind === "scanner") scannerBusy = true; else monitorBusy = true;
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
      if (kind === "scanner") scannerBusy = false; else monitorBusy = false;
    }
  }
  function startBot() {
    if (activeSession) return;
    // Validate/load the account before announcing that trading is running.
    const portfolio = getPortfolio();
    if (
      portfolio.position &&
      typeof enableRiskManagement === "function" &&
      portfolio.position.riskManagementVersion !== "V3.4"
    ) {
      const expectedPosition = positionKey(portfolio.position);
      const migrated = enableRiskManagement(expectedPosition, "V3.4");
      if (!migrated.success) throw new Error(migrated.message);
      if (migrated.changed) {
        console.log(`RISK MANAGEMENT MIGRATED | ${portfolio.position.symbol} | Entry strategy ${portfolio.position.strategyVersion || "legacy"} -> Risk V3.4`);
      }
    }
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("BOT STARTED | Entry V4.4 7.5K-Volume 60s Requalification + Verified Wrapped Asset Security + Activity Confirmation + Pump Structure Protection | Risk V3.4 Profit Lock + Runner");
    positionInterval = timers.setInterval(() => tick("monitor", session), POSITION_MONITOR_MS);
    scannerInterval = timers.setInterval(() => tick("scanner", session), SCANNER_INTERVAL_MS);
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
  return { startBot, stopBot, getBotStatus: () => activeSession !== null,
    getLastError: () => lastError };
}
module.exports = {
  createBot,
  recentTokenStats,
  exceptionalRunnerReentry,
  diversityDecision,
  ...createBot()
};
