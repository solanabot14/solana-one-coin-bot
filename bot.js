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


// ======================================================
// SETTINGS
// ======================================================

const TOKEN_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
const tokenCooldowns = new Map();


// ======================================================
// SCANNER
// ======================================================

async function runScanner() {
	console.log("\nStarting automatic Solana scan...\n");

	// Never open another trade while one is active
	const portfolio = getPortfolio();

	if (portfolio.position) {
		console.log(
			`Position already active: ${portfolio.position.symbol}. Skipping new entry.`
		);
		return;
	}

	const candidates = await discoverCandidates();

	if (candidates.length === 0) {
		console.log("No candidates passed the filters.");
		return;
	}

	const now = Date.now();

	// Remove tokens that are still in cooldown
	const availableCandidates = candidates.filter((coin) => {
		const cooldownStart = tokenCooldowns.get(coin.tokenAddress);

		if (!cooldownStart) {
			return true;
		}

		if (now - cooldownStart >= TOKEN_COOLDOWN_MS) {
			tokenCooldowns.delete(coin.tokenAddress);
			return true;
		}

		return false;
	});

	if (availableCandidates.length === 0) {
		console.log("All candidates are currently on cooldown.");
		return;
	}

	console.log("\nTOP SOLANA CANDIDATES:\n");

	// IMPORTANT:
	// Do not simply take candidates[0] if it isn't STRONG BUY.
	// Find the highest-ranked candidate that actually qualifies.
	const bestCoin = availableCandidates.find(
		(coin) => coin.signal === "STRONG BUY"
	);

	if (!bestCoin) {
		console.log("No STRONG BUY candidate available.");
		return;
	}

	console.log("\nBOT SELECTED:");
	console.log(`${bestCoin.symbol} - ${bestCoin.name}`);
	console.log(`Score: ${bestCoin.score}`);
	console.log(`Signal: ${bestCoin.signal}`);

	const trade = buy(bestCoin);

	console.log("\nPAPER TRADE:");
	console.log(trade);

	console.log("\nPORTFOLIO:");
	console.log(getPortfolio());

	availableCandidates.slice(0, 5).forEach((coin, index) => {
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


// ======================================================
// POSITION MONITOR
// ======================================================

async function monitorPosition() {
	const portfolio = getPortfolio();

	if (!portfolio.position) {
		return;
	}

	const tokenAddress = portfolio.position.tokenAddress;

	const freshData = await getTokenData(tokenAddress);

	if (!freshData) {
		return;
	}

	const currentPrice = Number(freshData.priceUsd);
	const position = getPortfolio().position;

	if (!position || !currentPrice) {
		return;
	}

	// Track highest observed price
	if (currentPrice > position.highestPrice) {
		position.highestPrice = currentPrice;
	}

	const entryPrice = position.entryPrice;

	const profitPercent =
		((currentPrice - entryPrice) / entryPrice) * 100;

	const dropFromHigh =
		((position.highestPrice - currentPrice) /
			position.highestPrice) *
		100;

	console.log(
		`POSITION MONITOR | ${position.symbol} | P/L: ${profitPercent.toFixed(
			2
		)}% | Drop from high: ${dropFromHigh.toFixed(2)}%`
	);


	// ==================================================
	// HARD STOP -10%
	// ==================================================

	if (profitPercent <= -10) {
		console.log("HARD STOP - SELLING 100%");

		const result = sell(currentPrice, 100);

		if (result.success) {
			tokenCooldowns.set(tokenAddress, Date.now());

			console.log(
				`COOLDOWN STARTED | ${position.symbol} | 60 minutes`
			);
		}

		return;
	}


	// ==================================================
	// TAKE PROFIT 1 +15%
	// Sell 25%
	// ==================================================

	if (
		profitPercent >= 15 &&
		!position.firstTakeProfitDone
	) {
		console.log("TAKE PROFIT 1 - SELLING 25%");

		const result = sell(currentPrice, 25);

		if (result.success) {
			const updatedPosition = getPortfolio().position;

			if (updatedPosition) {
				updatedPosition.firstTakeProfitDone = true;
			}
		}

		return;
	}


	// ==================================================
	// TAKE PROFIT 2 +30%
	// Sell 35% of remaining position
	// ==================================================

	if (
		profitPercent >= 30 &&
		position.firstTakeProfitDone &&
		!position.secondTakeProfitDone
	) {
		console.log("TAKE PROFIT 2 - SELLING 35%");

		const result = sell(currentPrice, 35);

		if (result.success) {
			const updatedPosition = getPortfolio().position;

			if (updatedPosition) {
				updatedPosition.secondTakeProfitDone = true;
			}
		}

		return;
	}


	// ==================================================
	// TRAILING STOP 8%
	// Only after TP2
	// ==================================================

	if (
		position.secondTakeProfitDone &&
		dropFromHigh >= 8
	) {
		console.log(
			"TRAILING STOP - SELLING REMAINING POSITION"
		);

		const result = sell(currentPrice, 100);

		if (result.success) {
			tokenCooldowns.set(tokenAddress, Date.now());

			console.log(
				`COOLDOWN STARTED | ${position.symbol} | 60 minutes`
			);
		}

		return;
	}
}


// ======================================================
// BOT CONTROL
// ======================================================

let botRunning = false;
let scannerInterval = null;
let positionInterval = null;

async function startBot() {
	if (botRunning) {
		return;
	}

	botRunning = true;

	console.log("BOT STARTED");

	// Initial scan
	await runScanner();

	// Check active position every 5 seconds
	positionInterval = setInterval(async () => {
		if (botRunning) {
			await monitorPosition();
		}
	}, 5000);

	// Scan for new opportunities every 10 minutes
	scannerInterval = setInterval(async () => {
		if (botRunning) {
			await runScanner();
		}
	}, 120000);
}


function stopBot() {
	if (!botRunning) {
		return;
	}

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


function getBotStatus() {
	return botRunning;
}


module.exports = {
	startBot,
	stopBot,
	getBotStatus
};