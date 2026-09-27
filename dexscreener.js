const axios = require("axios");

function pairToTokenData(pair, tokenAddress) {
	if (!pair || pair.chainId !== "solana" || pair.baseToken?.address !== tokenAddress) {
		return null;
	}

	return {
		name: pair.baseToken?.name,
		symbol: pair.baseToken?.symbol,
		priceUsd: pair.priceUsd,
		liquidityUsd: pair.liquidity?.usd,
		volume5m: pair.volume?.m5,
		volume1h: pair.volume?.h1,
		volume24h: pair.volume?.h24,
		priceChange5m: pair.priceChange?.m5,
		priceChange1h: pair.priceChange?.h1,
		priceChange24h: pair.priceChange?.h24,
		buys5m: pair.txns?.m5?.buys,
		sells5m: pair.txns?.m5?.sells,
		pairAddress: pair.pairAddress
	};
}

async function getTokenData(tokenAddress, { signal, pairAddress } = {}) {
	try {
		if (pairAddress) {
			const url = "https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(pairAddress);
			const response = await axios.get(url, { timeout: 10000, signal });
			const pairs = Array.isArray(response.data?.pairs)
				? response.data.pairs
				: response.data?.pair
					? [response.data.pair]
					: [];

			const exactPair = pairs.find(pair =>
				pair?.chainId === "solana" && pair?.pairAddress === pairAddress
			);

			if (!exactPair) {
				console.log("PAIR LOCK UNAVAILABLE | " + tokenAddress + " | Pair: " + pairAddress);
				return null;
			}

			const data = pairToTokenData(exactPair, tokenAddress);
			if (!data) {
				console.log(
					"PAIR LOCK MISMATCH | " + tokenAddress + " | Pair: " + pairAddress +
					" | Base token: " + (exactPair.baseToken?.address || "unknown")
				);
				return null;
			}

			return data;
		}

		const url = "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress);
		const response = await axios.get(url, { timeout: 10000, signal });
		const pairs = response.data.pairs || [];

		const solanaPairs = pairs.filter(
			pair => pair.chainId === "solana" && pair.baseToken?.address === tokenAddress
		);

		if (solanaPairs.length === 0) {
			return null;
		}

		const bestPair = solanaPairs.sort(
			(a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
		)[0];

		return pairToTokenData(bestPair, tokenAddress);
	} catch (error) {
		const mode = pairAddress ? "pair-locked" : "token";
		console.error("DexScreener " + mode + " error:", error.message);
		return null;
	}
}

module.exports = { getTokenData, pairToTokenData };
