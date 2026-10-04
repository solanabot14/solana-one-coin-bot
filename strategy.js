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
	const volume5m = Number(data.volume5m) || 0;
	const change5m = Number(data.priceChange5m) || 0;
	const change1h = Number(data.priceChange1h) || 0;
	const change24h = Number(data.priceChange24h) || 0;
	const buys = Number(data.buys5m) || 0;
	const sells = Number(data.sells5m) || 0;

	const totalTransactions = buys + sells;
	const buyRatio =
		totalTransactions > 0 ? buys / totalTransactions : 0;

	// Separate paper-only fast momentum lane; original signal remains unchanged.
	const labReasons = [];
	const labRequiredVolume5m = Math.max(2000, liquidity * 0.05);
	const labMomentumEntry = liquidity >= 20000 && volume5m >= labRequiredVolume5m &&
		change5m >= 0.25 && change5m <= 8 && change1h >= -25 && change1h <= 30 &&
		buyRatio >= 0.50 && totalTransactions >= 20;
	const labSignal = labMomentumEntry ? "FAST MOMENTUM WATCH" : "WAIT";
	if (labMomentumEntry) {
		labReasons.push("5m momentum, volume and transaction flow passed the lab gate");
		if (change1h < 0) labReasons.push("Rebound setup: negative 1h trend requires two-scan confirmation");
		if (change5m > 5 || change24h > 250) labReasons.push("High volatility: use half-size paper position");
	}

	// ==========================================
	// STRATEGY V3.1
	// EARLY MOMENTUM + ANTI-CHASE
	// ==========================================

	// HARD ANTI-CHASE
	if (change5m > 8) {
		return {
			score: 0,
			signal: "AVOID",
			reasons: ["ANTI-CHASE: 5m move already too high"], labSignal: "WAIT", labReasons: ["5m move exceeded lab anti-chase limit"]
		};
	}

	if (change1h > 40) {
		return {
			score: 0,
			signal: "AVOID",
			reasons: ["ANTI-CHASE: 1h move already too extended"], labSignal: "WAIT", labReasons: ["1h move exceeded lab range"]
		};
	}

	if (change24h > 250) {
		return {
			score: 0,
			signal: "AVOID",
			reasons: ["ANTI-CHASE: 24h move extremely extended"], labSignal, labReasons
		};
	}

	// LIQUIDITY
	if (liquidity >= 150000) {
		score += 2;
		reasons.push("Strong liquidity");
	} else if (liquidity >= 75000) {
		score += 1;
		reasons.push("Healthy liquidity");
	} else {
		score -= 2;
		reasons.push("Liquidity below preferred level");
	}

	// VOLUME
	if (volume24h >= 500000) {
		score += 2;
		reasons.push("Strong trading volume");
	} else if (volume24h >= 150000) {
		score += 1;
		reasons.push("Healthy trading volume");
	}

	// 5M MOMENTUM
	// V3.1 starts recognizing momentum slightly earlier.
	if (change5m >= 0.25 && change5m <= 5) {
		score += 4;
		reasons.push("Early 5m momentum detected");
	} else if (change5m > 5 && change5m <= 8) {
		score += 1;
		reasons.push("5m momentum becoming extended");
	} else if (change5m > 0 && change5m < 0.25) {
		score += 1;
		reasons.push("5m momentum beginning");
	} else {
		score -= 3;
		reasons.push("No positive 5m momentum");
	}

	// 1H TREND
	if (change1h >= 1 && change1h <= 20) {
		score += 3;
		reasons.push("Healthy early 1h trend");
	} else if (change1h > 20 && change1h <= 30) {
		score += 1;
		reasons.push("1h trend becoming extended");
	} else if (change1h > 30) {
		score -= 2;
		reasons.push("1h trend near overextended");
	} else if (change1h < 0) {
		score -= 2;
		reasons.push("1h trend negative");
	}

	// BUY / SELL PRESSURE
	if (totalTransactions < 20) {
		score -= 2;
		reasons.push("Not enough recent transactions");
	} else if (buyRatio >= 0.60 && buyRatio <= 0.75) {
		score += 4;
		reasons.push("Strong sustainable buy pressure");
	} else if (buyRatio >= 0.52) {
		score += 3;
		reasons.push("Healthy buy pressure");
	} else if (buyRatio >= 0.50) {
		score += 1;
		reasons.push("Slight buy pressure");
	} else {
		score -= 3;
		reasons.push("Sell pressure dominant");
	}

	// POSSIBLE BUYING FRENZY
	if (
		totalTransactions >= 20 &&
		buyRatio > 0.80 &&
		change5m > 4
	) {
		score -= 4;
		reasons.push("Possible late-stage buying frenzy");
	}

	// ==========================================
	// ENTRY DECISION
	// ==========================================

	let signal = "WAIT";

	const earlyEntryConditions =
		change5m >= 0.25 &&
		change5m <= 6 &&
		change1h > 0 &&
		change1h <= 30 &&
		buyRatio >= 0.52 &&
		totalTransactions >= 20;

	if (
		score >= 8 &&
		earlyEntryConditions
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
		reasons,
		labSignal,
		labReasons
	};
}

module.exports = { analyzeToken };

