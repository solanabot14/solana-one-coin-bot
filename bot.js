const market = require("./dexscreener");
const scanner = require("./scanner");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");

const POSITION_MONITOR_MS = 2000;
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

function createBot({ trader = paperTrader, getTokenData = market.getTokenData,
  discoverCandidates = scanner.discoverCandidates, timers = globalThis,
  notifier = telegram } = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
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
    const availableCandidates = candidates.filter(coin => {
      const started = tokenCooldowns.get(coin.tokenAddress);
      if (!started) return true;
      if (now - started >= TOKEN_COOLDOWN_MS) {
        tokenCooldowns.delete(coin.tokenAddress);
        return true;
      }
      return false;
    });
    if (!availableCandidates.length) {
      console.log("All candidates are currently on cooldown.");
      return;
    }

    const bestCoin = availableCandidates.find(coin => coin.signal === "STRONG BUY");
    if (!bestCoin) {
      console.log("No STRONG BUY candidate available.");
      return;
    }

    console.log("\nBOT SELECTED:");
    console.log(`${bestCoin.symbol} - ${bestCoin.name}`);
    console.log(`Score: ${bestCoin.score}`);
    console.log(`Signal: ${bestCoin.signal}`);
    console.log(`5m Momentum: ${bestCoin.priceChange5m}%`);
    console.log(`1h Momentum: ${bestCoin.priceChange1h}%`);
    console.log(`5m Buys/Sells: ${bestCoin.buys5m}/${bestCoin.sells5m}`);

    const trade = buy(bestCoin);
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
    const freshData = await getTokenData(tokenAddress, { signal: session.signal });
    if (!isActive(session) || positionKey(getPortfolio().position) !== expectedPosition) return;
    if (!freshData) {
      console.log(`POSITION DATA UNAVAILABLE | ${position.symbol}`);
      return;
    }

    const currentPrice = Number(freshData.priceUsd);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;
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

    const profitLockActive =
      position.strategyVersion === "V3.3" &&
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
    getPortfolio();
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("BOT STARTED | Strategy V3.3 Profit Lock");
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
module.exports = { createBot, ...createBot() };
