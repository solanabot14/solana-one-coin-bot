const axios = require("axios");

async function getTokenData(tokenAddress, { signal } = {}) {
	try {
		const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
		const response = await axios.get(url, { timeout: 10000, signal });

		const pairs = response.data.pairs || [];

		if (pairs.length === 0) {
			return null;
		}

		const solanaPairs = pairs.filter(
			pair => pair.chainId === "solana" && pair.baseToken?.address === tokenAddress
		);

		if (solanaPairs.length === 0) {
			return null;
		}

		const bestPair = solanaPairs.sort(
			(a, b) =>
				(b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
		)[0];

		return {
			name: bestPair.baseToken?.name,
			symbol: bestPair.baseToken?.symbol,
			priceUsd: bestPair.priceUsd,
			liquidityUsd: bestPair.liquidity?.usd,
			volume24h: bestPair.volume?.h24,
			priceChange5m: bestPair.priceChange?.m5,
			priceChange1h: bestPair.priceChange?.h1,
			priceChange24h: bestPair.priceChange?.h24,
			buys5m: bestPair.txns?.m5?.buys,
			sells5m: bestPair.txns?.m5?.sells,
			pairAddress: bestPair.pairAddress
		};
	} catch (error) {
		console.error("DexScreener error:", error.message);
		return null;
	}
}

module.exports = { getTokenData };
