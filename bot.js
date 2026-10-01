const market = require("./dexscreener");
const scanner = require("./scanner");
const paperTrader = require("./paperTrader");
const telegram = require("./telegram");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
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
    if ((portfolio.positions || []).length >= 3) { console.log("All 3 V3.1 slots occupied. Skipping new entry."); return; }

    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || (getPortfolio().positions || []).length >= 3) return;
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

    const openTokens = new Set((getPortfolio().positions || []).map(p => p.tokenAddress));
    const freeSlots = Math.max(0, 3 - (getPortfolio().positions || []).length);
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
        openTokens.add(coin.tokenAddress);
        void notifier.notifyTrade("BUY", trade.trade);
      }
      console.log("\nPAPER TRADE:", trade);
      if ((getPortfolio().positions || []).length >= 3) break;
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
      const exit=(reason,percent=100)=>{ const result=sell(currentPrice,percent,{expectedPosition,reason}); if(result.success){startCooldown(tokenAddress,position.symbol,reason);void notifier.notifyTrade(reason,result.trade);} return result; };
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
    console.log("BOT STARTED | V3.1-3Slot + 10% Compound");
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
