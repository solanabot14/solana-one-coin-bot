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

function isParsedSwap(tx) {
	return (
		String(tx?.type || "").toUpperCase() === "SWAP" ||
		Boolean(tx?.events?.swap)
	);
}

function summarizeHeliusTransactions(transactions = [], nowSeconds = Math.floor(Date.now() / 1000)) {
	const recent = (Array.isArray(transactions) ? transactions : []).filter(tx =>
		Number(tx?.timestamp) >= nowSeconds - FLOW_WINDOW_SECONDS
	);
	const swaps = recent.filter(isParsedSwap);
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

async function fetchAddressTransactions(address, apiKey, signal) {
	if (flowUsage.requests >= HELIUS_FLOW_MAX_REQUESTS_PER_DAY) {
		flowUsage.budgetSkips++;
		return { status: "FREE_BUDGET_LIMIT", transactions: [] };
	}

	try {
		flowUsage.requests++;
		const url =
			"https://api.helius.xyz/v0/addresses/" + encodeURIComponent(address) +
			"/transactions?api-key=" + encodeURIComponent(apiKey) + "&limit=50";
		const response = await axios.get(url, { timeout: 8000, signal });
		flowUsage.successes++;
		return {
			status: "OK",
			transactions: Array.isArray(response.data) ? response.data : []
		};
	} catch (error) {
		flowUsage.failures++;
		return {
			status: "UNAVAILABLE",
			transactions: [],
			errorStatus: error?.response?.status || null
		};
	}
}

async function heliusFlowSnapshot(tokenAddress, { pairAddress = null, signal } = {}) {
	const primaryAddress = tokenAddress || pairAddress;
	if (!primaryAddress) {
		return { status: "NO_ADDRESS", swapsLast5m: 0, uniqueMakers5m: 0, uniqueMakerRatio: 0 };
	}

	const apiKey = process.env.HELIUS_API_KEY;
	if (!apiKey) {
		return { status: "NO_API_KEY", swapsLast5m: 0, uniqueMakers5m: 0, uniqueMakerRatio: 0 };
	}

	refreshFlowUsageDay();
	const cacheKey = tokenAddress || pairAddress;
	const now = Date.now();
	const cached = flowCache.get(cacheKey);
	if (cached && now - cached.updatedAt < FLOW_CACHE_MS) {
		flowUsage.cacheHits++;
		return { ...structuredClone(cached.snapshot), cached: true, usage: structuredClone(flowUsage) };
	}

	const primary = await fetchAddressTransactions(primaryAddress, apiKey, signal);
	if (primary.status !== "OK") {
		return {
			status: primary.status,
			source: "Helius Enhanced Transactions",
			queriedAddress: primaryAddress,
			tokenAddress: tokenAddress || null,
			pairAddress,
			swapsLast5m: 0,
			uniqueMakers5m: 0,
			uniqueMakerRatio: 0,
			errorStatus: primary.errorStatus || null,
			usage: structuredClone(flowUsage)
		};
	}

	let summary = summarizeHeliusTransactions(primary.transactions);
	let queriedAddress = primaryAddress;
	let fallbackUsed = false;

	// A token mint is the preferred query. Some AMM activity may be indexed more
	// completely against the pool account, so use one bounded fallback only when
	// the mint query has no recent samples at all.
	if (
		tokenAddress &&
		pairAddress &&
		pairAddress !== tokenAddress &&
		summary.sampleTransactions === 0 &&
		flowUsage.requests < HELIUS_FLOW_MAX_REQUESTS_PER_DAY
	) {
		const fallback = await fetchAddressTransactions(pairAddress, apiKey, signal);
		if (fallback.status === "OK") {
			summary = summarizeHeliusTransactions(fallback.transactions);
			queriedAddress = pairAddress;
			fallbackUsed = true;
		}
	}

	const snapshot = {
		...summary,
		source: "Helius Enhanced Transactions",
		tokenAddress: tokenAddress || null,
		pairAddress,
		queriedAddress,
		fallbackUsed,
		cached: false
	};
	flowCache.set(cacheKey, { updatedAt: now, snapshot });
	return { ...snapshot, usage: structuredClone(flowUsage) };
}

function getHeliusFlowUsage() {
	refreshFlowUsageDay();
	return { ...structuredClone(flowUsage), maxRequestsPerDay: HELIUS_FLOW_MAX_REQUESTS_PER_DAY };
}

module.exports = {
	heliusFlowSnapshot,
	summarizeHeliusTransactions,
	isParsedSwap,
	getHeliusFlowUsage
};
