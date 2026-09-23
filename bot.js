require("dotenv").config();

const { getTokenData } = require("./dexscreener");
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

const POSITION_MONITOR_MS = 2000;
const SCANNER_INTERVAL_MS = 120000;
const TOKEN_COOLDOWN_MS = 60 * 60 * 1000;
const HARD_STOP_PERCENT = -10;
const TAKE_PROFIT_1_PERCENT = 15;
const TAKE_PROFIT_1_SELL_PERCENT = 25;
const TAKE_PROFIT_2_PERCENT = 30;
const TAKE_PROFIT_2_SELL_PERCENT = 35;
const TRAILING_STOP_PERCENT = 8;
const MOMENTUM_EXIT_MIN_LOSS = -2;
const MOMENTUM_EXIT_5M = -3;
const MOMENTUM_EXIT_STRONG_LOSS = -5;
const MOMENTUM_EXIT_STRONG_5M = -1;
const MOMENTUM_EXIT_BUY_RATIO = 0.45;
const MOMENTUM_EXIT_MIN_TRANSACTIONS = 10;

const tokenCooldowns = new Map();

function startCooldown(tokenAddress, symbol, reason) {
	tokenCooldowns.set(tokenAddress, Date.now());
	console.log(`COOLDOWN STARTED | ${symbol} | 60 minutes | ${reason}`);
}

async function runScanner() {
	console.log("\nStarting automatic Solana scan...\n");
	const portfolio = getPortfolio();
	if (portfolio.position) {
		console.log(`Position already active: ${portfolio.position.symbol}. Skipping new entry.`);
		return;
	}

	const candidates = await discoverCandidates();
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

async function monitorPosition() {
	const portfolio = getPortfolio();
	if (!portfolio.position) return;
	const position = portfolio.position;
	const tokenAddress = position.tokenAddress;
	const freshData = await getTokenData(tokenAddress);
	if (!freshData) {
		console.log(`POSITION DATA UNAVAILABLE | ${position.symbol}`);
		return;
	}

	const currentPrice = Number(freshData.priceUsd);
	if (!currentPrice || currentPrice <= 0) return;
	if (!position.highestPrice || currentPrice > position.highestPrice) {
		position.highestPrice = currentPrice;
	}
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
		const result = sell(currentPrice, percent);
		if (result.success) startCooldown(tokenAddress, position.symbol, reason);
		return result;
	};
	if (profitPercent <= HARD_STOP_PERCENT) return void exit("HARD STOP");

	const enoughActivity = totalTransactions >= MOMENTUM_EXIT_MIN_TRANSACTIONS;
	const sellPressure = enoughActivity && buyRatio < MOMENTUM_EXIT_BUY_RATIO;
	const momentumExitA = profitPercent <= MOMENTUM_EXIT_MIN_LOSS && momentum5m <= MOMENTUM_EXIT_5M && sellPressure;
	const momentumExitB = profitPercent <= MOMENTUM_EXIT_STRONG_LOSS && momentum5m <= MOMENTUM_EXIT_STRONG_5M;
	if (momentumExitA || momentumExitB) return void exit("MOMENTUM EXIT");

	if (profitPercent >= TAKE_PROFIT_1_PERCENT && !position.firstTakeProfitDone) {
		const result = sell(currentPrice, TAKE_PROFIT_1_SELL_PERCENT);
		if (result.success && getPortfolio().position) getPortfolio().position.firstTakeProfitDone = true;
		return;
	}
	if (profitPercent >= TAKE_PROFIT_2_PERCENT && position.firstTakeProfitDone && !position.secondTakeProfitDone) {
		const result = sell(currentPrice, TAKE_PROFIT_2_SELL_PERCENT);
		if (result.success && getPortfolio().position) getPortfolio().position.secondTakeProfitDone = true;
		return;
	}
	if (position.secondTakeProfitDone && dropFromHigh >= TRAILING_STOP_PERCENT) exit("TRAILING STOP");
}

let botRunning = false;
let scannerInterval = null;
let positionInterval = null;

async function startBot() {
	if (botRunning) return;
	botRunning = true;
	console.log("BOT STARTED | Risk Management V2");
	await runScanner();
	positionInterval = setInterval(() => {
		if (botRunning) monitorPosition().catch(console.error);
	}, POSITION_MONITOR_MS);
	scannerInterval = setInterval(() => {
		if (botRunning) runScanner().catch(console.error);
	}, SCANNER_INTERVAL_MS);
}

function stopBot() {
	if (!botRunning) return;
	botRunning = false;
	if (scannerInterval) clearInterval(scannerInterval);
	if (positionInterval) clearInterval(positionInterval);
	scannerInterval = positionInterval = null;
	console.log("BOT STOPPED");
}

function getBotStatus() {
	return botRunning;
}

module.exports = { startBot, stopBot, getBotStatus };
