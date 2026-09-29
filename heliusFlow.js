const axios = require("axios");

const FLOW_WINDOW_SECONDS = 5 * 60;
const FLOW_CACHE_MS = Math.max(
	30000,
	(Number.parseInt(process.env.HELIUS_FLOW_CACHE_SECONDS || "60", 10) || 60) * 1000
);
const flowCache = new Map();

function summarizeHeliusTransactions(transactions = [], nowSeconds = Math.floor(Date.now() / 1000)) {
	const recent = (Array.isArray(transactions) ? transactions : []).filter(tx =>
		Number(tx?.timestamp) >= nowSeconds - FLOW_WINDOW_SECONDS
	);
	const swaps = recent.filter(tx => String(tx?.type || "").toUpperCase() === "SWAP");
	const makers = new Set(
		swaps
			.map(tx => tx?.feePayer)
			.filter(Boolean)
	);
	const swapsLast5m = swaps.length;
	const uniqueMakers5m = makers.size;
	return {
		status: "OK",
		swapsLast5m,
		uniqueMakers5m,
		uniqueMakerRatio: swapsLast5m > 0 ? uniqueMakers5m / swapsLast5m : 0,
		sampleTransactions: recent.length,
		windowSeconds: FLOW_WINDOW_SECONDS
	};
}

async function heliusFlowSnapshot(pairAddress, { signal } = {}) {
	if (!pairAddress) {
		return { status: "NO_PAIR", swapsLast5m: 0, uniqueMakers5m: 0, uniqueMakerRatio: 0 };
	}
	const apiKey = process.env.HELIUS_API_KEY;
	if (!apiKey) {
		return { status: "NO_API_KEY", swapsLast5m: 0, uniqueMakers5m: 0, uniqueMakerRatio: 0 };
	}
	const now = Date.now();
	const cached = flowCache.get(pairAddress);
	if (cached && now - cached.updatedAt < FLOW_CACHE_MS) {
		return { ...structuredClone(cached.snapshot), cached: true };
	}

	try {
		const url =
			"https://api.helius.xyz/v0/addresses/" + encodeURIComponent(pairAddress) +
			"/transactions?api-key=" + encodeURIComponent(apiKey) + "&limit=50";
		const response = await axios.get(url, { timeout: 8000, signal });
		const snapshot = {
			...summarizeHeliusTransactions(response.data),
			source: "Helius Enhanced Transactions",
			pairAddress,
			cached: false
		};
		flowCache.set(pairAddress, { updatedAt: now, snapshot });
		return snapshot;
	} catch (error) {
		return {
			status: "UNAVAILABLE",
			source: "Helius Enhanced Transactions",
			pairAddress,
			swapsLast5m: 0,
			uniqueMakers5m: 0,
			uniqueMakerRatio: 0,
			errorStatus: error?.response?.status || null
		};
	}
}

module.exports = {
	heliusFlowSnapshot,
	summarizeHeliusTransactions
};
