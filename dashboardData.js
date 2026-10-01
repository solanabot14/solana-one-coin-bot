function tradeKey(trade) {
	return `${trade.tokenAddress || trade.symbol}-${trade.entryTime}`;
}

function groupCompletedTrades(history = [], position = null) {
	const groups = new Map();
	// Bridge legacy rows only when their token/time identifies one known position.
	const legacyIds = new Map();
	const positionId = trade => trade.positionId || (trade.type !== "SELL" ? trade.id : null);
	for (const trade of [...history, ...(position ? [position] : [])]) {
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
				entryVolume24h: trade.entryVolume24h ?? null,
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
			if (position && id === groupKey(position)) return false;
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

function average(values) {
	const valid = values.filter(Number.isFinite);
	return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
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

async function buildDashboardData(data, getTokenData) {
	const positions = Array.isArray(data.positions) ? data.positions : (data.position ? [data.position] : []);
	const completedTrades = groupCompletedTrades(data.history, null).filter(t => !positions.some(p => p.id && p.id === t.positionId));
	const livePositions = [];
	for (const p of positions) {
		let live = null;
		try {
			const fresh = await getTokenData(p.tokenAddress);
			const currentPrice = Number(fresh?.priceUsd);
			if (Number.isFinite(currentPrice) && currentPrice > 0) {
				const currentValue = p.quantity * currentPrice, pnl = currentValue - p.amountInvested;
				const highestPrice = Number(p.highestPrice || p.entryPrice);
				const buys5m=Number(fresh.buys5m)||0, sells5m=Number(fresh.sells5m)||0, transactions5m=buys5m+sells5m;
				live={currentPrice,currentValue,pnl,pnlPercent:p.amountInvested>0?pnl/p.amountInvested*100:0,highestPrice,
					maxGainPercent:Number(p.entryPrice)>0?(highestPrice-Number(p.entryPrice))/Number(p.entryPrice)*100:null,
					holdTimeMs:Math.max(0,Date.now()-new Date(p.entryTime).getTime()),priceChange5m:fresh.priceChange5m,
					priceChange1h:fresh.priceChange1h,priceChange24h:fresh.priceChange24h,liquidityUsd:fresh.liquidityUsd,
					volume24h:fresh.volume24h,buys5m,sells5m,transactions5m,buyRatio5m:transactions5m?buys5m/transactions5m:0,
					pairAddress:p.pairAddress||fresh.pairAddress||null};
			}
		} catch (_) {}
		livePositions.push({position:p,live});
	}
	const grossProfit=completedTrades.reduce((s,t)=>s+Math.max(t.pnl,0),0), grossLoss=completedTrades.reduce((s,t)=>s+Math.max(-t.pnl,0),0);
	const winners=completedTrades.filter(t=>t.pnl>0).length, losers=completedTrades.filter(t=>t.pnl<0).length;
	const pricesAvailable=livePositions.every(x=>x.live), openValue=livePositions.reduce((s,x)=>s+(x.live?.currentValue||0),0);
	const equity=pricesAvailable ? data.cashBalance+openValue : null;
	const winnerReturns=completedTrades.filter(t=>t.pnl>0).map(t=>Number(t.pnlPercent)), loserReturns=completedTrades.filter(t=>t.pnl<0).map(t=>Number(t.pnlPercent));
	const holdTimes=completedTrades.map(t=>Number(t.holdTimeMs)).filter(Number.isFinite), maxGains=completedTrades.map(t=>Number(t.maxGainPercent)).filter(Number.isFinite);
	const exitReasonCounts={}; for(const trade of completedTrades) for(const reason of trade.exitReasons) exitReasonCounts[reason]=(exitReasonCounts[reason]||0)+1;
	const netPnl=grossProfit-grossLoss;
	return {...data, position:positions[0]||null, positions, live:livePositions[0]?.live||null, livePositions,
		openSlots:positions.length,maxSlots:3,equity,totalPnl:equity===null?null:equity-data.startingBalance,
		priceUnavailable:positions.length>0&&!pricesAvailable,completedTrades,scoreStats:buildScoreStats(completedTrades),exitReasonCounts,
		stats:{completedTrades:completedTrades.length,winners,losers,winRate:completedTrades.length?winners/completedTrades.length*100:0,
			netPnl,grossProfit,grossLoss,profitFactor:grossLoss>0?grossProfit/grossLoss:null,profitFactorLabel:grossLoss>0?(grossProfit/grossLoss).toFixed(2):grossProfit>0?"∞":"—",
			averageWinnerPercent:average(winnerReturns),averageLoserPercent:average(loserReturns),averageHoldTimeMs:average(holdTimes),averageMaxGainPercent:average(maxGains)}};
}

module.exports = { groupCompletedTrades, buildDashboardData };
