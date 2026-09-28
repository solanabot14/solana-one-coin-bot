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

const JTO_REPAIR_ID = "jto-bad-quote-2026-09-27";
const JTO_TOKEN = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const JTO_PAIR = "G2FiE1yn9N9ZJx5e1E2LxxMnHvb1H3hCuHLPfKJ98smA";

function repairKnownJtoBadQuote(data) {
	const p = data?.position;
	if (!p || p.tokenAddress !== JTO_TOKEN || p.pairAddress !== JTO_PAIR) {
		return { changed: false, data };
	}

	const repairs = Array.isArray(data.repairs) ? data.repairs : [];
	if (repairs.some(repair => repair?.id === JTO_REPAIR_ID)) {
		return { changed: false, data };
	}

	const entryPrice = Number(p.entryPrice);
	const highestPrice = Number(p.highestPrice);
	if (!(entryPrice >= 0.63 && entryPrice <= 0.64) || !(highestPrice > 1000)) {
		return { changed: false, data };
	}

	const positionId = p.id;
	const buy = data.history.find(trade =>
		trade?.type === "BUY" &&
		trade.positionId === positionId &&
		trade.tokenAddress === JTO_TOKEN
	);
	if (!buy || !(Number(buy.quantity) > 0) || !(Number(buy.amountInvested) > 0)) {
		return { changed: false, data };
	}

	const badSells = data.history.filter(trade =>
		trade?.type === "SELL" &&
		trade.positionId === positionId &&
		["TAKE PROFIT 1", "TAKE PROFIT 2"].includes(trade.reason) &&
		Number(trade.exitPrice) > 1000
	);
	if (!badSells.length) {
		return { changed: false, data };
	}

	const fictitiousSaleValue = badSells.reduce(
		(sum, trade) => sum + (Number(trade.saleValue) || 0),
		0
	);
	const repairedCash = Number(data.cashBalance) - fictitiousSaleValue;
	if (!Number.isFinite(repairedCash) || repairedCash < 0) {
		throw new Error("JTO repair refused: calculated cash would be invalid.");
	}

	const next = structuredClone(data);
	next.cashBalance = repairedCash;
	next.position.quantity = Number(buy.quantity);
	next.position.amountInvested = Number(buy.amountInvested);
	next.position.firstTakeProfitDone = false;
	next.position.secondTakeProfitDone = false;
	next.position.highestPrice = Number(next.position.entryPrice);
	next.history = structuredClone(data.history.filter(trade => !badSells.includes(trade)));
	next.repairs = Array.isArray(next.repairs) ? next.repairs : [];
	next.repairs.push({
		id: JTO_REPAIR_ID,
		time: new Date().toISOString(),
		positionId,
		tokenAddress: JTO_TOKEN,
		pairAddress: JTO_PAIR,
		removedSellCount: badSells.length,
		removedSaleValue: fictitiousSaleValue,
		previousHighestPrice: highestPrice,
		restoredEntryPrice: Number(next.position.entryPrice),
		restoredQuantity: Number(next.position.quantity),
		restoredAmountInvested: Number(next.position.amountInvested)
	});

	return { changed: true, data: next };
}
const CURRENT_ENTRY_STRATEGY = "V4.5";

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

		const repair = repairKnownJtoBadQuote(state);
		if (repair.changed) {
			validateState(repair.data);
			const temporary = dataFile + "." + process.pid + "." + randomUUID() + ".repair.tmp";
			try {
				io.mkdirSync(path.dirname(dataFile), { recursive: true });
				io.writeFileSync(temporary, JSON.stringify(repair.data, null, 2), { flag: "wx", flush: true });
				io.renameSync(temporary, dataFile);
			} finally {
				if (io.existsSync(temporary)) io.unlinkSync(temporary);
			}
			state = repair.data;
			console.log(
				"JTO SURGICAL REPAIR | Removed " +
				state.repairs.at(-1).removedSellCount +
				" corrupted partial sells | Reversed $" +
				state.repairs.at(-1).removedSaleValue.toFixed(2) +
				" fictitious cash"
			);
		}
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
		next.strategyDatasets = next.strategyDatasets && typeof next.strategyDatasets === "object"
			? next.strategyDatasets
			: {};
		if (!next.strategyDatasets[CURRENT_ENTRY_STRATEGY]) {
			next.strategyDatasets[CURRENT_ENTRY_STRATEGY] = {
				startedAt: new Date().toISOString(),
				startingBalance: Number(next.cashBalance)
			};
		}
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

			strategyVersion: CURRENT_ENTRY_STRATEGY,
			riskManagementVersion: "V3.4",

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

			entryVolume5m:
				Number(coin.volume5m) || 0,

			entryVolume1h:
				Number(coin.volume1h) || 0,

			entryVolume24h:
				Number(coin.volume24h) || 0,

			entryDiscoverySources:
				Array.isArray(coin.discoverySources)
					? [...coin.discoverySources]
					: [],

			entryCurrentActivity:
				coin.currentActivity
					? structuredClone(coin.currentActivity)
					: null,

			entryPostPump:
				coin.postPump
					? structuredClone(coin.postPump)
					: null,

			entryPreDiscoveryPump:
				coin.preDiscoveryPump
					? structuredClone(coin.preDiscoveryPump)
					: null,

			entryMarketDataIntegrity:
				coin.marketDataIntegrity
					? structuredClone(coin.marketDataIntegrity)
					: null,

			entryConfirmation:
				coin.entryConfirmation
					? structuredClone(coin.entryConfirmation)
					: null,

			entryTokenSecurity:
				coin.tokenSecurity
					? structuredClone(coin.tokenSecurity)
					: null,

			entrySmartMoney:
				coin.smartMoney
					? structuredClone(coin.smartMoney)
					: null,

			entryBirdeyeRank:
				Number.isFinite(Number(coin.birdeyeRank))
					? Number(coin.birdeyeRank)
					: null,

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

			riskManagementVersion:
				p.riskManagementVersion || null,

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

			entryVolume5m:
				p.entryVolume5m ?? null,

			entryVolume1h:
				p.entryVolume1h ?? null,

			entryVolume24h:
				p.entryVolume24h ?? null,

			entryDiscoverySources:
				Array.isArray(p.entryDiscoverySources)
					? [...p.entryDiscoverySources]
					: [],

			entryCurrentActivity:
				p.entryCurrentActivity
					? structuredClone(p.entryCurrentActivity)
					: null,

			entryPostPump:
				p.entryPostPump
					? structuredClone(p.entryPostPump)
					: null,

			entryPreDiscoveryPump:
				p.entryPreDiscoveryPump
					? structuredClone(p.entryPreDiscoveryPump)
					: null,

			entryMarketDataIntegrity:
				p.entryMarketDataIntegrity
					? structuredClone(p.entryMarketDataIntegrity)
					: null,

			entryConfirmation:
				p.entryConfirmation
					? structuredClone(p.entryConfirmation)
					: null,

			entryTokenSecurity:
				p.entryTokenSecurity
					? structuredClone(p.entryTokenSecurity)
					: null,

			entrySmartMoney:
				p.entrySmartMoney
					? structuredClone(p.entrySmartMoney)
					: null,

			entryBirdeyeRank:
				p.entryBirdeyeRank ?? null,

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

		if (percentToSell === 100) {
			const highest = Number(p.highestPrice || p.entryPrice);
			const entry = Number(p.entryPrice);
			const audit = {
				event: "TRADE_AUDIT_CLOSED",
				mode: "OG",
				positionId: p.id,
				symbol: p.symbol,
				strategyVersion: p.strategyVersion || null,
				riskManagementVersion: p.riskManagementVersion || null,
				entryTime: p.entryTime,
				exitTime: trade.exitTime,
				entryPrice: entry,
				exitPrice: currentPrice,
				highestPrice: highest,
				maxGainPercent: entry > 0 ? (highest - entry) / entry * 100 : null,
				exitPnlPercent: trade.pnlPercent,
				exitReason: trade.reason,
				entryScore: p.entryScore ?? null,
				entrySignal: p.entrySignal || null,
				entry5mPercent: p.entryPriceChange5m ?? null,
				entry1hPercent: p.entryPriceChange1h ?? null,
				entry24hPercent: p.entryPriceChange24h ?? null,
				entryLiquidityUsd: p.entryLiquidityUsd ?? null,
				entryVolume5m: p.entryVolume5m ?? null,
				entryVolume1h: p.entryVolume1h ?? null,
				entryVolume24h: p.entryVolume24h ?? null,
				entryVolumeLiquidity5mPercent: p.entryCurrentActivity?.volumeLiquidity5mPercent ?? null,
				entryTransactions5m: p.entryTransactions5m ?? null,
				entryBuyRatio: p.entryBuyRatio ?? p.entryBuyRatio5m ?? null,
				discoverySources: Array.isArray(p.entryDiscoverySources) ? [...p.entryDiscoverySources] : [],
				birdeyeRank: p.entryBirdeyeRank ?? null,
				smartMoney: p.entrySmartMoney ? structuredClone(p.entrySmartMoney) : null,
				postPump: p.entryPostPump ? structuredClone(p.entryPostPump) : null,
				preDiscoveryPump: p.entryPreDiscoveryPump ? structuredClone(p.entryPreDiscoveryPump) : null,
				marketDataIntegrity: p.entryMarketDataIntegrity ? structuredClone(p.entryMarketDataIntegrity) : null,
				entryReasons: Array.isArray(p.entryReasons) ? [...p.entryReasons] : []
			};
			console.log("TRADE_AUDIT " + JSON.stringify(audit));
		}

		return {
			success: true,
			trade: structuredClone(trade)
		};
	}


	function enableRiskManagement(expectedPosition, version = "V3.4") {
		const p = state.position;

		if (!p) {
			return fail("No position is open.");
		}

		if (
			expectedPosition &&
			expectedPosition !== positionKey(p)
		) {
			return fail("Position changed.");
		}

		if (p.riskManagementVersion === version) {
			return { success: true, changed: false };
		}

		const next = structuredClone(state);
		next.position.riskManagementVersion = version;
		commit(next);

		return { success: true, changed: true };
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
		enableRiskManagement,
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
	defaultDataFile,
	repairKnownJtoBadQuote,
	CURRENT_ENTRY_STRATEGY
};

for (const method of [
	"buy",
	"sell",
	"enableRiskManagement",
	"updateHigh",
	"positionKey",
	"getPortfolio"
]) {
	module.exports[method] =
		(...args) => current()[method](...args);
}
