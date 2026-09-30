const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function dataFile() {
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "tradingDataR3.json");
}

function createR3PaperTrader(file = dataFile()) {
  let state = { startingBalance: 100, cashBalance: 100, position: null, history: [] };
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));

  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: "wx" });
    fs.renameSync(tmp, file);
    state = next;
  }

  function positionKey(p) {
    return p ? (p.id || p.tokenAddress + "-" + p.entryTime) : null;
  }

  function buy(coin) {
    if (state.position) return { success: false, message: "A position is already open." };
    const price = Number(coin.priceUsd);
    if (!(price > 0) || !coin.tokenAddress) return { success: false, message: "Invalid token or price." };
    const next = structuredClone(state);
    const amountInvested = next.cashBalance * 0.10;
    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const tx = buys5m + sells5m;
    const buyRatio = tx ? buys5m / tx : 0;

    next.position = {
      id: randomUUID(),
      symbol: coin.symbol,
      name: coin.name,
      tokenAddress: coin.tokenAddress,
      pairAddress: coin.pairAddress || null,
      entryPrice: price,
      quantity: amountInvested / price,
      amountInvested,
      firstTakeProfitDone: false,
      secondTakeProfitDone: false,
      highestPrice: price,
      entryTime: new Date().toISOString(),
      strategyVersion: "R3-EARLY-RUNNER",
      entryScore: Number(coin.score) || 0,
      entrySignal: coin.signal || null,
      entryReasons: Array.isArray(coin.reasons) ? [...coin.reasons] : [],
      entryPriceChange5m: Number(coin.priceChange5m) || 0,
      entryPriceChange1h: Number(coin.priceChange1h) || 0,
      entryPriceChange24h: Number(coin.priceChange24h) || 0,
      entryLiquidityUsd: Number(coin.liquidityUsd) || 0,
      entryVolume5m: Number(coin.volume5m) || 0,
      entryVolume1h: Number(coin.volume1h) || 0,
      entryVolume24h: Number(coin.volume24h) || 0,
      entryBuys5m: buys5m,
      entrySells5m: sells5m,
      entryTransactions5m: tx,
      entryBuyRatio5m: buyRatio,
      r3Metrics: coin.r3Metrics || null,
      r3Security: coin.r3Security || null
    };
    next.cashBalance -= amountInvested;
    const trade = { type: "BUY", positionId: next.position.id, ...next.position };
    next.history.push(trade);
    save(next);
    return { success: true, trade: structuredClone(trade) };
  }

  function sell(currentPrice, percentToSell = 100, options = {}) {
    const p = state.position;
    if (!p) return { success: false, message: "No position is open." };
    if (options.expectedPosition && options.expectedPosition !== positionKey(p)) {
      return { success: false, message: "Position changed." };
    }
    currentPrice = Number(currentPrice);
    if (!(currentPrice > 0) || !(percentToSell > 0 && percentToSell <= 100)) {
      return { success: false, message: "Invalid sale." };
    }
    const next = structuredClone(state);
    const quantitySold = p.quantity * percentToSell / 100;
    const costBasisSold = p.amountInvested * percentToSell / 100;
    const saleValue = quantitySold * currentPrice;
    const pnl = saleValue - costBasisSold;
    const trade = {
      type: "SELL",
      positionId: p.id,
      symbol: p.symbol,
      name: p.name,
      tokenAddress: p.tokenAddress,
      pairAddress: p.pairAddress || null,
      strategyVersion: p.strategyVersion,
      entryScore: p.entryScore,
      entrySignal: p.entrySignal,
      entryReasons: p.entryReasons,
      entryPrice: p.entryPrice,
      highestPrice: p.highestPrice || p.entryPrice,
      exitPrice: currentPrice,
      percentSold: percentToSell,
      quantitySold,
      amountInvested: costBasisSold,
      saleValue,
      pnl,
      pnlPercent: pnl / costBasisSold * 100,
      entryTime: p.entryTime,
      exitTime: new Date().toISOString(),
      reason: options.reason || "MANUAL"
    };
    next.cashBalance += saleValue;
    next.position.quantity -= quantitySold;
    next.position.amountInvested -= costBasisSold;
    if (options.takeProfit) next.position[options.takeProfit] = true;
    if (percentToSell === 100) next.position = null;
    next.history.push(trade);
    save(next);
    return { success: true, trade: structuredClone(trade) };
  }

  function updateHigh(expectedPosition, price) {
    if (positionKey(state.position) !== expectedPosition || !state.position || !(Number(price) > 0)) return false;
    if (Number(price) <= Number(state.position.highestPrice || state.position.entryPrice)) return true;
    const next = structuredClone(state);
    next.position.highestPrice = Number(price);
    save(next);
    return true;
  }

  return {
    buy, sell, updateHigh, positionKey,
    getPortfolio: () => structuredClone(state)
  };
}

let singleton;
function current() {
  return singleton ||= createR3PaperTrader();
}

module.exports = {
  createR3PaperTrader,
  dataFile,
  buy: (...args) => current().buy(...args),
  sell: (...args) => current().sell(...args),
  updateHigh: (...args) => current().updateHigh(...args),
  positionKey: (...args) => current().positionKey(...args),
  getPortfolio: (...args) => current().getPortfolio(...args)
};
