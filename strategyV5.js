function clamp(value, min, max) {
	return Math.max(min, Math.min(max, Number(value) || 0));
}

function tokenAgeRegime(pairCreatedAt, now = Date.now()) {
	const created = Number(pairCreatedAt);
	if (!(created > 0)) return { name: "UNKNOWN", ageMinutes: null, min1h: 0.50, minTransactions: 20 };
	const ageMinutes = Math.max(0, (now - created) / 60000);
	if (ageMinutes < 60) return { name: "LAUNCH", ageMinutes, min1h: null, minTransactions: 12 };
	if (ageMinutes < 360) return { name: "EARLY", ageMinutes, min1h: 0.00, minTransactions: 15 };
	if (ageMinutes < 2880) return { name: "EXPANSION", ageMinutes, min1h: 0.25, minTransactions: 18 };
	return { name: "ESTABLISHED", ageMinutes, min1h: 0.50, minTransactions: 20 };
}

function scoreMomentum5m(change5m) {
	const v = Number(change5m) || 0;
	if (v <= 0) return 0;
	if (v < 0.15) return 4 + 4 * (v / 0.15);
	if (v <= 2.5) return 15;
	if (v < 4) return 15 - 8 * ((v - 2.5) / 1.5);
	return 0;
}

function scoreOneHour(change1h, regime) {
	const v = Number(change1h) || 0;
	if (regime.name === "LAUNCH") {
		if (v < -5) return 0;
		if (v <= 15) return 10;
		if (v <= 30) return 6;
		return 2;
	}
	if (v < 0) return 0;
	if (v < 1) return 4 + 6 * v;
	if (v <= 15) return 10;
	if (v <= 30) return 6;
	return 2;
}

function analyzeTokenV5(data, { heliusFlow = null, now = Date.now() } = {}) {
	if (!data) return { score: 0, signal: "NO DATA", reasons: ["No token data available"], v5: null };

	const liquidity = Number(data.liquidityUsd) || 0;
	const volume5m = Number(data.volume5m) || 0;
	const volume1h = Number(data.volume1h) || 0;
	const volume24h = Number(data.volume24h) || 0;
	const change5m = Number(data.priceChange5m) || 0;
	const change1h = Number(data.priceChange1h) || 0;
	const change24h = Number(data.priceChange24h) || 0;
	const buys = Number(data.buys5m) || 0;
	const sells = Number(data.sells5m) || 0;
	const transactions = buys + sells;
	const buyRatio = transactions > 0 ? buys / transactions : 0;
	const regime = tokenAgeRegime(data.pairCreatedAt, now);
	const reasons = [];

	if (change5m >= 4) return { score: 0, signal: "AVOID", reasons: ["ANTI-CHASE: 5m move already too high"], v5: { regime } };
	if (change1h > 40) return { score: 0, signal: "AVOID", reasons: ["ANTI-CHASE: 1h move already too extended"], v5: { regime } };
	if (change24h > 250) return { score: 0, signal: "AVOID", reasons: ["ANTI-CHASE: 24h move extremely extended"], v5: { regime } };

	let score = 0;

	// Liquidity quality: 0-10.
	if (liquidity >= 250000) score += 10;
	else if (liquidity >= 150000) score += 8;
	else if (liquidity >= 75000) score += 6;
	else if (liquidity >= 50000) score += 4;
	reasons.push("Liquidity quality " + Math.min(10, score).toFixed(1) + "/10");

	// Current 5m participation: 0-15. The scanner still owns the hard $5k safety floor.
	score += clamp(15 * (Math.log10(Math.max(1000, volume5m)) - 3) / 2, 0, 15);

	// Volume acceleration versus the hourly pace: 0-15.
	const expected5m = volume1h > 0 ? volume1h / 12 : 0;
	const acceleration = expected5m > 0 ? volume5m / expected5m : 0;
	score += clamp(acceleration / 2 * 15, 0, 15);

	// Early momentum: 0-15, with the existing 4% anti-chase hard ceiling.
	score += scoreMomentum5m(change5m);

	// Contextual 1h trend: 0-10, interpreted by token age instead of one universal floor.
	score += scoreOneHour(change1h, regime);

	// Buy pressure: 0-15.
	if (buyRatio >= 0.60 && buyRatio <= 0.78) score += 15;
	else if (buyRatio >= 0.55) score += 12;
	else if (buyRatio >= 0.52) score += 8;
	else if (buyRatio >= 0.50) score += 4;

	// Transaction breadth proxy: 0-10.
	score += clamp(transactions / 50 * 10, 0, 10);

	// Market participation over 24h: 0-5.
	if (volume24h >= 500000) score += 5;
	else if (volume24h >= 150000) score += 3;

	// Helius pool-flow quality: up to +10, only when available.
	let flowBonus = 0;
	if (heliusFlow?.status === "OK") {
		const swaps = Number(heliusFlow.swapsLast5m) || 0;
		const unique = Number(heliusFlow.uniqueMakers5m) || 0;
		const uniqueRatio = Number(heliusFlow.uniqueMakerRatio) || 0;
		flowBonus =
			clamp(swaps / 30 * 4, 0, 4) +
			clamp(unique / 12 * 4, 0, 4) +
			clamp(uniqueRatio / 0.60 * 2, 0, 2);
		score += flowBonus;
		if (swaps >= 15 && unique <= 2) score -= 12;
		if (swaps >= 20 && uniqueRatio < 0.15) score -= 10;
	}

	score = clamp(score, 0, 100);

	const dynamic1hPass = regime.min1h == null || change1h >= regime.min1h;
	const coreConditions =
		change5m > 0 &&
		change5m < 4 &&
		change1h <= 30 &&
		dynamic1hPass &&
		buyRatio >= 0.52 &&
		transactions >= regime.minTransactions;

	let signal = "WAIT";
	if (score >= 70 && coreConditions) signal = "STRONG BUY";
	else if (score >= 58) signal = "BUY";
	else if (score < 35) signal = "AVOID";

	reasons.push("V5 regime: " + regime.name);
	reasons.push("V5 weighted score: " + score.toFixed(1));
	if (heliusFlow?.status === "OK") {
		reasons.push("Helius flow: " + (heliusFlow.uniqueMakers5m || 0) + " unique makers / " + (heliusFlow.swapsLast5m || 0) + " swaps");
	}

	return {
		score: Number(score.toFixed(2)),
		signal,
		reasons,
		v5: {
			regime,
			volumeAcceleration: Number(acceleration.toFixed(4)),
			flowBonus: Number(flowBonus.toFixed(2)),
			dynamic1hPass,
			min1h: regime.min1h,
			minTransactions: regime.minTransactions,
			buyRatio,
			transactions
		}
	};
}

module.exports = {
	analyzeTokenV5,
	tokenAgeRegime,
	scoreMomentum5m,
	scoreOneHour
};
