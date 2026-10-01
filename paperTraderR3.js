const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_OPEN_POSITIONS = 3;
const COMPOUND_FRACTION = 0.10;

function dataFile() {
  const directory = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(directory), "tradingDataR3.json");
}

function normalizeState(raw) {
  const startingBalance = Number(raw?.startingBalance) > 0 ? Number(raw.startingBalance) : 100;
  const cashBalance = Number.isFinite(Number(raw?.cashBalance)) ? Number(raw.cashBalance) : startingBalance;
  const history = Array.isArray(raw?.history) ? raw.history : [];
  const positions = Array.isArray(raw?.positions)
    ? raw.positions.filter(Boolean)
    : raw?.position ? [raw.position] : [];
  return { startingBalance, cashBalance, positions, history };
}

function createR3PaperTrader(file = dataFile()) {
  let state = { startingBalance: 100, cashBalance: 100, positions: [], history: [] };
  if (fs.existsSync(file)) state = normalizeState(JSON.parse(fs.readFileSync(file, "utf8")));

  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const normalized = normalizeState(next);
    const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { flag: "wx" });
    fs.renameSync(tmp, file);
    state = normalized;
  }

  function positionKey(p) {
    return p ? (p.id || p.tokenAddress + "-" + p.entryTime) : null;
  }

  function publicState() {
    const snapshot = structuredClone(state);
    // Compatibility alias for existing dashboard/client code.
    snapshot.position = snapshot.positions[0] || null;
    return snapshot;
  }

  function realizedCapitalBase(s = state) {
    const openCostBasis = (s.positions || []).reduce(
      (sum, p) => sum + (Number(p?.amountInvested) || 0), 0
    );
    return Number(s.cashBalance || 0) + openCostBasis;
  }

  function buy(coin) {
    if (state.positions.length >= MAX_OPEN_POSITIONS) {
      return { success: false, message: "Maximum open positions reached." };
    }
    if (state.positions.some(p => p.tokenAddress === coin?.tokenAddress)) {
      return { success: false, message: "Token already has an open position." };
    }

    const price = Number(coin?.priceUsd);
    if (!(price > 0) || !coin?.tokenAddress) {
      return { success: false, message: "Invalid token or price." };
    }

    const next = structuredClone(state);
    const capitalBase = realizedCapitalBase(next);
    const targetAmount = capitalBase * COMPOUND_FRACTION;
    const amountInvested = Math.min(targetAmount, next.cashBalance);
    if (!(amountInvested > 0)) {
      return { success: false, message: "No cash available." };
    }

    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const tx = buys5m + sells5m;
    const buyRatio = tx ? buys5m / tx : 0;

    const position = {
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

    next.positions.push(position);
    next.cashBalance -= amountInvested;
    const trade = { type: "BUY", positionId: position.id, ...position };
    next.history.push(trade);
    save(next);
    return { success: true, trade: structuredClone(trade) };
  }

  function findPositionIndex(expectedPosition) {
    if (!expectedPosition) return state.positions.length === 1 ? 0 : -1;
    return state.positions.findIndex(p => positionKey(p) === expectedPosition);
  }

  function sell(currentPrice, percentToSell = 100, options = {}) {
    const index = findPositionIndex(options.expectedPosition);
    if (index < 0) return { success: false, message: "Position not found." };

    const p = state.positions[index];
    currentPrice = Number(currentPrice);
    if (!(currentPrice > 0) || !(percentToSell > 0 && percentToSell <= 100)) {
      return { success: false, message: "Invalid sale." };
    }

    const next = structuredClone(state);
    const live = next.positions[index];
    const quantitySold = live.quantity * percentToSell / 100;
    const costBasisSold = live.amountInvested * percentToSell / 100;
    const saleValue = quantitySold * currentPrice;
    const pnl = saleValue - costBasisSold;
    const trade = {
      type: "SELL",
      positionId: live.id,
      symbol: live.symbol,
      name: live.name,
      tokenAddress: live.tokenAddress,
      pairAddress: live.pairAddress || null,
      strategyVersion: live.strategyVersion,
      entryScore: live.entryScore,
      entrySignal: live.entrySignal,
      entryReasons: live.entryReasons,
      entryPrice: live.entryPrice,
      highestPrice: live.highestPrice || live.entryPrice,
      exitPrice: currentPrice,
      percentSold: percentToSell,
      quantitySold,
      amountInvested: costBasisSold,
      saleValue,
      pnl,
      pnlPercent: pnl / costBasisSold * 100,
      entryTime: live.entryTime,
      exitTime: new Date().toISOString(),
      reason: options.reason || "MANUAL"
    };

    next.cashBalance += saleValue;
    live.quantity -= quantitySold;
    live.amountInvested -= costBasisSold;
    if (options.takeProfit) live[options.takeProfit] = true;
    if (percentToSell === 100) next.positions.splice(index, 1);
    next.history.push(trade);
    save(next);
    return { success: true, trade: structuredClone(trade) };
  }

  function updateHigh(expectedPosition, price) {
    const index = state.positions.findIndex(p => positionKey(p) === expectedPosition);
    if (index < 0 || !(Number(price) > 0)) return false;
    if (Number(price) <= Number(state.positions[index].highestPrice || state.positions[index].entryPrice)) return true;
    const next = structuredClone(state);
    next.positions[index].highestPrice = Number(price);
    save(next);
    return true;
  }

  return {
    buy, sell, updateHigh, positionKey,
    getPortfolio: publicState,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    compoundFraction: COMPOUND_FRACTION
  };
}

let singleton;
function current() {
  return singleton ||= createR3PaperTrader();
}

module.exports = {
  createR3PaperTrader,
  dataFile,
  MAX_OPEN_POSITIONS,
  COMPOUND_FRACTION,
  buy: (...args) => current().buy(...args),
  sell: (...args) => current().sell(...args),
  updateHigh: (...args) => current().updateHigh(...args),
  positionKey: (...args) => current().positionKey(...args),
  getPortfolio: (...args) => current().getPortfolio(...args)
};
