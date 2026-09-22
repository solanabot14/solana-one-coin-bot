const axios = require("axios");
const { getTokenData } = require("./dexscreener");
const { analyzeToken } = require("./strategy");

async function discoverCandidates() {
	console.log("Scanning Solana for active tokens...");

	try {
		// DexScreener latest token profiles
		const response = await axios.get(
			"https://api.dexscreener.com/token-profiles/latest/v1"
		);

		const profiles = response.data || [];

		// Only Solana tokens
		const solanaTokens = profiles
			.filter(token => token.chainId === "solana")
			.slice(0, 30);

		console.log(`Found ${solanaTokens.length} Solana candidates`);

		const candidates = [];

		for (const token of solanaTokens) {
			const data = await getTokenData(token.tokenAddress);

			if (!data) continue;
            console.log(
  `CHECK ${data.symbol} | Liquidity: $${data.liquidityUsd || 0} | Volume24h: $${data.volume24h || 0}`
);

			// Basic safety/activity filters
			if ((data.liquidityUsd || 0) < 50000) continue;
			if ((data.volume24h || 0) < 100000) continue;

			const analysis = analyzeToken(data);
            console.log(`PASSED FILTERS: ${data.symbol} | Score: ${analysis.score} | Signal: ${analysis.signal}`);
            console.log(`PASSED FILTERS: ${data.symbol} | Score: ${analysis.score} | Signal: ${analysis.signal}`);

			candidates.push({
				tokenAddress: token.tokenAddress,
				...data,
				score: analysis.score,
				signal: analysis.signal,
				reasons: analysis.reasons
			});
		}

		// Highest score first
		candidates.sort((a, b) => b.score - a.score);

		return candidates;
	} catch (error) {
		console.error("Scanner error:", error.message);
		return [];
	}
}

module.exports = { discoverCandidates };
