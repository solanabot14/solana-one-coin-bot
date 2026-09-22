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

	// Liquidity
	if (data.liquidityUsd >= 100000) {
		score += 2;
		reasons.push("Strong liquidity");
	} else if (data.liquidityUsd >= 50000) {
		score += 1;
		reasons.push("Acceptable liquidity");
	}

	// Trading volume
	if (data.volume24h >= 500000) {
		score += 2;
		reasons.push("Strong 24h volume");
	} else if (data.volume24h >= 100000) {
		score += 1;
		reasons.push("Good 24h volume");
	}

	// Short-term momentum
	if (data.priceChange5m > 1) {
		score += 2;
		reasons.push("5m momentum rising");
	} else if (data.priceChange5m > 0) {
		score += 1;
		reasons.push("5m momentum positive");
	}

	if (data.priceChange1h > 3) {
		score += 2;
		reasons.push("1h momentum strong");
	} else if (data.priceChange1h > 0) {
		score += 1;
		reasons.push("1h momentum positive");
	}

	// Buy vs sell pressure
	const buys = data.buys5m || 0;
	const sells = data.sells5m || 0;

	if (buys > sells * 1.25) {
		score += 2;
		reasons.push("Buy pressure stronger than sell pressure");
	} else if (buys > sells) {
		score += 1;
		reasons.push("Buy pressure positive");
	}

	let signal = "WAIT";

	if (score >= 7) {
		signal = "STRONG BUY";
	} else if (score >= 5) {
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
