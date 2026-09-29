const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function defaultDataFile() {
	if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
		throw new Error("Attach a Railway volume before starting the paper trader.");
	}

	const directory =
		process.env.RAILWAY_VOLUME_MOUNT_PATH ||
		process.env.DATA_DIR ||
		__dirname;

	return path.join(path.resolve(directory), "tradingData.json");
}

function validateState(data) {
	const positive = value => Number.isFinite(value) && value > 0;

	if (
		!data ||
		!positive(data.startingBalance) ||
		!Number.isFinite(data.cashBalance) ||
		data.cashBalance < 0 ||
		!Array.isArray(data.history) ||
		data.history.some(t => !t || !["BUY", "SELL"].includes(t.type))
	) {
		throw new Error(
			"Invalid trading account. Restore a verified backup; the file has not been reset."
		);
	}

	const p = data.position;

	if (
		p !== null &&
		(
			!p ||
			!positive(p.entryPrice) ||
			!positive(p.quantity) ||
			!positive(p.amountInvested) ||
			!p.tokenAddress ||
			!p.entryTime ||
			(p.highestPrice !== undefined && !positive(p.highestPrice))
		)
	) {
		throw new Error(
			"Invalid saved position. The trading account has not been reset."
		);
	}
}

function createPaperTrader(dataFile = defaultDataFile(), io = fs) {
	let state = {
		startingBalance: 100,
		cashBalance: 100,
		position: null,
		history: []
	};

	if (io.existsSync(dataFile)) {
		state = JSON.parse(io.readFileSync(dataFile, "utf8"));
		validateState(state);
	}

	function commit(next) {
		validateState(next);

		io.mkdirSync(path.dirname(dataFile), { recursive: true });

		const temporary =
			dataFile + "." + process.pid + "." + randomUUID() + ".tmp";

		try {
			io.writeFileSync(
				temporary,
				JSON.stringify(next, null, 2),
				{
					flag: "wx",
					flush: true
				}
			);

			io.renameSync(temporary, dataFile);
		} finally {
			if (io.existsSync(temporary)) {
				io.unlinkSync(temporary);
			}
		}

		state = next;
	}

	const fail = message => ({
		success: false,
		message
	});

	function buy(coin) {
		if (state.position) {
			return fail("A position is already open.");
		}

		const price = Number(coin.priceUsd);

		if (
			!Number.isFinite(price) ||
			price <= 0 ||
			!coin.tokenAddress
		) {
			return fail("Invalid token or price.");
		}

		if (state.cashBalance <= 0) {
			return fail("No cash available.");
		}

		const next = structuredClone(state);
		const amountInvested = next.cashBalance * 0.10;

		const buys5m = Number(coin.buys5m) || 0;
		const sells5m = Number(coin.sells5m) || 0;
		const totalTransactions5m = buys5m + sells5m;

		const buyRatio5m =
			totalTransactions5m > 0
				? buys5m / totalTransactions5m
				: 0;

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

			strategyVersion: "V3.1R",

			entryScore: Number(coin.score) || 0,
			entrySignal: coin.signal || null,

			entryReasons: Array.isArray(coin.reasons)
				? [...coin.reasons]
				: [],

			entryPriceChange5m:
				Number(coin.priceChange5m) || 0,

			entryPriceChange1h:
				Number(coin.priceChange1h) || 0,

			entryPriceChange24h:
				Number(coin.priceChange24h) || 0,

			entryLiquidityUsd:
				Number(coin.liquidityUsd) || 0,

			entryVolume24h:
				Number(coin.volume24h) || 0,

			entryBuys5m: buys5m,
			entrySells5m: sells5m,

			entryTransactions5m:
				totalTransactions5m,

			entryBuyRatio: buyRatio5m,
			entryBuyRatio5m:
				buyRatio5m
		};

		next.cashBalance -= amountInvested;

		const trade = {
			type: "BUY",
			positionId: next.position.id,
			...next.position
		};

		next.history.push(trade);

		commit(next);

		return {
			success: true,
			trade: structuredClone(trade)
		};
	}

	function positionKey(p) {
		return p
			? p.id || p.tokenAddress + "-" + p.entryTime
			: null;
	}

	function sell(currentPrice, percentToSell = 100, options = {}) {
		const p = state.position;

		if (!p) {
			return fail("No position is open.");
		}

		if (
			options.expectedPosition &&
			options.expectedPosition !== positionKey(p)
		) {
			return fail("Position changed.");
		}

		currentPrice = Number(currentPrice);

		if (
			!Number.isFinite(currentPrice) ||
			currentPrice <= 0
		) {
			return fail("Invalid sale price.");
		}

		if (
			!Number.isFinite(percentToSell) ||
			percentToSell <= 0 ||
			percentToSell > 100
		) {
			return fail("Invalid sale percentage.");
		}

		if (
			options.takeProfit &&
			![
				"firstTakeProfitDone",
				"secondTakeProfitDone"
			].includes(options.takeProfit)
		) {
			return fail("Invalid profit target.");
		}

		if (
			options.takeProfit &&
			p[options.takeProfit]
		) {
			return fail("Profit target already taken.");
		}

		const next = structuredClone(state);

		const quantitySold =
			p.quantity * percentToSell / 100;

		const costBasisSold =
			p.amountInvested * percentToSell / 100;

		const saleValue =
			quantitySold * currentPrice;

		const pnl =
			saleValue - costBasisSold;

		const trade = {
			type: "SELL",

			positionId: p.id,

			symbol: p.symbol,
			name: p.name,

			tokenAddress: p.tokenAddress,
			pairAddress: p.pairAddress || null,

			strategyVersion:
				p.strategyVersion || null,

			entryScore:
				p.entryScore ?? null,

			entrySignal:
				p.entrySignal || null,

			entryReasons:
				Array.isArray(p.entryReasons)
					? [...p.entryReasons]
					: [],

			entryPriceChange5m:
				p.entryPriceChange5m ?? null,

			entryPriceChange1h:
				p.entryPriceChange1h ?? null,

			entryPriceChange24h:
				p.entryPriceChange24h ?? null,

			entryLiquidityUsd:
				p.entryLiquidityUsd ?? null,

			entryVolume24h:
				p.entryVolume24h ?? null,

			entryBuys5m:
				p.entryBuys5m ?? null,

			entrySells5m:
				p.entrySells5m ?? null,

			entryTransactions5m:
				p.entryTransactions5m ?? null,

			entryBuyRatio5m:
				p.entryBuyRatio5m ?? null,
			entryBuyRatio:
				p.entryBuyRatio ?? p.entryBuyRatio5m ?? null,

			entryPrice: p.entryPrice,
			highestPrice:
				p.highestPrice || p.entryPrice,

			exitPrice: currentPrice,

			percentSold: percentToSell,
			quantitySold,
			amountInvested: costBasisSold,

			saleValue,
			pnl,

			pnlPercent:
				pnl / costBasisSold * 100,

			entryTime:
				p.entryTime,

			exitTime:
				new Date().toISOString(),

			reason:
				options.reason || "MANUAL"
		};

		next.cashBalance += saleValue;
		next.position.quantity -= quantitySold;
		next.position.amountInvested -= costBasisSold;

		if (options.takeProfit) {
			next.position[options.takeProfit] = true;
		}

		if (percentToSell === 100) {
			next.position = null;
		}

		next.history.push(trade);

		commit(next);

		return {
			success: true,
			trade: structuredClone(trade)
		};
	}

	function updateHigh(expectedPosition, price) {
		if (
			positionKey(state.position) !== expectedPosition ||
			!state.position ||
			!Number.isFinite(price) ||
			price <= 0
		) {
			return false;
		}

		if (
			price <=
			(state.position.highestPrice ||
				state.position.entryPrice)
		) {
			return true;
		}

		const next = structuredClone(state);

		next.position.highestPrice = price;

		commit(next);

		return true;
	}

	return {
		buy,
		sell,
		updateHigh,
		positionKey,
		getPortfolio: () => structuredClone(state)
	};
}

// Lazy initialization keeps module imports from opening an account.
let trader;

const current = () =>
	trader ||= createPaperTrader();

module.exports = {
	createPaperTrader,
	defaultDataFile
};

for (const method of [
	"buy",
	"sell",
	"updateHigh",
	"positionKey",
	"getPortfolio"
]) {
	module.exports[method] =
		(...args) => current()[method](...args);
}
