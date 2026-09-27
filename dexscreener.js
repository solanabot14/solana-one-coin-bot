const axios = require("axios");

const DEX_DISCOVERY_CIRCUIT_FAILURES = Math.max(
	2,
	Number.parseInt(process.env.DEX_DISCOVERY_CIRCUIT_FAILURES || "3", 10) || 3
);
const DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS = Math.max(
	30000,
	(Number.parseInt(process.env.DEX_DISCOVERY_CIRCUIT_SECONDS || "60", 10) || 60) * 1000
);

const health = {
	consecutiveDiscoveryFailures: 0,
	circuitOpenedAt: 0,
	lastSuccessAt: null,
	lastErrorAt: null,
	lastErrorStatus: null,
	lastErrorMessage: null
};

function circuitOpen(now = Date.now()) {
	if (!health.circuitOpenedAt) return false;
	if (now - health.circuitOpenedAt >= DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS) {
		health.circuitOpenedAt = 0;
		health.consecutiveDiscoveryFailures = 0;
		return false;
	}
	return true;
}

function recordSuccess() {
	health.lastSuccessAt = new Date().toISOString();
	health.consecutiveDiscoveryFailures = 0;
	health.circuitOpenedAt = 0;
}

function recordFailure(error, { discovery = false } = {}) {
	health.lastErrorAt = new Date().toISOString();
	health.lastErrorStatus = error?.response?.status ?? null;
	health.lastErrorMessage = error?.message || String(error);
	if (!discovery) return;
	health.consecutiveDiscoveryFailures++;
	if (health.consecutiveDiscoveryFailures >= DEX_DISCOVERY_CIRCUIT_FAILURES) {
		health.circuitOpenedAt = health.circuitOpenedAt || Date.now();
	}
}

function getMarketDataHealth() {
	return {
		provider: "DexScreener",
		discoveryCircuitOpen: circuitOpen(),
		consecutiveDiscoveryFailures: health.consecutiveDiscoveryFailures,
		circuitCooldownSeconds: Math.round(DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS / 1000),
		lastSuccessAt: health.lastSuccessAt,
		lastErrorAt: health.lastErrorAt,
		lastErrorStatus: health.lastErrorStatus,
		lastErrorMessage: health.lastErrorMessage
	};
}

function pairToTokenData(pair, tokenAddress) {
	if (!pair || pair.chainId !== "solana" || pair.baseToken?.address !== tokenAddress) {
		return null;
	}

	return {
		name: pair.baseToken?.name,
		symbol: pair.baseToken?.symbol,
		tokenAddress: pair.baseToken?.address,
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
		pairAddress: pair.pairAddress,
		dexId: pair.dexId || null,
		quoteTokenAddress: pair.quoteToken?.address || null,
		quoteTokenSymbol: pair.quoteToken?.symbol || null,
		fdv: pair.fdv ?? null,
		marketCap: pair.marketCap ?? null,
		pairCreatedAt: pair.pairCreatedAt ?? null,
		marketDataSource: "DexScreener"
	};
}

async function getTokenData(tokenAddress, { signal, pairAddress } = {}) {
	const discovery = !pairAddress;
	if (discovery && circuitOpen()) {
		console.log(
			"DEX DISCOVERY CIRCUIT OPEN | Skipping new-token quote | cooldown " +
			Math.round(DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS / 1000) + "s"
		);
		return null;
	}

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
				console.log("PAIR LOCK MISMATCH | " + tokenAddress + " | Pair: " + pairAddress);
				return null;
			}

			recordSuccess();
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

		const data = pairToTokenData(bestPair, tokenAddress);
		if (data) recordSuccess();
		return data;
	} catch (error) {
		recordFailure(error, { discovery });
		const mode = pairAddress ? "pair-locked" : "token";
		console.error("DexScreener " + mode + " error:", error.message);
		return null;
	}
}

module.exports = {
	getTokenData,
	pairToTokenData,
	getMarketDataHealth
};
