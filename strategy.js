function analyzeToken(data) {
	if (!data) {
		return {
			score: 0,
			signal: "NO DATA",
			reasons: ["No token data available"]
		};
	}

	let score = 0;
	const reasons = [];

	const liquidity = Number(data.liquidityUsd) || 0;
	const volume24h = Number(data.volume24h) || 0;
	const change5m = Number(data.priceChange5m) || 0;
	const change1h = Number(data.priceChange1h) || 0;
	const change24h = Number(data.priceChange24h) || 0;
	const buys = Number(data.buys5m) || 0;
	const sells = Number(data.sells5m) || 0;

	const totalTransactions = buys + sells;

	const buyRatio =
		totalTransactions > 0
			? buys / totalTransactions
			: 0;

	// -----------------------------------
	// LIQUIDITY
	// Scanner already requires $50K.
	// Reward stronger liquidity.
	// -----------------------------------

	if (liquidity >= 150000) {
		score += 2;
		reasons.push("Strong liquidity");
	} else if (liquidity >= 75000) {
		score += 1;
		reasons.push("Good liquidity");
	}

	// -----------------------------------
	// VOLUME
	// Scanner already requires $100K.
	// -----------------------------------

	if (volume24h >= 500000) {
		score += 2;
		reasons.push("Strong 24h volume");
	} else if (volume24h >= 150000) {
		score += 1;
		reasons.push("Good 24h volume");
	}

	// -----------------------------------
	// 5 MINUTE MOMENTUM
	// Most important short-term signal.
	// -----------------------------------

	if (change5m >= 1.5 && change5m <= 12) {
		score += 3;
		reasons.push("Strong healthy 5m momentum");
	} else if (change5m > 0 && change5m < 1.5) {
		score += 1;
		reasons.push("5m momentum positive");
	} else if (change5m > 12 && change5m <= 20) {
		score -= 1;
		reasons.push("5m momentum extended");
	} else if (change5m > 20) {
		score -= 4;
		reasons.push("5m pump dangerously extended");
	} else if (change5m < -3) {
		score -= 3;
		reasons.push("5m momentum falling");
	}

	// -----------------------------------
	// 1 HOUR TREND
	// -----------------------------------

	if (change1h >= 3 && change1h <= 35) {
		score += 2;
		reasons.push("Healthy 1h trend");
	} else if (change1h > 0 && change1h < 3) {
		score += 1;
		reasons.push("1h trend positive");
	} else if (change1h > 60) {
		score -= 2;
		reasons.push("1h move overextended");
	} else if (change1h < -10) {
		score -= 2;
		reasons.push("1h trend weak");
	}

	// -----------------------------------
	// BUY / SELL PRESSURE
	// -----------------------------------

	if (totalTransactions < 10) {
		score -= 2;
		reasons.push("Low recent transaction activity");
	} else if (buyRatio >= 0.60) {
		score += 3;
		reasons.push("Strong buy pressure");
	} else if (buyRatio >= 0.55) {
		score += 2;
		reasons.push("Healthy buy pressure");
	} else if (buyRatio >= 0.52) {
		score += 1;
		reasons.push("Buy pressure positive");
	} else if (buyRatio < 0.45) {
		score -= 3;
		reasons.push("Sell pressure dominant");
	}

	// -----------------------------------
	// EXTREME 24H MOVE
	// -----------------------------------

	if (change24h > 500) {
		score -= 2;
		reasons.push("24h move extremely extended");
	}

	// -----------------------------------
	// HARD ENTRY PROTECTION
	// These conditions prevent a high
	// score from overriding bad momentum.
	// -----------------------------------

	const healthyEntry =
		change5m > 0 &&
		change5m <= 15 &&
		buyRatio >= 0.52 &&
		totalTransactions >= 10;

	// -----------------------------------
	// SIGNAL
	// -----------------------------------

	let signal = "WAIT";

	if (
		score >= 6 &&
		healthyEntry
	) {
		signal = "STRONG BUY";
	} else if (
		score >= 5 &&
		change5m > 0 &&
		buyRatio >= 0.50
	) {
		signal = "BUY";
	} else if (score <= 2) {
		signal = "AVOID";
	}

	return {
		score,
		signal,
		reasons
	};
}

module.exports = { analyzeToken };
