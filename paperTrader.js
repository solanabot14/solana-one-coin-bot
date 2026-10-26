const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const COMPOUND_RATE = 0.10;
const MINIMUM_BUY_USD = 10;

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

function validateState(data, maxPositions = 3) {
	const positive = value => Number.isFinite(value) && value > 0;
	if (
		!data ||
		!positive(data.startingBalance) ||
		!Number.isFinite(data.cashBalance) ||
		data.cashBalance < 0 ||
		!Array.isArray(data.history) ||
		data.history.some(t => !t || !["BUY", "SELL"].includes(t.type))
	) {
		throw new Error("Invalid trading account. Restore a verified backup; the file has not been reset.");
	}
	const positions = Array.isArray(data.positions) ? data.positions : (data.position ? [data.position] : []);
	if (positions.length > maxPositions) throw new Error("Invalid saved positions: maximum is " + maxPositions + ".");
	for (const position of positions) {
		if (
			!position ||
			!positive(position.entryPrice) ||
			!positive(position.quantity) ||
			!positive(position.amountInvested) ||
			!position.tokenAddress ||
			!position.entryTime ||
			(position.highestPrice !== undefined && !positive(position.highestPrice))
		) {
			throw new Error("Invalid saved position. The trading account has not been reset.");
		}
	}
}

function createPaperTrader(dataFile = defaultDataFile(), io = fs, {
	strategyVersion = "V3.1-Original-2Slots",
	getBuySizing = null,
	maxOpenPositions = null,
	startingBalance = 100,
	sessionResetId = null,
	minimumBuyUsd = MINIMUM_BUY_USD,
	estimateExecutionCosts = null
} = {}) {
	const positionLimit = Number.isInteger(maxOpenPositions) && maxOpenPositions > 0 ? maxOpenPositions : 2;
	const stateValidationLimit = Math.max(3, positionLimit);
	const buyMinimum = Number.isFinite(Number(minimumBuyUsd)) && Number(minimumBuyUsd) > 0
		? Number(minimumBuyUsd) : MINIMUM_BUY_USD;
	let state = {
		startingBalance,
		cashBalance: startingBalance,
		positions: [],
		history: []
	};

	if (io.existsSync(dataFile)) {
		state = JSON.parse(io.readFileSync(dataFile, "utf8"));
		validateState(state, stateValidationLimit);
	}

	function commit(next) {
		validateState(next, stateValidationLimit);

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

	// Reset once; archive open snapshots without inventing sales or realized P&L.
	if (sessionResetId && state.sessionId !== sessionResetId) {
		const previous = structuredClone(state);
		const archives = previous.archivedSessions || [];
		delete previous.archivedSessions;
		const resetAt = new Date().toISOString();
		commit({ startingBalance, cashBalance: startingBalance, positions: [], history: [],
			sessionId: sessionResetId, sessionStartedAt: resetAt,
			archivedSessions: [...archives, { ...previous, archivedAt: resetAt,
				archiveReason: "Paper reset; open positions are archived snapshots, not realized exits" }] });
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
		if (positions.length >= positionLimit) return fail("All " + positionLimit + " slots are occupied.");
		const price = Number(coin.priceUsd);
		if (!Number.isFinite(price) || price <= 0 || !coin.tokenAddress) return fail("Invalid token or price.");
		if (positions.some(p => p.tokenAddress === coin.tokenAddress)) return fail("Token already has an open position.");
		if (state.cashBalance < buyMinimum) return fail("At least $10 cash is required for a new trade.");
		const next = structuredClone(state);
		const sizing = typeof getBuySizing === "function"
			? getBuySizing(structuredClone(state), structuredClone(coin))
			: null;
		const requestedAmount = sizing
			? Number(sizing.amountInvested)
			: Math.max(equity() * COMPOUND_RATE, MINIMUM_BUY_USD);
		const amountInvested = Math.min(requestedAmount, next.cashBalance);
		if (!Number.isFinite(amountInvested) || amountInvested < buyMinimum) {
			return fail("At least $10 cash is required for a new trade.");
		}
		let entryCosts = { feesUsd: 0, slippageUsd: 0, poolFeeUsd: 0, solanaFeeUsd: 0, priorityFeeUsd: 0 };
		if (typeof estimateExecutionCosts === "function") {
			entryCosts = estimateExecutionCosts({ side: "BUY", amountUsd: amountInvested, liquidityUsd: coin.liquidityUsd, coin }) || null;
			if (!entryCosts || !Number.isFinite(Number(entryCosts.feesUsd)) || !Number.isFinite(Number(entryCosts.slippageUsd))) {
				return fail("Entry cost estimate unavailable.");
			}
		}
		const buys5m = Number(coin.buys5m) || 0, sells5m = Number(coin.sells5m) || 0;
		const totalTransactions5m = buys5m + sells5m;
		const buyRatio5m = totalTransactions5m > 0 ? buys5m / totalTransactions5m : 0;
		const position = { id: randomUUID(), symbol: coin.symbol, name: coin.name, tokenAddress: coin.tokenAddress,
			pairAddress: coin.pairAddress || null, entryPrice: price, quantity: amountInvested / price, amountInvested,
			...(sizing && Number.isFinite(Number(sizing.compoundRate)) ? { compoundRate: Number(sizing.compoundRate) } : {}),
			...(coin.experimentEntry ? { experimentEntry: structuredClone(coin.experimentEntry) } : {}),
			entryExecutionCosts: structuredClone(entryCosts),
			remainingEntryCosts: { feesUsd: Number(entryCosts.feesUsd), slippageUsd: Number(entryCosts.slippageUsd) },
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

		const soldShareOfRemaining = p.quantity > 0 ? quantitySold / p.quantity : 1;
		const remainingEntryCosts = p.remainingEntryCosts ||
			(typeof estimateExecutionCosts === "function"
				? estimateExecutionCosts({ side: "BUY", amountUsd: p.amountInvested, liquidityUsd: p.entryLiquidityUsd, position: p })
				: null) ||
			{ feesUsd: 0, slippageUsd: 0 };
		const entryFeeAllocated = (Number(remainingEntryCosts.feesUsd) || 0) * soldShareOfRemaining;
		const entrySlippageAllocated = (Number(remainingEntryCosts.slippageUsd) || 0) * soldShareOfRemaining;
		const entryCostAllocated = entryFeeAllocated + entrySlippageAllocated;
		let exitCosts = { feesUsd: 0, slippageUsd: 0, poolFeeUsd: 0, solanaFeeUsd: 0, priorityFeeUsd: 0 };
		if (typeof estimateExecutionCosts === "function") {
			exitCosts = estimateExecutionCosts({
				side: "SELL",
				amountUsd: saleValue,
				liquidityUsd: options.liquidityUsd || p.entryLiquidityUsd,
				priceUsd: currentPrice,
				position: p
			}) || null;
			if (!exitCosts || !Number.isFinite(Number(exitCosts.feesUsd)) || !Number.isFinite(Number(exitCosts.slippageUsd))) {
				return fail("Exit cost estimate unavailable.");
			}
		}
		const grossPnl = saleValue - costBasisSold;
		const feesUsd = entryFeeAllocated + Number(exitCosts.feesUsd);
		const slippageUsd = entrySlippageAllocated + Number(exitCosts.slippageUsd);
		const totalCostsUsd = feesUsd + slippageUsd;
		const pnl = grossPnl - totalCostsUsd;

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
			targetOriginalPositionPercent: Number.isFinite(Number(options.targetOriginalPositionPercent))
				? Number(options.targetOriginalPositionPercent)
				: null,
			quantitySold,
			amountInvested: costBasisSold,

			saleValue,
			grossPnl,
			pnl,
			netPnl: pnl,
			estimatedFeesUsd: feesUsd,
			estimatedSlippageUsd: slippageUsd,
			estimatedCostUsd: totalCostsUsd,
			exitFeeBreakdown: structuredClone(exitCosts),
			entryCostsAllocatedUsd: entryCostAllocated,
			
			pnlPercent: costBasisSold > 0 ? pnl / costBasisSold * 100 : 0,

			entryTime:
				p.entryTime,

			exitTime:
				new Date().toISOString(),

			reason:
				options.reason || "MANUAL"
		};

		next.cashBalance += saleValue - Number(exitCosts.feesUsd) - Number(exitCosts.slippageUsd) - entryCostAllocated;
		next.positions[index].quantity -= quantitySold;
		next.positions[index].amountInvested -= costBasisSold;
		next.positions[index].remainingEntryCosts = {
			feesUsd: Math.max(0, (Number(remainingEntryCosts.feesUsd) || 0) - entryFeeAllocated),
			slippageUsd: Math.max(0, (Number(remainingEntryCosts.slippageUsd) || 0) - entrySlippageAllocated)
		};

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

	function writeOff(expectedPosition, reason = "MANUAL PAPER WRITE-OFF · NO LIQUIDITY") {
		const positions = state.positions || [];
		const index = positions.findIndex(p => positionKey(p) === expectedPosition);
		const p = index >= 0 ? positions[index] : null;
		if (!p) return fail("Position is no longer open.");
		const next = structuredClone(state);
		const quantitySold = Number(p.quantity) || 0;
		const costBasisSold = Number(p.amountInvested) || 0;
		const remainingEntryCosts = p.remainingEntryCosts || p.entryExecutionCosts || {};
		const entryFeeAllocated = Number(remainingEntryCosts.feesUsd) || 0;
		const entrySlippageAllocated = Number(remainingEntryCosts.slippageUsd) || 0;
		const entryCostAllocated = entryFeeAllocated + entrySlippageAllocated;
		const grossPnl = -costBasisSold;
		const pnl = grossPnl - entryCostAllocated;
		const exitTime = new Date().toISOString();
		const trade = {
			type: "SELL", positionId: p.id, symbol: p.symbol, name: p.name,
			tokenAddress: p.tokenAddress, pairAddress: p.pairAddress || null,
			strategyVersion: p.strategyVersion || null, entryScore: p.entryScore ?? null,
			entrySignal: p.entrySignal || null, entryReasons: Array.isArray(p.entryReasons) ? [...p.entryReasons] : [],
			entryPrice: p.entryPrice, highestPrice: p.highestPrice || p.entryPrice,
			exitPrice: 0, exitPriceSource: "NO_LIQUIDITY_WRITE_OFF", liquidityUsd: 0, manualClose: true,
			quantitySold, percentSold: 100, targetOriginalPositionPercent: null,
			amountInvested: costBasisSold, saleValue: 0, grossPnl, pnl, netPnl: pnl,
			estimatedFeesUsd: entryFeeAllocated, estimatedSlippageUsd: entrySlippageAllocated,
			estimatedCostUsd: entryCostAllocated,
			exitFeeBreakdown: { feesUsd: 0, slippageUsd: 0, poolFeeUsd: 0, solanaFeeUsd: 0, priorityFeeUsd: 0 },
			entryCostsAllocatedUsd: entryCostAllocated,
			pnlPercent: costBasisSold > 0 ? pnl / costBasisSold * 100 : 0,
			entryTime: p.entryTime, exitTime, reason
		};
		next.cashBalance -= entryCostAllocated;
		next.positions.splice(index, 1);
		next.history.push(trade);
		commit(next);
		return { success: true, writeOff: true, trade: structuredClone(trade) };
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
		writeOff,
		updateHigh,
		positionKey,
		getPortfolio: () => structuredClone({
			...state,
			...(Number.isInteger(maxOpenPositions) && maxOpenPositions > 0 ? { maxOpenPositions } : {}),
			position: (state.positions || [])[0] || null
		})
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
	"writeOff",
	"getPortfolio"
]) {
	module.exports[method] =
		(...args) => current()[method](...args);
}
