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

	// -----------------------------------
	// LIQUIDITY
	// -----------------------------------
	if (liquidity >= 150000) {
		score += 2;
		reasons.push("Strong liquidity");
	} else if (liquidity >= 75000) {
		score += 1;
		reasons.push("Acceptable liquidity");
	} else {
		score -= 2;
		reasons.push("Low liquidity");
	}

	// -----------------------------------
	// VOLUME
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
	// Prefer positive momentum,
	// but avoid chasing extreme pumps.
	// -----------------------------------
	if (change5m >= 2 && change5m <= 15) {
		score += 3;
		reasons.push("Healthy 5m momentum");
	} else if (change5m > 0 && change5m < 2) {
		score += 1;
		reasons.push("5m momentum positive");
	} else if (change5m > 15) {
		score -= 3;
		reasons.push("5m pump may be overextended");
	} else if (change5m < -3) {
		score -= 3;
		reasons.push("5m momentum falling");
	}

	// -----------------------------------
	// 1 HOUR MOMENTUM
	// -----------------------------------
	if (change1h >= 5 && change1h <= 40) {
		score += 2;
		reasons.push("Healthy 1h trend");
	} else if (change1h > 0 && change1h < 5) {
		score += 1;
		reasons.push("1h trend positive");
	} else if (change1h > 75) {
		score -= 3;
		reasons.push("1h move excessively extended");
	} else if (change1h < -10) {
		score -= 2;
		reasons.push("1h trend weak");
	}

	// -----------------------------------
	// BUY / SELL PRESSURE
	// -----------------------------------
	const totalTransactions = buys + sells;
	const buyRatio =
		totalTransactions > 0 ? buys / totalTransactions : 0;

	if (totalTransactions < 10) {
		score -= 2;
		reasons.push("Low recent transaction activity");
	} else if (buyRatio >= 0.60) {
		score += 3;
		reasons.push("Strong buy pressure");
	} else if (buyRatio >= 0.55) {
		score += 2;
		reasons.push("Healthy buy pressure");
	} else if (buyRatio >= 0.50) {
		score += 1;
		reasons.push("Buy pressure slightly positive");
	} else if (buyRatio < 0.45) {
		score -= 3;
		reasons.push("Sell pressure dominant");
	}

	// -----------------------------------
	// 24 HOUR EXTREME MOVE
	// Small penalty only — meme coins
	// can legitimately have large moves.
	// -----------------------------------
	if (change24h > 500) {
		score -= 2;
		reasons.push("24h move extremely extended");
	}

	// -----------------------------------
	// SIGNAL
	// -----------------------------------
	let signal = "WAIT";

	if (
		score >= 8 &&
		change5m > 0 &&
		buyRatio >= 0.55
	) {
		signal = "STRONG BUY";
	} else if (score >= 6) {
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
