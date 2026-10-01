function tradeKey(trade) {
	return `${trade.tokenAddress || trade.symbol}-${trade.entryTime}`;
}

function groupCompletedTrades(history = [], openPositions = []) {
	const positions = Array.isArray(openPositions) ? openPositions.filter(Boolean) : (openPositions ? [openPositions] : []);
	const groups = new Map();
	// Bridge legacy rows only when their token/time identifies one known position.
	const legacyIds = new Map();
	const positionId = trade => trade.positionId || (trade.type !== "SELL" ? trade.id : null);
	for (const trade of [...history, ...positions]) {
		const id = positionId(trade);
		if (!id || !trade.entryTime) continue;
		const key = tradeKey(trade);
		if (!legacyIds.has(key)) legacyIds.set(key, new Set());
		legacyIds.get(key).add(id);
	}
	const groupKey = trade => {
		const ids = legacyIds.get(tradeKey(trade));
		const id = positionId(trade) || (ids?.size === 1 ? [...ids][0] : null);
		return id ? `position:${id}` : `legacy:${tradeKey(trade)}`;
	};

	for (const trade of history) {
		if (!trade.entryTime && !positionId(trade)) continue;

		const id = groupKey(trade);

		if (!groups.has(id)) {
			groups.set(id, {
				positionId: positionId(trade) || null,
				symbol: trade.symbol || "-",
				name: trade.name || "-",
				tokenAddress: trade.tokenAddress || "",
				pairAddress: trade.pairAddress || null,
				strategyVersion: trade.strategyVersion || null,
				entryTime: trade.entryTime,
				exitTime: null,
				entryPrice: Number(trade.entryPrice || 0),
				entryScore: trade.entryScore ?? null,
				entrySignal: trade.entrySignal || null,
				entryReasons: Array.isArray(trade.entryReasons) ? [...trade.entryReasons] : [],
				entryPriceChange5m: trade.entryPriceChange5m ?? null,
				entryPriceChange1h: trade.entryPriceChange1h ?? null,
				entryPriceChange24h: trade.entryPriceChange24h ?? null,
				entryLiquidityUsd: trade.entryLiquidityUsd ?? null,
				entryVolume5m: trade.entryVolume5m ?? null,
				entryVolume1h: trade.entryVolume1h ?? null,
				entryVolume24h: trade.entryVolume24h ?? null,
				entryDiscoverySources: Array.isArray(trade.entryDiscoverySources) ? [...trade.entryDiscoverySources] : [],
				entryCurrentActivity: trade.entryCurrentActivity ? structuredClone(trade.entryCurrentActivity) : null,
				entryPostPump: trade.entryPostPump ? structuredClone(trade.entryPostPump) : null,
				entryPreDiscoveryPump: trade.entryPreDiscoveryPump ? structuredClone(trade.entryPreDiscoveryPump) : null,
				entryMarketDataIntegrity: trade.entryMarketDataIntegrity ? structuredClone(trade.entryMarketDataIntegrity) : null,
				entrySmartMoney: trade.entrySmartMoney ? structuredClone(trade.entrySmartMoney) : null,
				entryBirdeyeRank: trade.entryBirdeyeRank ?? null,
				entryBuys5m: trade.entryBuys5m ?? null,
				entrySells5m: trade.entrySells5m ?? null,
				entryTransactions5m: trade.entryTransactions5m ?? null,
				entryBuyRatio5m: trade.entryBuyRatio5m ?? null,
				entryBuyRatio: trade.entryBuyRatio ?? trade.entryBuyRatio5m ?? null,
				highestPrice: Number(trade.highestPrice || trade.entryPrice || 0),
				amountInvested: 0,
				quantityBought: 0,
				quantitySold: 0,
				saleValue: 0,
				tp1SaleValue: 0,
				tp2SaleValue: 0,
				trailingSaleValue: 0,
				otherExitSaleValue: 0,
				pnl: 0,
				sells: []
			});
		}

		const group = groups.get(id);

		if (trade.type === "BUY") {
			group.amountInvested += Number(trade.amountInvested || 0);
			group.quantityBought += Number(trade.quantity || 0);
			if (trade.pairAddress) group.pairAddress = trade.pairAddress;
			if (Number(trade.highestPrice) > group.highestPrice) group.highestPrice = Number(trade.highestPrice);
		}

		if (trade.type === "SELL") {
			group.saleValue += Number(trade.saleValue || 0);
			const reason = String(trade.reason || "").trim().toUpperCase();
			const stage = reason === "TAKE PROFIT 1" ? "tp1SaleValue"
				: reason === "TAKE PROFIT 2" ? "tp2SaleValue"
					: reason === "TRAILING STOP" ? "trailingSaleValue" : "otherExitSaleValue";
			group[stage] += Number(trade.saleValue || 0);
			group.pnl += Number(trade.pnl || 0);
			group.quantitySold += Number(trade.quantitySold || 0);
			group.exitTime = trade.exitTime || group.exitTime;
			group.sells.push(trade);
			if (trade.pairAddress) group.pairAddress = trade.pairAddress;
			if (Number(trade.highestPrice) > group.highestPrice) group.highestPrice = Number(trade.highestPrice);
		}
	}

	return [...groups.entries()]
		.filter(([id, group]) => {
			if (positions.some(position => id === groupKey(position))) return false;
			return group.quantityBought > 0 && group.sells.length > 0 &&
				(group.sells.some(sell => Number(sell.percentSold) === 100) ||
					group.quantitySold >= group.quantityBought * (1 - 1e-10));
		})
		.map(([, group]) => {
			const exitPrice = group.quantitySold > 0 ? group.saleValue / group.quantitySold : null;
			const pnlPercent = group.amountInvested > 0 ? group.pnl / group.amountInvested * 100 : 0;
			const maxGainPercent = group.entryPrice > 0 && group.highestPrice > 0
				? (group.highestPrice - group.entryPrice) / group.entryPrice * 100 : null;
			const holdTimeMs = group.exitTime
				? Math.max(0, new Date(group.exitTime).getTime() - new Date(group.entryTime).getTime()) : null;
			const exitReasons = [...new Set(group.sells.map(sell => sell.reason).filter(Boolean))];
			return { ...group, exitPrice, pnlPercent, maxGainPercent, holdTimeMs, exitReasons };
		})
		.sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime));
}


const SLOT_TARGETS = [10, 50, 100, 150];

function buildSlotSimulation(completedTrades, slotCount = 5, startingSlotValue = 2) {
	const slots = Array.from({ length: slotCount }, (_, index) => ({
		id: index + 1,
		startingValue: startingSlotValue,
		balance: startingSlotValue,
		trades: 0,
		winners: 0,
		losers: 0,
		lastSymbol: null,
		lastReturnPercent: null
	}));

	const chronological = [...completedTrades]
		.filter(trade => Number.isFinite(Number(trade.pnlPercent)))
		.sort((a, b) => new Date(a.exitTime || a.entryTime) - new Date(b.exitTime || b.entryTime));

	let replayed = 0;
	for (const trade of chronological) {
		const slot = slots[replayed % slotCount];
		const returnPercent = Number(trade.pnlPercent);
		const factor = Math.max(0, 1 + returnPercent / 100);
		slot.balance *= factor;
		slot.trades++;
		if (returnPercent > 0) slot.winners++;
		else if (returnPercent < 0) slot.losers++;
		slot.lastSymbol = trade.symbol || "-";
		slot.lastReturnPercent = returnPercent;
		replayed++;
	}

	const completedTargets = SLOT_TARGETS.filter(target =>
		slots.every(slot => slot.balance >= target)
	);
	const currentTarget = SLOT_TARGETS.find(target =>
		!slots.every(slot => slot.balance >= target)
	) || SLOT_TARGETS.at(-1);
	const totalCapital = slots.reduce((sum, slot) => sum + slot.balance, 0);
	const startingCapital = slotCount * startingSlotValue;

	return {
		mode: "SIMULATION_ONLY",
		slotCount,
		startingSlotValue,
		startingCapital,
		totalCapital,
		totalPnl: totalCapital - startingCapital,
		totalReturnPercent: startingCapital > 0
			? (totalCapital - startingCapital) / startingCapital * 100
			: 0,
		targets: [...SLOT_TARGETS],
		completedTargets,
		currentTarget,
		allTargetsComplete: slots.every(slot => slot.balance >= SLOT_TARGETS.at(-1)),
		tradesReplayed: replayed,
		slots: slots.map(slot => ({
			...slot,
			progressPercent: currentTarget > 0
				? Math.min(100, slot.balance / currentTarget * 100)
				: 0
		}))
	};
}


const DIVERSITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIVERSITY_RUNNER_GAIN_PERCENT = 30;
const DIVERSITY_MAX_LOSS_ENTRIES = 2;

function buildTokenDiversityView(completedTrades = [], openPositions = [], now = Date.now()) {
	const positions = Array.isArray(openPositions) ? openPositions.filter(Boolean) : (openPositions ? [openPositions] : []);
	const cutoff = now - DIVERSITY_WINDOW_MS;
	const rows = new Map();

	for (const trade of completedTrades) {
		const entryMs = Date.parse(trade.entryTime);
		const exitMs = Date.parse(trade.exitTime);
		const recent = (Number.isFinite(entryMs) && entryMs >= cutoff) ||
			(Number.isFinite(exitMs) && exitMs >= cutoff);
		if (!recent || !trade.tokenAddress) continue;

		if (!rows.has(trade.tokenAddress)) {
			rows.set(trade.tokenAddress, {
				tokenAddress: trade.tokenAddress,
				symbol: trade.symbol || "-",
				entries24h: 0,
				wins24h: 0,
				losses24h: 0,
				maxGainPercent: null,
				lastExitAt: null,
				lastPnl: null
			});
		}

		const row = rows.get(trade.tokenAddress);
		if (Number.isFinite(entryMs) && entryMs >= cutoff) row.entries24h++;
		if (Number.isFinite(exitMs) && exitMs >= cutoff) {
			row.lastExitAt = Math.max(row.lastExitAt || 0, exitMs);
			row.lastPnl = Number(trade.pnl);
			if (Number(trade.pnl) > 0) row.wins24h++;
			else if (Number(trade.pnl) < 0) row.losses24h++;
		}
		if (Number.isFinite(Number(trade.maxGainPercent))) {
			row.maxGainPercent = row.maxGainPercent == null
				? Number(trade.maxGainPercent)
				: Math.max(row.maxGainPercent, Number(trade.maxGainPercent));
		}
	}

	for (const openPosition of positions) {
		if (!openPosition?.tokenAddress) continue;
		const existed = rows.has(openPosition.tokenAddress);
		if (!existed) {
			rows.set(openPosition.tokenAddress, {
				tokenAddress: openPosition.tokenAddress,
				symbol: openPosition.symbol || "-",
				entries24h: 0,
				wins24h: 0,
				losses24h: 0,
				maxGainPercent: null,
				lastExitAt: null,
				lastPnl: null
			});
		}
		const row = rows.get(openPosition.tokenAddress);
		const openEntryMs = Date.parse(openPosition.entryTime);
		if (Number.isFinite(openEntryMs) && openEntryMs >= cutoff) row.entries24h++;
		row.openNow = true;
		row.symbol = openPosition.symbol || row.symbol;
	}

	const result = [...rows.values()].map(row => {
		let status;
		let detail;
		let availableAt = null;

		if (row.openNow) {
			status = "OPEN NOW";
			detail = "Currently held by OG bot";
		} else if (Number(row.maxGainPercent) >= DIVERSITY_RUNNER_GAIN_PERCENT) {
			status = "RUNNER WATCH";
			detail = "Reentry only on exceptional confirmation";
		} else if (row.wins24h > 0) {
			status = "RESTING 24H";
			availableAt = row.lastExitAt ? row.lastExitAt + DIVERSITY_WINDOW_MS : null;
			detail = "Normal winner; new tokens get priority";
		} else if (row.entries24h >= DIVERSITY_MAX_LOSS_ENTRIES) {
			status = "REENTRY LIMIT";
			detail = "Already used two entries in the 24h window";
		} else if (row.losses24h > 0 || row.entries24h > 0) {
			status = "SECOND CHANCE";
			detail = "Can reenter if it becomes STRONG BUY again";
		} else {
			status = "AVAILABLE";
			detail = "No active diversity restriction";
		}

		return { ...row, status, detail, availableAt };
	}).sort((a, b) =>
		Number(Boolean(b.openNow)) - Number(Boolean(a.openNow)) ||
		Number(b.lastExitAt || 0) - Number(a.lastExitAt || 0)
	);

	return {
		windowHours: 24,
		runnerThresholdPercent: DIVERSITY_RUNNER_GAIN_PERCENT,
		rows: result
	};
}

function average(values) {
	const valid = values.filter(Number.isFinite);
	return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function maxLossStreak(trades = []) {
	let current = 0;
	let maximum = 0;
	for (const trade of [...trades].sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0))) {
		if (Number(trade.pnl) < 0) {
			current++;
			maximum = Math.max(maximum, current);
		} else {
			current = 0;
		}
	}
	return maximum;
}

function realizedDrawdown(trades = [], startingBalance = null) {
	const start = Number(startingBalance);
	if (!(start > 0)) return { maxDrawdownPercent: null, maxDrawdownUsd: null };
	let equity = start;
	let peak = start;
	let maxDrawdownPercent = 0;
	let maxDrawdownUsd = 0;

	for (const trade of [...trades].sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0))) {
		equity += Number(trade.pnl) || 0;
		peak = Math.max(peak, equity);
		const drawdownUsd = Math.max(0, peak - equity);
		const drawdownPercent = peak > 0 ? drawdownUsd / peak * 100 : 0;
		maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd);
		maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
	}

	return { maxDrawdownPercent, maxDrawdownUsd };
}

function summarizeTrades(trades = [], startingBalance = null) {
	const winners = trades.filter(trade => Number(trade.pnl) > 0);
	const losers = trades.filter(trade => Number(trade.pnl) < 0);
	const grossProfit = winners.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
	const grossLoss = losers.reduce((sum, trade) => sum + Math.abs(Number(trade.pnl || 0)), 0);
	const netPnl = grossProfit - grossLoss;
	const winnerReturns = winners.map(trade => Number(trade.pnlPercent)).filter(Number.isFinite);
	const loserReturns = losers.map(trade => Number(trade.pnlPercent)).filter(Number.isFinite);
	const allReturns = trades.map(trade => Number(trade.pnlPercent)).filter(Number.isFinite);
	const averageWinnerPercent = average(winnerReturns);
	const averageLoserPercent = average(loserReturns);
	const payoffRatio = averageWinnerPercent != null && averageLoserPercent != null && averageLoserPercent !== 0
		? averageWinnerPercent / Math.abs(averageLoserPercent)
		: null;
	const drawdown = realizedDrawdown(trades, startingBalance);

	return {
		completedTrades: trades.length,
		winners: winners.length,
		losers: losers.length,
		winRate: trades.length ? winners.length / trades.length * 100 : 0,
		grossProfit,
		grossLoss,
		netPnl,
		profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
		profitFactorLabel: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "—",
		expectancyPercent: average(allReturns),
		averageWinnerPercent,
		averageLoserPercent,
		payoffRatio,
		maxConsecutiveLosses: maxLossStreak(trades),
		maxDrawdownPercent: drawdown.maxDrawdownPercent,
		maxDrawdownUsd: drawdown.maxDrawdownUsd,
		averageHoldTimeMs: average(trades.map(trade => Number(trade.holdTimeMs)).filter(Number.isFinite)),
		averageMaxGainPercent: average(trades.map(trade => Number(trade.maxGainPercent)).filter(Number.isFinite))
	};
}

function compactPerformance(trades = []) {
	const summary = summarizeTrades(trades);
	return {
		trades: summary.completedTrades,
		winners: summary.winners,
		losers: summary.losers,
		winRate: summary.winRate,
		netPnl: summary.netPnl,
		expectancyPercent: summary.expectancyPercent,
		profitFactorLabel: summary.profitFactorLabel
	};
}

function buildStrategyVersionStats(trades = []) {
	const groups = new Map();
	for (const trade of trades) {
		const label = trade.strategyVersion || "Legacy / Unlabeled";
		if (!groups.has(label)) groups.set(label, []);
		groups.get(label).push(trade);
	}
	return [...groups.entries()]
		.map(([version, rows]) => ({ version, ...compactPerformance(rows) }))
		.sort((a, b) => String(a.version).localeCompare(String(b.version)));
}

function buildSourceStats(trades = []) {
	const groups = new Map();
	for (const trade of trades) {
		const sources = Array.isArray(trade.entryDiscoverySources) && trade.entryDiscoverySources.length
			? trade.entryDiscoverySources
			: ["Unknown"];
		for (const source of new Set(sources)) {
			if (!groups.has(source)) groups.set(source, []);
			groups.get(source).push(trade);
		}
	}
	return [...groups.entries()]
		.map(([source, rows]) => ({ source, ...compactPerformance(rows) }))
		.sort((a, b) => b.trades - a.trades || a.source.localeCompare(b.source));
}

function buildBirdeyeRankStats(trades = []) {
	const bucket = rank => {
		const value = Number(rank);
		if (!Number.isFinite(value)) return null;
		if (value === 1) return "#1";
		if (value <= 5) return "#2–5";
		if (value <= 10) return "#6–10";
		if (value <= 20) return "#11–20";
		return "#21+";
	};
	const order = new Map([["#1", 1], ["#2–5", 2], ["#6–10", 3], ["#11–20", 4], ["#21+", 5]]);
	const groups = new Map();
	for (const trade of trades) {
		const label = bucket(trade.entryBirdeyeRank);
		if (!label) continue;
		if (!groups.has(label)) groups.set(label, []);
		groups.get(label).push(trade);
	}
	return [...groups.entries()]
		.map(([rank, rows]) => ({ rank, ...compactPerformance(rows) }))
		.sort((a, b) => (order.get(a.rank) || 99) - (order.get(b.rank) || 99));
}

function buildScoreStats(completedTrades) {
	const buckets = new Map();
	for (const trade of completedTrades) {
		if (trade.entryScore == null) continue;
		const score = Number(trade.entryScore);
		if (!Number.isFinite(score)) continue;
		const label = score >= 10 ? "10+" : String(score);
		if (!buckets.has(label)) buckets.set(label, []);
		buckets.get(label).push(trade);
	}
	return [...buckets.entries()].map(([score, trades]) => {
		const winners = trades.filter(t => t.pnl > 0).length;
		const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
		return {
			score, trades: trades.length, winners, losers: trades.filter(t => t.pnl < 0).length,
			winRate: trades.length ? winners / trades.length * 100 : 0,
			averageReturn: average(trades.map(t => Number(t.pnlPercent))),
			averageMaxGain: average(trades.map(t => Number(t.maxGainPercent))), netPnl
		};
	}).sort((a, b) => (a.score === "10+" ? 10 : Number(a.score)) - (b.score === "10+" ? 10 : Number(b.score)));
}

async function buildDashboardData(data, getTokenData, baselineData = null) {
	const openPositions = Array.isArray(data.positions) ? data.positions.filter(Boolean) : (data.position ? [data.position] : []);
	const completedTrades = groupCompletedTrades(data.history, openPositions);
	const livePositions = [];
	let live = null;
	if (openPositions.length) {
		for (const p of openPositions) {
			const fresh = await getTokenData(p.tokenAddress, { pairAddress: p.pairAddress || undefined });
			const currentPrice = Number(fresh?.priceUsd);
			if (!(Number.isFinite(currentPrice) && currentPrice > 0)) continue;
			const currentValue = p.quantity * currentPrice;
			const pnl = currentValue - p.amountInvested;
			const highestPrice = Number(p.highestPrice || p.entryPrice);
			const entryPrice = Number(p.entryPrice);
			const maxGainPercent = entryPrice > 0 ? (highestPrice - entryPrice) / entryPrice * 100 : null;
			const profitLockEligible = p.riskManagementVersion === "V3.4" || p.strategyVersion === "V3.3" || p.strategyVersion === "V3.4" || p.strategyVersion === "R3-EARLY-RUNNER";
			const profitLockActive = profitLockEligible && !p.secondTakeProfitDone && maxGainPercent >= 10;
			const protectedFloorPercent = profitLockActive ? maxGainPercent - 8 : null;
			const runnerMode = !!p.secondTakeProfitDone;
			const trailingExitPrice = runnerMode ? highestPrice * 0.92 : null;
			const trailingExitPercent = runnerMode && entryPrice > 0
				? (trailingExitPrice - entryPrice) / entryPrice * 100 : null;
			const mode = runnerMode ? "RUNNER" : profitLockActive ? "PROFIT LOCK" : "NORMAL";
			const holdTimeMs = Math.max(0, Date.now() - new Date(p.entryTime).getTime());
			const buys5m = Number(fresh.buys5m) || 0;
			const sells5m = Number(fresh.sells5m) || 0;
			const transactions5m = buys5m + sells5m;
			const liveEntry = {
				positionId: p.id || null,
				symbol: p.symbol,
				tokenAddress: p.tokenAddress,
				currentPrice, currentValue, pnl, pnlPercent: p.amountInvested > 0 ? pnl / p.amountInvested * 100 : 0,
				highestPrice, maxGainPercent, holdTimeMs,
				mode, profitLockActive, protectedFloorPercent, trailingExitPrice, trailingExitPercent,
				priceChange5m: fresh.priceChange5m, priceChange1h: fresh.priceChange1h, priceChange24h: fresh.priceChange24h,
				liquidityUsd: fresh.liquidityUsd, volume5m: fresh.volume5m, volume1h: fresh.volume1h, volume24h: fresh.volume24h, buys5m, sells5m, transactions5m,
				buyRatio5m: transactions5m > 0 ? buys5m / transactions5m : 0,
				pairAddress: p.pairAddress || fresh.pairAddress || null
			};
			livePositions.push(liveEntry);
		}
		live = livePositions[0] || null;
	}

	const allLivePriced = livePositions.length === openPositions.length;
	const equity = openPositions.length && !allLivePriced
		? null
		: data.cashBalance + livePositions.reduce((sum, item) => sum + Number(item.currentValue || 0), 0);
	const exitReasonCounts = {};
	for (const trade of completedTrades) for (const reason of trade.exitReasons) exitReasonCounts[reason] = (exitReasonCounts[reason] || 0) + 1;

	const stats = summarizeTrades(completedTrades, data.startingBalance);
	const baselineCompletedTrades = baselineData
		? groupCompletedTrades(baselineData.history || [], baselineData.positions || baselineData.position || null)
		: [];
	const v35Research = {
		strategyVersion: "V3.1R2",
		name: "Historical Baseline",
		startedAt: baselineCompletedTrades.length
			? [...baselineCompletedTrades].sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))[0]?.entryTime || null
			: null,
		startingBalance: Number.isFinite(Number(baselineData?.startingBalance)) ? Number(baselineData.startingBalance) : null,
		stats: summarizeTrades(baselineCompletedTrades, baselineData?.startingBalance),
		sourceStats: buildSourceStats(baselineCompletedTrades),
		birdeyeRankStats: buildBirdeyeRankStats(baselineCompletedTrades)
	};

	const currentR3Trades = completedTrades.filter(trade => trade.strategyVersion === "R3-EARLY-RUNNER");
	const v36Research = {
		strategyVersion: "R3-EARLY-RUNNER",
		name: "R3 Early Runner",
		startedAt: currentR3Trades.length
			? [...currentR3Trades].sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))[0]?.entryTime || null
			: null,
		startingBalance: Number.isFinite(Number(data.startingBalance)) ? Number(data.startingBalance) : null,
		stats: summarizeTrades(currentR3Trades, data.startingBalance),
		sourceStats: buildSourceStats(currentR3Trades),
		birdeyeRankStats: buildBirdeyeRankStats(currentR3Trades)
	};

	return {
		...data, live, livePositions, equity, totalPnl: equity === null ? null : equity - data.startingBalance,
		priceUnavailable: openPositions.length > 0 && !allLivePriced, completedTrades, scoreStats: buildScoreStats(completedTrades), exitReasonCounts,
		strategyVersionStats: buildStrategyVersionStats(completedTrades),
		v35Research,
		v36Research,
		slotSimulation: buildSlotSimulation(completedTrades),
		tokenDiversity: buildTokenDiversityView(completedTrades, openPositions),
		stats
	};
}

module.exports = {
	groupCompletedTrades,
	buildDashboardData,
	buildSlotSimulation,
	buildTokenDiversityView,
	summarizeTrades,
	buildStrategyVersionStats,
	buildSourceStats,
	buildBirdeyeRankStats
};
