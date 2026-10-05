const market = require("./dexscreener");
const scanner = require("./scanner");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const LOSING_TOKEN_COOLDOWN_MS = 90 * 60 * 1000;
const HARD_STOP_OR_STREAK_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const LOSS_STREAK_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const REENTRY_COOL_1H_MAX = 10;
const REENTRY_CONFIRMATION_MAX_GAP_MS = SCANNER_INTERVAL_MS * 2;
const REENTRY_MIN_VOLUME_5M_USD = 5000;
const REENTRY_MIN_VOLUME_LIQUIDITY_RATIO = 0.10;
const REENTRY_MIN_BUY_RATIO = 0.60;
const REENTRY_MIN_TRANSACTIONS_5M = 30;
const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 25;
const TAKE_PROFIT_2_PERCENT = 30;
const TAKE_PROFIT_2_SELL_PERCENT = 35;
const TRAILING_STOP_PERCENT = 8;
const PROFIT_LOCK_TRIGGER_PERCENT = 10;
const PROFIT_LOCK_FLOOR_PERCENT = 4;
const MOMENTUM_EXIT_MIN_LOSS = -2;
const MOMENTUM_EXIT_5M = -3;
const MOMENTUM_EXIT_STRONG_LOSS = -5;
const MOMENTUM_EXIT_STRONG_5M = -1;
const MOMENTUM_EXIT_BUY_RATIO = 0.45;
const MOMENTUM_EXIT_MIN_TRANSACTIONS = 10;

function createBot({ trader = paperTrader, getTokenData = market.getTokenData,
  discoverCandidates = scanner.discoverCandidates, timers = globalThis,
  notifier = telegram, positionMonitorMs = POSITION_MONITOR_MS,
  scannerIntervalMs = SCANNER_INTERVAL_MS,
  botLabel = "V3.1-3Slot + 10% Compound", maxOpenPositions = 3,
  exitPolicy = null } = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
  let activeSession = null;
  let scannerInterval = null;
  let positionInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;
  const isActive = session => activeSession === session && !session.signal.aborted;
  const reentryObservations = new Map();

  function startCooldown(tokenAddress, symbol, reason) {
    const cooldown = getTokenCooldown(tokenAddress, getPortfolio(), Date.now());
    const minutes = cooldown ? Math.ceil(cooldown.remainingMs / 60000) : 0;
    console.log(`COOLDOWN STARTED | ${symbol} | ${minutes} minutes | ${reason}`);
  }

  function getTokenCooldown(tokenAddress, portfolio, now) {
    const sellsByPosition = new Map();
    for (const trade of portfolio.history || []) {
      if (trade?.type !== "SELL" || trade.tokenAddress !== tokenAddress || !trade.positionId) continue;
      const events = sellsByPosition.get(trade.positionId) || [];
      events.push(trade);
      sellsByPosition.set(trade.positionId, events);
    }

    const closedPositions = [...sellsByPosition.values()]
      .filter(events => events.some(event => Number(event.percentSold) === 100))
      .map(events => {
        events.sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
        const closingEvent = [...events].reverse().find(event => Number(event.percentSold) === 100);
        return {
          closedAt: Date.parse(closingEvent?.exitTime),
          pnl: events.reduce((sum, event) => sum + (Number(event.pnl) || 0), 0),
          reason: closingEvent?.reason
        };
      })
      .filter(position => Number.isFinite(position.closedAt))
      .sort((a, b) => b.closedAt - a.closedAt);

    const latest = closedPositions[0];
    if (!latest) return null;
    const recentLossStreak = closedPositions
      .filter(position => position.closedAt >= now - LOSS_STREAK_LOOKBACK_MS)
      .reduce((streak, position) => {
        if (streak.stopped || position.pnl >= 0) return { ...streak, stopped: true };
        return { count: streak.count + 1, stopped: false };
      }, { count: 0, stopped: false }).count;

    const cooldownMs = latest.pnl >= 0
      ? TOKEN_COOLDOWN_MS
      : latest.reason === "HARD STOP" || recentLossStreak >= 2
        ? HARD_STOP_OR_STREAK_COOLDOWN_MS
        : LOSING_TOKEN_COOLDOWN_MS;
    const remainingMs = latest.closedAt + cooldownMs - now;
    if (latest.pnl < 0) {
      // Losing tokens stay locked after the timer expires until a confirmed high-volume re-entry.
      return { remainingMs: Math.max(0, remainingMs), loss: true };
    }
    return remainingMs > 0 ? { remainingMs, loss: false } : null;
  }

  function confirmsFreshReentry(coin, now) {
    const tokenAddress = coin.tokenAddress;
    const buyCount = Number(coin.buys5m) || 0;
    const sellCount = Number(coin.sells5m) || 0;
    const totalTransactions = buyCount + sellCount;
    const buyRatio = totalTransactions ? buyCount / totalTransactions : 0;
    const liquidityUsd = Number(coin.liquidityUsd) || 0;
    const volume5m = Number(coin.volume5m) || 0;
    const requiredVolume5m = Math.max(
      REENTRY_MIN_VOLUME_5M_USD,
      liquidityUsd * REENTRY_MIN_VOLUME_LIQUIDITY_RATIO
    );
    const observation = {
      at: now,
      priceChange5m: Number(coin.priceChange5m) || 0,
      priceChange1h: Number(coin.priceChange1h) || 0,
      buyRatio,
      volume5m
    };
    const qualifies = coin.signal === "STRONG BUY" &&
      observation.priceChange1h > 0 && observation.priceChange1h <= REENTRY_COOL_1H_MAX &&
      observation.priceChange5m >= 0.25 && observation.priceChange5m <= 6 &&
      buyRatio >= REENTRY_MIN_BUY_RATIO &&
      totalTransactions >= REENTRY_MIN_TRANSACTIONS_5M &&
      volume5m >= requiredVolume5m;
    const previous = reentryObservations.get(tokenAddress);

    if (!qualifies) {
      reentryObservations.delete(tokenAddress);
      return false;
    }
    if (previous && now - previous.at <= REENTRY_CONFIRMATION_MAX_GAP_MS) {
      reentryObservations.delete(tokenAddress);
      return true;
    }
    reentryObservations.set(tokenAddress, observation);
    return false;
  }

  async function runScanner(session) {
    console.log("\nStarting automatic Solana scan...\n");
    const portfolio = getPortfolio();
    if ((portfolio.positions || []).length >= maxOpenPositions) { console.log(`All ${maxOpenPositions} slots occupied. Skipping new entry.`); return; }

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || (getPortfolio().positions || []).length >= maxOpenPositions) return;
    if (!candidates.length) {
      console.log("No candidates passed the filters.");
      return;
    }

    const now = Date.now();
    const availableCandidates = candidates.filter(coin => {
      const cooldown = getTokenCooldown(coin.tokenAddress, getPortfolio(), now);
      if (!cooldown) {
        reentryObservations.delete(coin.tokenAddress);
        return true;
      }
      if (!cooldown.loss) {
        reentryObservations.delete(coin.tokenAddress);
        console.log(`TOKEN COOLDOWN | ${coin.symbol} | ${Math.ceil(cooldown.remainingMs / 60000)} minutes remaining`);
        return false;
      }
      if (cooldown.remainingMs > 0) {
        reentryObservations.delete(coin.tokenAddress);
        console.log(`TOKEN LOSS COOLDOWN | ${coin.symbol} | ${Math.ceil(cooldown.remainingMs / 60000)} minutes remaining`);
        return false;
      }
      if (confirmsFreshReentry(coin, now)) {
        console.log(`COOLDOWN RELEASED | ${coin.symbol} | High-volume breakout confirmed`);
        return true;
      }
      console.log(`TOKEN LOSS LOCK | ${coin.symbol} | Waiting for confirmed high-volume breakout`);
      return false;
    });
    if (!availableCandidates.length) {
      console.log("All candidates are currently on cooldown.");
      return;
    }

    const openTokens = new Set((getPortfolio().positions || []).map(p => p.tokenAddress));
    const freeSlots = Math.max(0, maxOpenPositions - (getPortfolio().positions || []).length);
    const strongBuys = availableCandidates
      .filter(coin => coin.signal === "STRONG BUY" && !openTokens.has(coin.tokenAddress))
      .slice(0, freeSlots);

    if (!strongBuys.length) {
      console.log("No STRONG BUY candidate available.");
      return;
    }

    for (const coin of strongBuys) {
      console.log("\nBOT SELECTED:");
      console.log(`${coin.symbol} - ${coin.name}`);
      console.log(`Score: ${coin.score}`);
      console.log(`Signal: ${coin.signal}`);
      console.log(`5m Momentum: ${coin.priceChange5m}%`);
      console.log(`1h Momentum: ${coin.priceChange1h}%`);
      console.log(`5m Buys/Sells: ${coin.buys5m}/${coin.sells5m}`);

      const trade = buy(coin);
      if (trade.success) {
        reentryObservations.delete(coin.tokenAddress);
        openTokens.add(coin.tokenAddress);
        void notifier.notifyTrade("BUY", trade.trade);
      }
      console.log("\nPAPER TRADE:", trade);
      if ((getPortfolio().positions || []).length >= maxOpenPositions) break;
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
    const positions = getPortfolio().positions || [];
    for (const snapshot of positions) {
      if (!isActive(session)) return;
      let position = snapshot; const expectedPosition = positionKey(position); const tokenAddress = position.tokenAddress;
      const freshData = await getTokenData(tokenAddress,{signal:session.signal});
      const current = (getPortfolio().positions || []).find(p=>positionKey(p)===expectedPosition);
      if (!isActive(session) || !current || !freshData) continue;
      const currentPrice=Number(freshData.priceUsd); if(!Number.isFinite(currentPrice)||currentPrice<=0) continue;
      updateHigh(expectedPosition,currentPrice); position=(getPortfolio().positions||[]).find(p=>positionKey(p)===expectedPosition); if(!position) continue;
      const entryPrice=Number(position.entryPrice), profitPercent=((currentPrice-entryPrice)/entryPrice)*100;
      const dropFromHigh=((position.highestPrice-currentPrice)/position.highestPrice)*100;
      const highestProfitPercent=((Number(position.highestPrice)-entryPrice)/entryPrice)*100;
      const momentum5m=Number(freshData.priceChange5m)||0, buys5m=Number(freshData.buys5m)||0, sells5m=Number(freshData.sells5m)||0;
      const totalTransactions=buys5m+sells5m, buyRatio=totalTransactions?buys5m/totalTransactions:0;
      console.log(`V3.1 SLOT MONITOR | ${position.symbol} | P/L: ${profitPercent.toFixed(2)}%`);
      const exit=(reason,percent=100,extra={})=>{ const result=sell(currentPrice,percent,{expectedPosition,reason,...extra}); if(result.success){if(percent===100)startCooldown(tokenAddress,position.symbol,reason);void notifier.notifyTrade(reason,result.trade);} return result; };
      if (typeof exitPolicy === "function") {
        const decision = exitPolicy({ position, currentPrice, profitPercent, dropFromHigh,
          highestProfitPercent, freshData, now: Date.now() });
        if (decision && Number.isFinite(Number(decision.percent)) && decision.reason) {
          exit(decision.reason, Number(decision.percent), decision.takeProfit ? { takeProfit: decision.takeProfit } : {});
        }
        continue;
      }
      if(profitPercent<=HARD_STOP_PERCENT){exit("HARD STOP");continue;}
      const enoughActivity=totalTransactions>=MOMENTUM_EXIT_MIN_TRANSACTIONS, sellPressure=enoughActivity&&buyRatio<MOMENTUM_EXIT_BUY_RATIO;
      if((profitPercent<=MOMENTUM_EXIT_MIN_LOSS&&momentum5m<=MOMENTUM_EXIT_5M&&sellPressure)||(profitPercent<=MOMENTUM_EXIT_STRONG_LOSS&&momentum5m<=MOMENTUM_EXIT_STRONG_5M)){exit("MOMENTUM EXIT");continue;}
      const profitLockActive=highestProfitPercent>=PROFIT_LOCK_TRIGGER_PERCENT&&!position.secondTakeProfitDone;
      if(profitLockActive&&profitPercent<=PROFIT_LOCK_FLOOR_PERCENT){exit("PROFIT LOCK");continue;}
      if(profitPercent>=TAKE_PROFIT_1_PERCENT&&!position.firstTakeProfitDone){const r=sell(currentPrice,TAKE_PROFIT_1_SELL_PERCENT,{expectedPosition,takeProfit:"firstTakeProfitDone",reason:"TAKE PROFIT 1"});if(r.success)void notifier.notifyTrade("TAKE PROFIT 1",r.trade);continue;}
      if(profitPercent>=TAKE_PROFIT_2_PERCENT&&position.firstTakeProfitDone&&!position.secondTakeProfitDone){const r=sell(currentPrice,TAKE_PROFIT_2_SELL_PERCENT,{expectedPosition,takeProfit:"secondTakeProfitDone",reason:"TAKE PROFIT 2"});if(r.success)void notifier.notifyTrade("TAKE PROFIT 2",r.trade);continue;}
      if(position.secondTakeProfitDone&&dropFromHigh>=TRAILING_STOP_PERCENT) exit("TRAILING STOP");
    }
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
  return { startBot, stopBot, getBotStatus: () => activeSession !== null,
    getLastError: () => lastError };
}
module.exports = { createBot, ...createBot() };
