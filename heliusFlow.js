const axios = require("axios");

const FLOW_WINDOW_SECONDS = 5 * 60;
const FLOW_CACHE_MS = Math.max(
	60000,
	(Number.parseInt(process.env.HELIUS_FLOW_CACHE_SECONDS || "180", 10) || 180) * 1000
);
const HELIUS_FLOW_MAX_REQUESTS_PER_DAY = Math.max(
	10,
	Math.min(120, Number.parseInt(process.env.HELIUS_FLOW_MAX_REQUESTS_PER_DAY || "100", 10) || 100)
);
const flowCache = new Map();
let flowUsage = {
	day: new Date().toISOString().slice(0, 10),
	requests: 0,
	cacheHits: 0,
	budgetSkips: 0,
	successes: 0,
	failures: 0
};

function refreshFlowUsageDay() {
	const day = new Date().toISOString().slice(0, 10);
	if (flowUsage.day === day) return;
	flowUsage = { day, requests: 0, cacheHits: 0, budgetSkips: 0, successes: 0, failures: 0 };
}

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
	refreshFlowUsageDay();
	const cached = flowCache.get(pairAddress);
	if (cached && now - cached.updatedAt < FLOW_CACHE_MS) {
		flowUsage.cacheHits++;
		return { ...structuredClone(cached.snapshot), cached: true, usage: structuredClone(flowUsage) };
	}
	if (flowUsage.requests >= HELIUS_FLOW_MAX_REQUESTS_PER_DAY) {
		flowUsage.budgetSkips++;
		return {
			status: "FREE_BUDGET_LIMIT",
			source: "Helius Enhanced Transactions",
			pairAddress,
			swapsLast5m: 0,
			uniqueMakers5m: 0,
			uniqueMakerRatio: 0,
			usage: structuredClone(flowUsage)
		};
	}

	try {
		flowUsage.requests++;
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
		flowUsage.successes++;
		flowCache.set(pairAddress, { updatedAt: now, snapshot });
		return { ...snapshot, usage: structuredClone(flowUsage) };
	} catch (error) {
		flowUsage.failures++;
		return {
			status: "UNAVAILABLE",
			source: "Helius Enhanced Transactions",
			pairAddress,
			swapsLast5m: 0,
			uniqueMakers5m: 0,
			uniqueMakerRatio: 0,
			errorStatus: error?.response?.status || null,
			usage: structuredClone(flowUsage)
		};
	}
}

function getHeliusFlowUsage() {
	refreshFlowUsageDay();
	return { ...structuredClone(flowUsage), maxRequestsPerDay: HELIUS_FLOW_MAX_REQUESTS_PER_DAY };
}

module.exports = {
	heliusFlowSnapshot,
	summarizeHeliusTransactions,
	getHeliusFlowUsage
};
