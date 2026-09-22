require("dotenv").config();
const { getTokenData } = require("./dexscreener");
const { analyzeToken } = require("./strategy");
const { discoverCandidates } = require("./scanner");
const { buy, sell, getPortfolio } = require("./paperTrader");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
	console.error("❌ No se encontró HELIUS_API_KEY en el archivo .env");
	process.exit(1);
}

console.log("✅ Bot iniciado");
console.log("✅ Helius API Key cargada correctamente");
console.log("💵 Paper Trading Balance: $100");
const TOKEN_ADDRESS = process.argv[2];

async function testToken() {
    if (!TOKEN_ADDRESS) {
        console.log("Escribe una dirección de token.");
        return;
    }

    console.log("Buscando token en DexScreener...");

    const data = await getTokenData(TOKEN_ADDRESS);

    if (!data) {
        console.log("No se encontraron datos para este token.");
        return;
    }

    console.log("TOKEN DATA:");
    console.log(data);
    const analysis = analyzeToken(data);

console.log("ANALYSIS:");
console.log(analysis);
}

testToken();// testToken();
async function runScanner() {
  console.log("\nStarting automatic Solana scan...\n");

  const candidates = await discoverCandidates();

  if (candidates.length === 0) {
    console.log("No candidates passed the filters.");
    return;
  }

  console.log("\nTOP SOLANA CANDIDATES:\n");
  const bestCoin = candidates[0];

console.log("\nBOT SELECTED:");
console.log(`${bestCoin.symbol} - ${bestCoin.name}`);
console.log(`Score: ${bestCoin.score}`);
console.log(`Signal: ${bestCoin.signal}`);

if (bestCoin.signal === "STRONG BUY") {
    const trade = buy(bestCoin);
    console.log("\nPAPER TRADE:");
    console.log(trade);
} else {
    console.log("\nNo trade opened. Waiting for STRONG BUY.");
}

console.log("\nPORTFOLIO:");
console.log(getPortfolio());

  candidates.slice(0, 5).forEach((coin, index) => {
    console.log(`#${index + 1} ${coin.symbol} - ${coin.name}`);
    console.log(`Score: ${coin.score}`);
    console.log(`Signal: ${coin.signal}`);
    console.log(`Price: $${coin.priceUsd}`);
    console.log(`Liquidity: $${coin.liquidityUsd}`);
    console.log(`24h Volume: $${coin.volume24h}`);
    console.log(`5m Buys/Sells: ${coin.buys5m}/${coin.sells5m}`);
    console.log(`Address: ${coin.tokenAddress}`);
    console.log("----------------------------");
  });
}

async function monitorPosition() {
  const portfolio = getPortfolio();

  if (!portfolio.position) {
    return;
  }

  const freshData = await getTokenData(portfolio.position.tokenAddress);

  if (!freshData) {
    return;
  }

  const currentPrice = Number(freshData.priceUsd);
  const position = getPortfolio().position;

  if (!position || !currentPrice) {
    return;
  }

  if (currentPrice > position.highestPrice) {
    position.highestPrice = currentPrice;
  }

  const entryPrice = position.entryPrice;
  const profitPercent =
    ((currentPrice - entryPrice) / entryPrice) * 100;

  const dropFromHigh =
    ((position.highestPrice - currentPrice) /
      position.highestPrice) * 100;

  console.log(
    `POSITION MONITOR | ${position.symbol} | P/L: ${profitPercent.toFixed(2)}%`
  );

  // HARD STOP -10%
  if (profitPercent <= -10) {
    console.log("HARD STOP - SELLING 100%");
    sell(currentPrice, 100);
    return;
  }

  // TAKE PROFIT 1 +15%
  if (
    profitPercent >= 15 &&
    !position.firstTakeProfitDone
  ) {
    console.log("TAKE PROFIT 1 - SELLING 25%");
    sell(currentPrice, 25);

    const updatedPosition = getPortfolio().position;
    if (updatedPosition) {
      updatedPosition.firstTakeProfitDone = true;
    }

    return;
  }

  // TAKE PROFIT 2 +30%
  if (
    profitPercent >= 30 &&
    position.firstTakeProfitDone &&
    !position.secondTakeProfitDone
  ) {
    console.log("TAKE PROFIT 2 - SELLING 35%");
    sell(currentPrice, 35);

    const updatedPosition = getPortfolio().position;
    if (updatedPosition) {
      updatedPosition.secondTakeProfitDone = true;
    }

    return;
  }

  // TRAILING STOP 8%
  if (
    position.secondTakeProfitDone &&
    dropFromHigh >= 8
  ) {
    console.log("TRAILING STOP - SELLING REMAINING POSITION");
    sell(currentPrice, 100);
  }
}
let botRunning = false;
let scannerInterval = null;
let positionInterval = null;
async function startBot() {
  if (botRunning) return;

  botRunning = true;
  console.log("BOT STARTED");

  await runScanner();
positionInterval = setInterval(async () => {
  if (botRunning) {
    await monitorPosition();
  }
}, 5000);
  scannerInterval = setInterval(async () => {
    if (botRunning) {
      await runScanner();
    }
  }, 600000);
}
function stopBot() {
  if (!botRunning) return;

  botRunning = false;

  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
}

if (positionInterval) {
    clearInterval(positionInterval);
    positionInterval = null;
}

  console.log("BOT STOPPED");
}

// startBot();
function getBotStatus() {
  return botRunning;
}
module.exports = {
  startBot,
  stopBot,
  getBotStatus
};