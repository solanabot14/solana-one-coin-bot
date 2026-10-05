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

	return path.join(path.resolve(directory), "v31ThreeSlotTradingData.json");
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

	const positions = Array.isArray(data.positions) ? data.positions : (data.position ? [data.position] : []);
	if (positions.length > 3) throw new Error("Invalid saved positions: maximum is 3.");
	const p = positions.find(Boolean) || null;

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

function createPaperTrader(dataFile = defaultDataFile(), io = fs, { strategyVersion = "V3.1-3Slot-Compound10", maxOpenPositions = 3 } = {}) {
	let state = {
		startingBalance: 100,
		cashBalance: 100,
		positions: [],
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

	function equity() {
		return state.cashBalance + (state.positions || []).reduce((sum, p) => sum + p.amountInvested, 0);
	}

	function buy(coin) {
		const positions = state.positions || [];
		if (positions.length >= maxOpenPositions) return fail(`All ${maxOpenPositions} slots are occupied.`);
		const price = Number(coin.priceUsd);
		if (!Number.isFinite(price) || price <= 0 || !coin.tokenAddress) return fail("Invalid token or price.");
		if (positions.some(p => p.tokenAddress === coin.tokenAddress)) return fail("Token already has an open position.");
		if (state.cashBalance <= 0) return fail("No cash available.");
		const next = structuredClone(state);
		const amountInvested = Math.min(Math.max(equity() * 0.10, 10), next.cashBalance);
		if (!(amountInvested > 0)) return fail("No cash available.");
		const buys5m = Number(coin.buys5m) || 0, sells5m = Number(coin.sells5m) || 0;
		const totalTransactions5m = buys5m + sells5m;
		const buyRatio5m = totalTransactions5m > 0 ? buys5m / totalTransactions5m : 0;
		const position = { id: randomUUID(), symbol: coin.symbol, name: coin.name, tokenAddress: coin.tokenAddress,
			pairAddress: coin.pairAddress || null, entryPrice: price, quantity: amountInvested / price, amountInvested,
			...(coin.experimentEntry ? { experimentEntry: structuredClone(coin.experimentEntry) } : {}),
			firstTakeProfitDone:false, secondTakeProfitDone:false, highestPrice:price, entryTime:new Date().toISOString(),
			strategyVersion, entryScore:Number(coin.score)||0, entrySignal:coin.signal||null,
			entryReasons:Array.isArray(coin.reasons)?[...coin.reasons]:[], entryPriceChange5m:Number(coin.priceChange5m)||0,
			entryPriceChange1h:Number(coin.priceChange1h)||0, entryPriceChange24h:Number(coin.priceChange24h)||0,
			entryLiquidityUsd:Number(coin.liquidityUsd)||0, entryVolume24h:Number(coin.volume24h)||0,
			entryBuys5m:buys5m, entrySells5m:sells5m, entryTransactions5m:totalTransactions5m,
			entryBuyRatio:buyRatio5m, entryBuyRatio5m:buyRatio5m };
		next.positions.push(position); next.cashBalance -= amountInvested;
		const trade={type:"BUY",positionId:position.id,...position}; next.history.push(trade); commit(next);
		return {success:true,trade:structuredClone(trade)};
	}

	function positionKey(p) {
		return p
			? p.id || p.tokenAddress + "-" + p.entryTime
			: null;
	}

	function sell(currentPrice, percentToSell = 100, options = {}) {
		const positions = state.positions || [];
		const index = positions.findIndex(p => !options.expectedPosition || positionKey(p) === options.expectedPosition);
		const p = index >= 0 ? positions[index] : null;

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
		next.positions[index].quantity -= quantitySold;
		next.positions[index].amountInvested -= costBasisSold;

		if (options.takeProfit) {
			next.positions[index][options.takeProfit] = true;
		}

		if (percentToSell === 100) {
			next.positions.splice(index, 1);
		}

		next.history.push(trade);

		commit(next);

		return {
			success: true,
			trade: structuredClone(trade)
		};
	}

	function updateHigh(expectedPosition, price) {
		const index = (state.positions || []).findIndex(p => positionKey(p) === expectedPosition);
		if (index < 0 || !Number.isFinite(price) || price <= 0) return false;
		const position = state.positions[index];
		if (price <= (position.highestPrice || position.entryPrice)) return true;
		const next = structuredClone(state);
		next.positions[index].highestPrice = price;
		commit(next);
		return true;
	}

	return {
		buy,
		sell,
		updateHigh,
		positionKey,
		getPortfolio: () => structuredClone({...state, position: (state.positions || [])[0] || null})
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
