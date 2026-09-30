const market = require("./dexscreener");
const scanner = require("./scannerR3");
const trader = require("./paperTraderR3");

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const HARD_STOP_PERCENT = -10;
const TP1_PERCENT = 15;
const TP1_SELL_PERCENT = 15;
const TP2_PERCENT = 30;
const TP2_SELL_PERCENT = 35;
const TRAILING_STOP_PERCENT = 8;
const PROFIT_LOCK_START_MFE = 10;
const PROFIT_LOCK_DISTANCE = 8;

// R3-specific early failure protection.
const PROFIT_PROTECT_MFE = 6;
const PROFIT_PROTECT_DROP = 5;
const PROFIT_PROTECT_5M = -1;
const PROFIT_PROTECT_BUY_RATIO = 0.45;
const FAILED_CONTINUATION_MINUTES = 10;
const FAILED_CONTINUATION_MAX_MFE = 3;
const FAILED_CONTINUATION_5M = 0;
const FAILED_CONTINUATION_BUY_RATIO = 0.45;
const MIN_EXIT_TX = 10;

function createBotR3({
  getTokenData = market.getTokenData,
  discoverCandidates = scanner.discoverCandidatesR3,
  timers = globalThis
} = {}) {
  const { buy, sell, getPortfolio, updateHigh, positionKey } = trader;
  let activeSession = null;
  let scannerInterval = null;
  let monitorInterval = null;
  let scannerBusy = false;
  let monitorBusy = false;
  let lastError = null;

  const isActive = session => activeSession === session && !session.signal.aborted;

  async function runScanner(session) {
    if (getPortfolio().position) return;
    const candidates = await discoverCandidates({ signal: session.signal });
    if (!isActive(session) || getPortfolio().position) return;
    const coin = candidates.find(x => x.signal === "EARLY RUNNER");
    if (!coin) {
      console.log("R3 | No confirmed EARLY RUNNER.");
      return;
    }
    console.log(`R3 SELECTED | ${coin.symbol} | Score ${coin.score} | 5m ${coin.priceChange5m}% | Vol5m $${coin.volume5m || 0}`);
    console.log("R3 PAPER TRADE:", buy(coin));
  }

  async function monitorPosition(session) {
    const portfolio = getPortfolio();
    if (!portfolio.position) return;
    let position = portfolio.position;
    const expected = positionKey(position);
    const fresh = await getTokenData(position.tokenAddress, {
      signal: session.signal,
      pairAddress: position.pairAddress || undefined,
      referencePrice: Number(position.highestPrice || position.entryPrice) || undefined
    });
    if (!isActive(session) || positionKey(getPortfolio().position) !== expected || !fresh) return;

    const price = Number(fresh.priceUsd);
    if (!(price > 0)) return;

    const manualExitId = String(process.env.MANUAL_EXIT_POSITION_ID || "").trim();
    if (manualExitId && manualExitId === expected) {
      const manualResult = sell(price, 100, {
        expectedPosition: expected,
        reason: "MANUAL EXIT REQUESTED"
      });
      if (manualResult.success) {
        scanner.markExhausted(position.tokenAddress, {
          reason: "MANUAL EXIT REQUESTED",
          highestPrice: Number(position.highestPrice || position.entryPrice) || null,
          source: "R3"
        });
      }
      console.log(`R3 EXIT | ${position.symbol} | MANUAL EXIT REQUESTED`, manualResult);
      return;
    }

    updateHigh(expected, price);
    position = getPortfolio().position;

    const entry = Number(position.entryPrice);
    const high = Number(position.highestPrice || entry);
    const pnl = ((price - entry) / entry) * 100;
    const mfe = ((high - entry) / entry) * 100;
    const dropHigh = ((high - price) / high) * 100;
    const momentum5m = Number(fresh.priceChange5m) || 0;
    const buys = Number(fresh.buys5m) || 0;
    const sells = Number(fresh.sells5m) || 0;
    const tx = buys + sells;
    const buyRatio = tx ? buys / tx : 0;
    const ageMinutes = (Date.now() - Date.parse(position.entryTime)) / 60000;

    console.log(
      `R3 POSITION | ${position.symbol} | P/L ${pnl.toFixed(2)}% | MFE ${mfe.toFixed(2)}% | Drop ${dropHigh.toFixed(2)}% | 5m ${momentum5m.toFixed(2)}% | Buy ${(buyRatio * 100).toFixed(1)}%`
    );

    const exit = (reason, percent = 100, takeProfit = null) => {
      const result = sell(price, percent, { expectedPosition: expected, reason, takeProfit });
      if (result.success && percent === 100) {
        scanner.markExhausted(position.tokenAddress, {
          reason,
          highestPrice: high
        });
      }
      console.log(`R3 EXIT | ${position.symbol} | ${reason}`, result);
      return result;
    };

    if (pnl <= HARD_STOP_PERCENT) return void exit("HARD STOP");

    // Progressive profit lock: once MFE reaches +10%, protect MFE - 8%.
    // The floor ratchets upward automatically because highestPrice is persistent.
    // Example: MFE 10% -> +2% floor; 12.44% -> +4.44%; 20% -> +12%.
    // After TP2 the dedicated runner trailing logic takes over.
    const profitLockActive = !position.secondTakeProfitDone && mfe >= PROFIT_LOCK_START_MFE;
    const protectedFloorPercent = profitLockActive ? mfe - PROFIT_LOCK_DISTANCE : null;
    if (profitLockActive && pnl <= protectedFloorPercent) {
      return void exit("PROFIT LOCK");
    }

    const enoughActivity = tx >= MIN_EXIT_TX;
    const structureBroken =
      enoughActivity &&
      buyRatio < PROFIT_PROTECT_BUY_RATIO &&
      momentum5m <= PROFIT_PROTECT_5M;

    if (
      mfe >= PROFIT_PROTECT_MFE &&
      dropHigh >= PROFIT_PROTECT_DROP &&
      structureBroken
    ) {
      return void exit("PROFIT PROTECT - STRUCTURE FAILURE");
    }

    if (
      ageMinutes >= FAILED_CONTINUATION_MINUTES &&
      mfe < FAILED_CONTINUATION_MAX_MFE &&
      enoughActivity &&
      buyRatio < FAILED_CONTINUATION_BUY_RATIO &&
      momentum5m <= FAILED_CONTINUATION_5M
    ) {
      return void exit("FAILED CONTINUATION");
    }

    if (pnl >= TP1_PERCENT && !position.firstTakeProfitDone) {
      return void exit("TAKE PROFIT 1", TP1_SELL_PERCENT, "firstTakeProfitDone");
    }
    if (pnl >= TP2_PERCENT && position.firstTakeProfitDone && !position.secondTakeProfitDone) {
      return void exit("TAKE PROFIT 2", TP2_SELL_PERCENT, "secondTakeProfitDone");
    }
    if (position.secondTakeProfitDone && dropHigh >= TRAILING_STOP_PERCENT) {
      return void exit("TRAILING STOP");
    }
  }

  async function tick(kind, session = activeSession) {
    if (!session || !isActive(session)) return;
    if (kind === "scanner" ? scannerBusy : monitorBusy) return;
    if (kind === "scanner") scannerBusy = true; else monitorBusy = true;
    try {
      await (kind === "scanner" ? runScanner(session) : monitorPosition(session));
    } catch (error) {
      lastError = error.message;
      console.error("R3 paused:", error.message);
      stopBot();
    } finally {
      if (kind === "scanner") scannerBusy = false; else monitorBusy = false;
    }
  }

  function startBot() {
    if (activeSession) return;
    getPortfolio();
    lastError = null;
    const session = new AbortController();
    activeSession = session;
    console.log("R3 EARLY RUNNER STARTED | paper-only | separate account | V3.1R2 untouched");
    monitorInterval = timers.setInterval(() => tick("monitor", session), POSITION_MONITOR_MS);
    scannerInterval = timers.setInterval(() => tick("scanner", session), SCANNER_INTERVAL_MS);
    void tick("monitor", session);
    void tick("scanner", session);
  }

  function stopBot() {
    if (!activeSession) return;
    activeSession.abort();
    activeSession = null;
    timers.clearInterval(scannerInterval);
    timers.clearInterval(monitorInterval);
    scannerInterval = monitorInterval = null;
    console.log("R3 EARLY RUNNER STOPPED");
  }

  return {
    startBot,
    stopBot,
    getBotStatus: () => activeSession !== null,
    getLastError: () => lastError
  };
}

module.exports = { createBotR3, ...createBotR3() };
