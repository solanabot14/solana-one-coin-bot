const axios = require("axios");
const { getTokenData } = require("./dexscreener");
const { analyzeToken } = require("./strategy");

const DISCOVERY_SOURCES = [
	{
		name: "Latest Profiles",
		url: "https://api.dexscreener.com/token-profiles/latest/v1"
	},
	{
		name: "Community Takeovers",
		url: "https://api.dexscreener.com/community-takeovers/latest/v1"
	},
	{
		name: "Latest Boosts",
		url: "https://api.dexscreener.com/token-boosts/latest/v1"
	},
	{
		name: "Top Boosts",
		url: "https://api.dexscreener.com/token-boosts/top/v1"
	}
];

async function fetchDiscoverySource(source, signal) {
	try {
		const response = await axios.get(source.url, {
			timeout: 10000,
			signal
		});

		const tokens = Array.isArray(response.data)
			? response.data
			: [];

		console.log(
			`${source.name}: ${tokens.length} tokens received`
		);

		return tokens;
	} catch (error) {
		console.log(
			`${source.name} unavailable: ${error.message}`
		);

		return [];
	}
}

async function discoverCandidates({ signal } = {}) {
	console.log("\nScanning Solana for active tokens...");

	try {
		const results = await Promise.all(
			DISCOVERY_SOURCES.map(source =>
				fetchDiscoverySource(source, signal)
			)
		);

		const allTokens = results.flat();
		const uniqueSolanaTokens = new Map();

		for (const token of allTokens) {
			if (
				token.chainId !== "solana" ||
				!token.tokenAddress
			) {
				continue;
			}

			if (!uniqueSolanaTokens.has(token.tokenAddress)) {
				uniqueSolanaTokens.set(
					token.tokenAddress,
					token
				);
			}
		}

		const solanaTokens =
			Array.from(uniqueSolanaTokens.values());

		console.log(
			`Unique Solana candidates: ${solanaTokens.length}`
		);

		const candidates = [];

		for (const token of solanaTokens) {
			if (signal?.aborted) {
				return [];
			}

			const data = await getTokenData(
				token.tokenAddress,
				{ signal }
			);

			if (!data) {
				continue;
			}

			console.log(
				`CHECK ${data.symbol} | ` +
				`Liquidity: $${data.liquidityUsd || 0} | ` +
				`Volume24h: $${data.volume24h || 0}`
			);

			// Safety filters
			if (
				(data.liquidityUsd || 0) < 50000 ||
				(data.volume24h || 0) < 100000
			) {
				continue;
			}

			const analysis = analyzeToken(data);

			console.log(
				`PASSED FILTERS: ${data.symbol} | ` +
				`Score: ${analysis.score} | ` +
				`Signal: ${analysis.signal}`
			);

			candidates.push({
				tokenAddress: token.tokenAddress,
				...data,
				score: analysis.score,
				signal: analysis.signal,
				reasons: analysis.reasons
			});
		}

		candidates.sort((a, b) => b.score - a.score);

		console.log(
			`Candidates after safety filters: ${candidates.length}`
		);

		return candidates;
	} catch (error) {
		console.error(
			"Scanner error:",
			error.message
		);

		return [];
	}
}

module.exports = { discoverCandidates };
