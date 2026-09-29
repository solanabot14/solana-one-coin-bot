const axios = require("axios");
const { getTokenData, getMarketDataHealth } = require("./dexscreener");
const { analyzeTokenV5 } = require("./strategyV5");
const { heliusFlowSnapshot, getHeliusFlowUsage } = require("./heliusFlow");
const ZERO_EXTRA_CREDIT_MODE = true;

const DISCOVERY_SOURCES = [
	{
		name: "Latest Profiles",
		url: "https://api.dexscreener.com/token-profiles/latest/v1",
		type: "organic"
	},
	{
		name: "Recent Profile Updates",
		url: "https://api.dexscreener.com/token-profiles/recent-updates/v1",
		type: "organic"
	},
	{
		name: "Community Takeovers",
		url: "https://api.dexscreener.com/community-takeovers/latest/v1",
		type: "organic"
	},
	{
		name: "Latest Boosts",
		url: "https://api.dexscreener.com/token-boosts/latest/v1",
		type: "boosted"
	}
];

const TRENDING_META_URL = "https://api.dexscreener.com/metas/trending/v1";
const TRENDING_META_DETAIL_BASE = "https://api.dexscreener.com/metas/meta/v1/";
const TRENDING_META_LIMIT = 3;
const TRENDING_PAIRS_PER_META = 10;
const TRENDING_TOTAL_TOKEN_LIMIT = 8;
const BIRDEYE_TRENDING_URL = "https://public-api.birdeye.so/defi/token_trending";
const BIRDEYE_TRENDING_LIMIT = 20;
const SMART_MONEY_URL = "https://public-api.birdeye.so/smart-money/v1/token/list";
const BIRDEYE_OHLCV_URL = "https://public-api.birdeye.so/defi/v3/ohlcv";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TOKEN_SECURITY_CACHE_MS = Math.max(
	5 * 60 * 1000,
	(Number.parseInt(process.env.TOKEN_SECURITY_CACHE_MINUTES || "30", 10) || 30) * 60 * 1000
);
const RUGCHECK_SUMMARY_BASE_URL = "https://api.rugcheck.xyz/v1/tokens/";
const MIN_LP_LOCKED_PERCENT = Math.min(
	100,
	Math.max(0, Number.parseFloat(process.env.MIN_LP_LOCKED_PERCENT || "90") || 90)
);
const LIQUIDITY_SECURITY_CACHE_MS = Math.max(
	60 * 1000,
	(Number.parseInt(process.env.LIQUIDITY_SECURITY_CACHE_MINUTES || "15", 10) || 15) * 60 * 1000
);

// Narrow, exact-mint exceptions only. Never infer trust from token name/symbol.
// wXMR is a documented bridge asset whose mint/freeze authorities are part of
// the bridge design; all ordinary tokens remain blocked when either authority is active.
const VERIFIED_WRAPPED_ASSETS = new Map([
	[
		"WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp",
		{
			name: "wXMR",
			bridgeProgramId: "EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8",
			source: "wxmr.io / sullystuff/wxmr-frontend"
		}
	]
]);
const SMART_MONEY_LIMIT = 20;
const SMART_MONEY_REFRESH_MS = Math.max(
	60 * 60 * 1000,
	(Number.parseInt(process.env.BIRDEYE_SMART_MONEY_REFRESH_MINUTES || "360", 10) || 360) * 60 * 1000
);
const POST_PUMP_WINDOW_MS = 15 * 60 * 1000;
const POST_PUMP_MIN_HISTORY_MS = 4 * 60 * 1000;
const POST_PUMP_MIN_OBSERVATIONS = 3;
const POST_PUMP_GUARD_PERCENT = Number.parseFloat(process.env.POST_PUMP_GUARD_PERCENT || "6") || 6;
const MIN_ENTRY_VOLUME_5M_USD = Number.parseFloat(process.env.MIN_ENTRY_VOLUME_5M_USD || "5000") || 5000;
const LATE_ENTRY_1H_PERCENT = Number.parseFloat(process.env.LATE_ENTRY_1H_PERCENT || "20") || 20;
const LATE_ENTRY_MAX_5M_PERCENT = Number.parseFloat(process.env.LATE_ENTRY_MAX_5M_PERCENT || "1.5") || 1.5;
const BIRDEYE_OHLCV_CACHE_MS = Math.max(
	60000,
	(Number.parseInt(process.env.BIRDEYE_OHLCV_CACHE_SECONDS || "180", 10) || 180) * 1000
);
const PRE_ENTRY_PUMP_15M_PERCENT = Number.parseFloat(process.env.PRE_ENTRY_PUMP_15M_PERCENT || "8") || 8;
const PRE_ENTRY_PUMP_30M_PERCENT = Number.parseFloat(process.env.PRE_ENTRY_PUMP_30M_PERCENT || "12") || 12;
const PRE_ENTRY_PUMP_MAX_5M_PERCENT = Number.parseFloat(process.env.PRE_ENTRY_PUMP_MAX_5M_PERCENT || "2") || 2;
const PRE_ENTRY_PUMP_MAX_RETRACE_PERCENT = Number.parseFloat(process.env.PRE_ENTRY_PUMP_MAX_RETRACE_PERCENT || "6") || 6;
const FAILED_STRUCTURE_MIN_RUNUP_PERCENT = Number.parseFloat(process.env.FAILED_STRUCTURE_MIN_RUNUP_PERCENT || "8") || 8;
const FAILED_STRUCTURE_MIN_DRAWDOWN_PERCENT = Number.parseFloat(process.env.FAILED_STRUCTURE_MIN_DRAWDOWN_PERCENT || "10") || 10;
const FAILED_STRUCTURE_MIN_REBOUND_PERCENT = Number.parseFloat(process.env.FAILED_STRUCTURE_MIN_REBOUND_PERCENT || "2") || 2;
const FAILED_STRUCTURE_MAX_REBOUND_PERCENT = Number.parseFloat(process.env.FAILED_STRUCTURE_MAX_REBOUND_PERCENT || "8") || 8;
const FAILED_STRUCTURE_MIN_BELOW_HIGH_PERCENT = Number.parseFloat(process.env.FAILED_STRUCTURE_MIN_BELOW_HIGH_PERCENT || "6") || 6;
const BIRDEYE_OHLCV_MAX_REQUESTS_PER_DAY = Math.max(
	10,
	Number.parseInt(process.env.BIRDEYE_OHLCV_MAX_REQUESTS_PER_DAY || "60", 10) || 60
);
const MARKET_DATA_MAX_MCAP_FDV_RATIO = Math.max(
	10,
	Number.parseFloat(process.env.MARKET_DATA_MAX_MCAP_FDV_RATIO || "100") || 100
);
const MARKET_DATA_MAX_LIQUIDITY_FDV_RATIO = Math.max(
	2,
	Number.parseFloat(process.env.MARKET_DATA_MAX_LIQUIDITY_FDV_RATIO || "10") || 10
);
const BIRDEYE_TRENDING_REFRESH_MS = Math.max(
	60 * 60 * 1000,
	(Number.parseInt(process.env.BIRDEYE_TRENDING_REFRESH_MINUTES || "90", 10) || 90) * 60 * 1000
);
const TOKEN_LOOKUP_CONCURRENCY = Math.max(
	1,
	Math.min(12, Number.parseInt(process.env.SCANNER_TOKEN_CONCURRENCY || "8", 10) || 8)
);

let lastDiscoveryTelemetry = {
	updatedAt: null,
	sources: [],
	uniqueSolanaCandidates: 0,
	candidatesAfterSafetyFilters: 0,
	strongBuys: 0,
	topCandidates: [],
	rejectionTelemetry: {
		notStrongBuy: 0,
		scoreBelow65: 0,
		fiveMinute: 0,
		oneHour: 0,
		buyRatio: 0,
		transactions: 0,
		antiChase5m: 0,
		antiChase1h: 0,
		antiChase24h: 0,
		postPump: 0,
		currentActivity: 0,
		lateMomentum: 0,
		marketDataIntegrity: 0,
		preDiscoveryPump: 0,
		postPumpRebound: 0,
		tokenSecurity: 0,
		liquiditySecurity: 0,
		nearEntries: []
	}
};

let lastCandidateCache = {
	updatedAt: null,
	candidates: []
};

const rollingPriceHistory = new Map();
const birdeyeOhlcvCache = new Map();
const tokenSecurityCache = new Map();
const liquiditySecurityCache = new Map();
let birdeyeOhlcvRequestChain = Promise.resolve();
let birdeyeOhlcvLastRequestAt = 0;
let birdeyeOhlcvUsage = {
	day: new Date().toISOString().slice(0, 10),
	requests: 0,
	cacheHits: 0,
	successes: 0,
	failures: 0,
	budgetSkips: 0,
	maxRequestsPerDay: BIRDEYE_OHLCV_MAX_REQUESTS_PER_DAY,
	lastStatus: "NOT_FETCHED",
	lastRequestAt: null
};

function refreshBirdeyeOhlcvUsageDay() {
	const day = new Date().toISOString().slice(0, 10);
	if (birdeyeOhlcvUsage.day === day) return;
	birdeyeOhlcvUsage = {
		day,
		requests: 0,
		cacheHits: 0,
		successes: 0,
		failures: 0,
		budgetSkips: 0,
		maxRequestsPerDay: BIRDEYE_OHLCV_MAX_REQUESTS_PER_DAY,
		lastStatus: "NOT_FETCHED",
		lastRequestAt: null
	};
}

let smartMoneyCache = {
	updatedAt: 0,
	lastStatus: "NOT_FETCHED",
	items: new Map()
};

async function fetchDiscoverySource(source, signal) {
	try {
		const response = await axios.get(source.url, {
			timeout: 10000,
			signal
		});

		const raw = Array.isArray(response.data) ? response.data : [];
		const tokens = raw.map(token => ({
			...token,
			discoverySource: source.name,
			discoveryType: source.type
		}));

		console.log(`${source.name}: ${tokens.length} tokens received`);
		return { name: source.name, type: source.type, tokens };
	} catch (error) {
		console.log(`${source.name} unavailable: ${error.message}`);
		return { name: source.name, type: source.type, tokens: [] };
	}
}


let birdeyeTrendingCache = {
	updatedAt: 0,
	tokens: [],
	lastStatus: "NOT_FETCHED"
};

function birdeyeTrendingItems(payload) {
	const data = payload?.data;
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.tokens)) return data.tokens;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(payload?.tokens)) return payload.tokens;
	if (Array.isArray(payload?.items)) return payload.items;
	return [];
}

function birdeyeTrendingToTokens(items = [], limit = BIRDEYE_TRENDING_LIMIT) {
	const seen = new Set();
	const tokens = [];

	for (const item of Array.isArray(items) ? items : []) {
		const tokenAddress = item?.address || item?.tokenAddress || item?.token_address || item?.mint || item?.baseToken?.address;
		if (!tokenAddress || seen.has(tokenAddress)) continue;
		seen.add(tokenAddress);
		tokens.push({
			chainId: "solana",
			tokenAddress,
			discoverySource: "Birdeye Trending 1H",
			discoveryType: "organic",
			birdeyeRank: Number(item?.rank) || (tokens.length + 1)
		});
		if (tokens.length >= limit) break;
	}
	return tokens;
}

async function fetchBirdeyeTrendingTokens(signal) {
	if (ZERO_EXTRA_CREDIT_MODE) {
		return { name: "Birdeye Trending 1H", type: "organic", tokens: [], disabled: "ZERO_EXTRA_CREDIT_MODE" };
	}
	const now = Date.now();
	const ageMs = now - birdeyeTrendingCache.updatedAt;

	if (birdeyeTrendingCache.updatedAt && ageMs < BIRDEYE_TRENDING_REFRESH_MS) {
		console.log("Birdeye Trending 1H: " + birdeyeTrendingCache.tokens.length + " cached tokens | cache age " + Math.round(ageMs / 60000) + "m | status " + birdeyeTrendingCache.lastStatus);
		return { name: "Birdeye Trending 1H", type: "organic", tokens: structuredClone(birdeyeTrendingCache.tokens) };
	}

	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) {
		birdeyeTrendingCache = { updatedAt: now, tokens: [], lastStatus: "NO_API_KEY" };
		console.log("Birdeye Trending 1H unavailable: BIRDEYE_API_KEY is not configured");
		return { name: "Birdeye Trending 1H", type: "organic", tokens: [] };
	}

	try {
		const response = await axios.get(BIRDEYE_TRENDING_URL, {
			timeout: 10000,
			signal,
			params: { sort_by: "rank", sort_type: "asc", interval: "1h", offset: 0, limit: BIRDEYE_TRENDING_LIMIT },
			headers: { Accept: "application/json", "X-API-KEY": apiKey, "x-chain": "solana" }
		});

		const items = birdeyeTrendingItems(response.data);
		const tokens = birdeyeTrendingToTokens(items);
		birdeyeTrendingCache = { updatedAt: now, tokens: structuredClone(tokens), lastStatus: "OK" };
		console.log("Birdeye Trending 1H: " + tokens.length + " Solana tokens received | refresh " + Math.round(BIRDEYE_TRENDING_REFRESH_MS / 60000) + "m");
		return { name: "Birdeye Trending 1H", type: "organic", tokens };
	} catch (error) {
		const status = error?.response?.status || "ERROR";
		birdeyeTrendingCache = { updatedAt: now, tokens: [], lastStatus: String(status) };
		console.log("Birdeye Trending 1H unavailable: " + error.message + " | next retry in " + Math.round(BIRDEYE_TRENDING_REFRESH_MS / 60000) + "m");
		return { name: "Birdeye Trending 1H", type: "organic", tokens: [] };
	}
}

function birdeyeOhlcvItems(payload) {
	const data = payload?.data;
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(payload?.items)) return payload.items;
	return [];
}

function normalizeBirdeyeCandle(item) {
	const time = Number(item?.unixTime ?? item?.unix_time ?? item?.time);
	const open = Number(item?.o ?? item?.open);
	const high = Number(item?.h ?? item?.high);
	const low = Number(item?.l ?? item?.low);
	const close = Number(item?.c ?? item?.close);
	const volume = Number(item?.v ?? item?.volume);
	if (!Number.isFinite(time) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
	return {
		time,
		open: Number.isFinite(open) ? open : close,
		high,
		low,
		close,
		volume: Number.isFinite(volume) ? volume : 0
	};
}

function failedStructureSnapshot(candles = [], currentPrice, nowSeconds = Math.floor(Date.now() / 1000)) {
	const price = Number(currentPrice);
	const cutoff = nowSeconds - 30 * 60;
	const rows = candles
		.map(normalizeBirdeyeCandle)
		.filter(Boolean)
		.filter(row => row.time >= cutoff && row.time <= nowSeconds + 60)
		.sort((a, b) => a.time - b.time);

	const base = {
		source: "Birdeye OHLCV 1m",
		status: rows.length >= 10 ? "OK" : "INSUFFICIENT_HISTORY",
		candles: rows.length,
		lookbackMinutes: 30,
		peakPrice: null,
		peakTime: null,
		prePeakLow: null,
		postPeakLow: null,
		postPeakLowTime: null,
		runupPercent: null,
		drawdownPercent: null,
		reboundPercent: null,
		belowPeakPercent: null,
		thresholds: {
			minRunupPercent: FAILED_STRUCTURE_MIN_RUNUP_PERCENT,
			minDrawdownPercent: FAILED_STRUCTURE_MIN_DRAWDOWN_PERCENT,
			minReboundPercent: FAILED_STRUCTURE_MIN_REBOUND_PERCENT,
			maxReboundPercent: FAILED_STRUCTURE_MAX_REBOUND_PERCENT,
			minBelowHighPercent: FAILED_STRUCTURE_MIN_BELOW_HIGH_PERCENT
		},
		blocked: false
	};

	if (rows.length < 10 || !(price > 0)) return base;

	let peakIndex = 0;
	for (let i = 1; i < rows.length; i++) {
		if (rows[i].high > rows[peakIndex].high) peakIndex = i;
	}

	// A failed-structure pattern needs real price history both before and after the peak.
	if (peakIndex < 2 || peakIndex >= rows.length - 2) return base;

	const beforePeak = rows.slice(0, peakIndex);
	const afterPeak = rows.slice(peakIndex + 1);
	const peakPrice = rows[peakIndex].high;
	const prePeakLow = Math.min(...beforePeak.map(row => row.low));

	let postPeakLowRow = afterPeak[0];
	for (const row of afterPeak) {
		if (row.low < postPeakLowRow.low) postPeakLowRow = row;
	}

	const postPeakLow = postPeakLowRow.low;
	const runupPercent = prePeakLow > 0 ? (peakPrice - prePeakLow) / prePeakLow * 100 : null;
	const drawdownPercent = peakPrice > 0 ? (peakPrice - postPeakLow) / peakPrice * 100 : null;
	const reboundPercent = postPeakLow > 0 ? (price - postPeakLow) / postPeakLow * 100 : null;
	const belowPeakPercent = peakPrice > 0 ? Math.max(0, (peakPrice - price) / peakPrice * 100) : null;

	const blocked =
		Number(runupPercent) >= FAILED_STRUCTURE_MIN_RUNUP_PERCENT &&
		Number(drawdownPercent) >= FAILED_STRUCTURE_MIN_DRAWDOWN_PERCENT &&
		Number(reboundPercent) >= FAILED_STRUCTURE_MIN_REBOUND_PERCENT &&
		Number(reboundPercent) <= FAILED_STRUCTURE_MAX_REBOUND_PERCENT &&
		Number(belowPeakPercent) >= FAILED_STRUCTURE_MIN_BELOW_HIGH_PERCENT;

	return {
		...base,
		peakPrice,
		peakTime: rows[peakIndex].time,
		prePeakLow,
		postPeakLow,
		postPeakLowTime: postPeakLowRow.time,
		runupPercent,
		drawdownPercent,
		reboundPercent,
		belowPeakPercent,
		blocked
	};
}

function preDiscoveryPumpSnapshot(candles = [], currentPrice, current5mChange, nowSeconds = Math.floor(Date.now() / 1000)) {
	const price = Number(currentPrice);
	const change5m = Number(current5mChange) || 0;
	const valid = candles
		.map(normalizeBirdeyeCandle)
		.filter(Boolean)
		.sort((a, b) => a.time - b.time);

	const windowStats = minutes => {
		const cutoff = nowSeconds - minutes * 60;
		const rows = valid.filter(row => row.time >= cutoff && row.time <= nowSeconds + 60);
		if (!rows.length || !(price > 0)) {
			return { minutes, candles: rows.length, low: null, high: null, extensionPercent: null, retracePercent: null };
		}
		const low = Math.min(...rows.map(row => row.low));
		const high = Math.max(...rows.map(row => row.high));
		return {
			minutes,
			candles: rows.length,
			low,
			high,
			extensionPercent: low > 0 ? (price - low) / low * 100 : null,
			retracePercent: high > 0 ? Math.max(0, (high - price) / high * 100) : null
		};
	};

	const m15 = windowStats(15);
	const m30 = windowStats(30);
	const enoughHistory = m15.candles >= 5 || m30.candles >= 10;
	const extended =
		(Number(m15.extensionPercent) >= PRE_ENTRY_PUMP_15M_PERCENT) ||
		(Number(m30.extensionPercent) >= PRE_ENTRY_PUMP_30M_PERCENT);
	const nearRecentHigh = [m15.retracePercent, m30.retracePercent]
		.filter(Number.isFinite)
		.some(value => value <= PRE_ENTRY_PUMP_MAX_RETRACE_PERCENT);
	const cooled5m = change5m <= PRE_ENTRY_PUMP_MAX_5M_PERCENT;

	return {
		source: "Birdeye OHLCV 1m",
		status: enoughHistory ? "OK" : "INSUFFICIENT_HISTORY",
		currentPrice: price > 0 ? price : null,
		current5mChange: change5m,
		window15m: m15,
		window30m: m30,
		thresholds: {
			extension15mPercent: PRE_ENTRY_PUMP_15M_PERCENT,
			extension30mPercent: PRE_ENTRY_PUMP_30M_PERCENT,
			maxCurrent5mPercent: PRE_ENTRY_PUMP_MAX_5M_PERCENT,
			maxRetracePercent: PRE_ENTRY_PUMP_MAX_RETRACE_PERCENT
		},
		enoughHistory,
		extended,
		nearRecentHigh,
		cooled5m,
		blocked: enoughHistory && extended && nearRecentHigh && cooled5m
	};
}

async function rateLimitedBirdeyeOhlcvRequest(task) {
	const run = birdeyeOhlcvRequestChain.then(async () => {
		const lastBirdeyeRequestAt = Math.max(
			birdeyeOhlcvLastRequestAt,
			Number(birdeyeTrendingCache.updatedAt) || 0,
			Number(smartMoneyCache.updatedAt) || 0
		);
		const waitMs = Math.max(0, 1100 - (Date.now() - lastBirdeyeRequestAt));
		if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
		birdeyeOhlcvLastRequestAt = Date.now();
		return task();
	});
	birdeyeOhlcvRequestChain = run.catch(() => {});
	return run;
}

async function fetchBirdeyeOhlcvCandles(tokenAddress, signal) {
	if (ZERO_EXTRA_CREDIT_MODE) {
		return { status: "DISABLED_ZERO_EXTRA_CREDIT", candles: [], cached: false };
	}
	refreshBirdeyeOhlcvUsageDay();
	const now = Date.now();
	const cached = birdeyeOhlcvCache.get(tokenAddress);
	if (cached && now - cached.updatedAt < BIRDEYE_OHLCV_CACHE_MS) {
		birdeyeOhlcvUsage.cacheHits++;
		return { status: cached.status, candles: structuredClone(cached.candles), cached: true };
	}

	if (birdeyeOhlcvUsage.requests >= BIRDEYE_OHLCV_MAX_REQUESTS_PER_DAY) {
		birdeyeOhlcvUsage.budgetSkips++;
		birdeyeOhlcvUsage.lastStatus = "DAILY_BUDGET_CAP";
		return { status: "DAILY_BUDGET_CAP", candles: [], cached: false };
	}

	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) {
		birdeyeOhlcvUsage.lastStatus = "NO_API_KEY";
		return { status: "NO_API_KEY", candles: [], cached: false };
	}

	try {
		const response = await rateLimitedBirdeyeOhlcvRequest(async () => {
			if (signal?.aborted) return null;
			birdeyeOhlcvUsage.requests++;
			birdeyeOhlcvUsage.lastRequestAt = new Date().toISOString();
			const nowSeconds = Math.floor(Date.now() / 1000);
			return axios.get(BIRDEYE_OHLCV_URL, {
				timeout: 10000,
				signal,
				params: {
					address: tokenAddress,
					type: "1m",
					currency: "usd",
					time_from: nowSeconds - 35 * 60,
					time_to: nowSeconds,
					mode: "range",
					padding: false
				},
				headers: { Accept: "application/json", "X-API-KEY": apiKey, "x-chain": "solana" }
			});
		});
		if (!response || signal?.aborted) return { status: "ABORTED", candles: [], cached: false };

		const candles = birdeyeOhlcvItems(response.data).map(normalizeBirdeyeCandle).filter(Boolean);
		const status = candles.length ? "OK" : "EMPTY";
		birdeyeOhlcvCache.set(tokenAddress, { updatedAt: now, status, candles });
		birdeyeOhlcvUsage.lastStatus = status;
		if (status === "OK") birdeyeOhlcvUsage.successes++;
		else birdeyeOhlcvUsage.failures++;
		return { status, candles: structuredClone(candles), cached: false };
	} catch (error) {
		const status = String(error?.response?.status || "ERROR");
		birdeyeOhlcvUsage.failures++;
		birdeyeOhlcvUsage.lastStatus = status;
		console.log("Birdeye pre-entry OHLCV unavailable: " + error.message);
		birdeyeOhlcvCache.set(tokenAddress, { updatedAt: now, status, candles: [] });
		return { status, candles: [], cached: false };
	}
}

async function preEntryHistoricalPumpCheck(tokenAddress, currentPrice, current5mChange, signal) {
	const fetched = await fetchBirdeyeOhlcvCandles(tokenAddress, signal);
	if (fetched.status !== "OK") {
		return {
			source: "Birdeye OHLCV 1m",
			status: fetched.status,
			cached: fetched.cached,
			blocked: false,
			enoughHistory: false,
			failedStructure: {
				status: fetched.status,
				blocked: false
			}
		};
	}
	const nowSeconds = Math.floor(Date.now() / 1000);
	const snapshot = preDiscoveryPumpSnapshot(
		fetched.candles,
		currentPrice,
		current5mChange,
		nowSeconds
	);
	const failedStructure = failedStructureSnapshot(
		fetched.candles,
		currentPrice,
		nowSeconds
	);
	return { ...snapshot, failedStructure, cached: fetched.cached };
}

function updateRollingPriceHistory(tokenAddress, price, now = Date.now()) {
	price = Number(price);
	if (!tokenAddress || !Number.isFinite(price) || price <= 0) return [];

	const cutoff = now - POST_PUMP_WINDOW_MS;
	const points = (rollingPriceHistory.get(tokenAddress) || [])
		.filter(point => point.time >= cutoff);

	points.push({ time: now, price });
	rollingPriceHistory.set(tokenAddress, points);

	if (rollingPriceHistory.size > 1500) {
		for (const [address, history] of rollingPriceHistory) {
			if (!history.length || history[history.length - 1].time < cutoff) {
				rollingPriceHistory.delete(address);
			}
		}
	}

	return points;
}

function postPumpSnapshot(tokenAddress, price, now = Date.now()) {
	const points = updateRollingPriceHistory(tokenAddress, price, now);
	const spanMs = points.length > 1 ? points[points.length - 1].time - points[0].time : 0;
	const minimum = points.reduce((min, point) => Math.min(min, point.price), Number.POSITIVE_INFINITY);
	const extensionPercent = Number.isFinite(minimum) && minimum > 0
		? (Number(price) - minimum) / minimum * 100
		: 0;
	const enoughHistory =
		points.length >= POST_PUMP_MIN_OBSERVATIONS &&
		spanMs >= POST_PUMP_MIN_HISTORY_MS;

	return {
		windowMinutes: 15,
		observations: points.length,
		historySpanMinutes: spanMs / 60000,
		minObservedPrice: Number.isFinite(minimum) ? minimum : null,
		extensionPercent,
		thresholdPercent: POST_PUMP_GUARD_PERCENT,
		enoughHistory,
		blocked: enoughHistory && extensionPercent >= POST_PUMP_GUARD_PERCENT
	};
}

function smartMoneyItems(payload) {
	const data = payload?.data;
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.tokens)) return data.tokens;
	return [];
}

function normalizeSmartMoneyItem(item) {
	const tokenAddress = item?.token || item?.address || item?.token_address || item?.tokenAddress;
	if (!tokenAddress) return null;
	return {
		tokenAddress,
		netFlow: Number(item?.net_flow) || 0,
		smartTraders: Number(item?.smart_traders_no) || 0,
		buyVolumeUsd: Number(item?.volume_buy_usd) || 0,
		sellVolumeUsd: Number(item?.volume_sell_usd) || 0
	};
}

async function refreshSmartMoney(signal) {
	if (ZERO_EXTRA_CREDIT_MODE) {
		smartMoneyCache = { updatedAt: Date.now(), lastStatus: "DISABLED_ZERO_EXTRA_CREDIT", items: new Map() };
		return smartMoneyCache;
	}
	const now = Date.now();
	if (smartMoneyCache.updatedAt && now - smartMoneyCache.updatedAt < SMART_MONEY_REFRESH_MS) {
		return smartMoneyCache;
	}

	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) {
		smartMoneyCache = { updatedAt: now, lastStatus: "NO_API_KEY", items: new Map() };
		return smartMoneyCache;
	}

	try {
		const lastBirdeyeRequestAt = Math.max(
			Number(birdeyeTrendingCache.updatedAt) || 0,
			Number(birdeyeOhlcvLastRequestAt) || 0
		);
		const sinceLastBirdeyeRequest = Date.now() - lastBirdeyeRequestAt;
		if (lastBirdeyeRequestAt && sinceLastBirdeyeRequest >= 0 && sinceLastBirdeyeRequest < 1100) {
			await new Promise(resolve => setTimeout(resolve, 1100 - sinceLastBirdeyeRequest));
			if (signal?.aborted) return smartMoneyCache;
		}

		const response = await axios.get(SMART_MONEY_URL, {
			timeout: 10000,
			signal,
			params: {
				sort_by: "net_flow",
				trader_style: "all",
				interval: "1d",
				sort_type: "desc",
				offset: 0,
				limit: SMART_MONEY_LIMIT
			},
			headers: { Accept: "application/json", "X-API-KEY": apiKey, "x-chain": "solana" }
		});
		const normalized = smartMoneyItems(response.data).map(normalizeSmartMoneyItem).filter(Boolean);
		smartMoneyCache = {
			updatedAt: now,
			lastStatus: "OK",
			items: new Map(normalized.map(item => [item.tokenAddress, item]))
		};
		console.log("Birdeye Smart Money: " + normalized.length + " tokens cached");
	} catch (error) {
		const status = error?.response?.status || "ERROR";
		smartMoneyCache = { updatedAt: now, lastStatus: String(status), items: new Map() };
		console.log("Birdeye Smart Money unavailable: " + error.message + " | cached retry window " + Math.round(SMART_MONEY_REFRESH_MS / 60000) + "m");
	}

	return smartMoneyCache;
}

function smartMoneyForToken(tokenAddress) {
	return smartMoneyCache.items.get(tokenAddress) || null;
}

async function fetchTrendingMetaTokens(signal) {
	try {
		const response = await axios.get(TRENDING_META_URL, {
			timeout: 10000,
			signal
		});
		const metas = (Array.isArray(response.data) ? response.data : [])
			.filter(meta => meta?.slug)
			.slice(0, TRENDING_META_LIMIT);

		const details = await Promise.all(
			metas.map(meta =>
				axios.get(TRENDING_META_DETAIL_BASE + encodeURIComponent(meta.slug), {
					timeout: 10000,
					signal
				}).then(result => result.data).catch(error => {
					console.log(`Trending meta ${meta.slug} unavailable: ${error.message}`);
					return null;
				})
			)
		);

		const tokens = [];
		const seenTokenAddresses = new Set();
		for (const detail of details) {
			const pairs = Array.isArray(detail?.pairs) ? detail.pairs : [];
			let accepted = 0;
			for (const pair of pairs) {
				if (
					pair?.chainId !== "solana" ||
					!pair?.baseToken?.address ||
					seenTokenAddresses.has(pair.baseToken.address)
				) {
					continue;
				}
				seenTokenAddresses.add(pair.baseToken.address);
				tokens.push({
					chainId: "solana",
					tokenAddress: pair.baseToken.address,
					discoverySource: "Trending Metas",
					discoveryType: "organic"
				});
				accepted++;
				if (
					accepted >= TRENDING_PAIRS_PER_META ||
					tokens.length >= TRENDING_TOTAL_TOKEN_LIMIT
				) break;
			}
			if (tokens.length >= TRENDING_TOTAL_TOKEN_LIMIT) break;
		}

		console.log(`Trending Metas: ${tokens.length} Solana tokens received`);
		return { name: "Trending Metas", type: "organic", tokens };
	} catch (error) {
		console.log(`Trending Metas unavailable: ${error.message}`);
		return { name: "Trending Metas", type: "organic", tokens: [] };
	}
}

function discoveryPriorityForSources(discoverySources = []) {
	const sources = Array.isArray(discoverySources) ? discoverySources : [];
	const hasBirdeye = sources.includes("Birdeye Trending 1H");
	const hasDexScreener = sources.some(source =>
		source === "Latest Profiles" ||
		source === "Recent Profile Updates" ||
		source === "Community Takeovers" ||
		source === "Latest Boosts" ||
		source === "Trending Metas"
	);

	// Lower is better. DexScreener is primary discovery; Birdeye acts as confirmation.
	if (hasDexScreener && hasBirdeye) return 0;
	if (hasDexScreener) return 1;
	if (hasBirdeye) return 2;
	return 3;
}

const DEX_ACTIVITY_TOP_LIMIT = 20;
const DEX_ACTIVITY_SOURCES = new Set([
	"Latest Profiles",
	"Recent Profile Updates",
	"Community Takeovers",
	"Latest Boosts",
	"Trending Metas"
]);

function clamp01(value) {
	return Math.max(0, Math.min(1, Number(value) || 0));
}

function hasDexActivitySource(candidate) {
	return (candidate?.discoverySources || []).some(source => DEX_ACTIVITY_SOURCES.has(source));
}

function hasBirdeyeTrendingSource(candidate) {
	return (candidate?.discoverySources || []).includes("Birdeye Trending 1H");
}

function percentileRank(values = [], target = 0) {
	const sorted = values
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	if (!sorted.length) return 0;
	if (sorted.length === 1) return 0.5;

	let below = 0;
	let equal = 0;
	for (const value of sorted) {
		if (value < target) below++;
		else if (value === target) equal++;
	}
	return clamp01((below + equal * 0.5) / sorted.length);
}

function dexMomentum5mComponent(change5m) {
	const value = Number(change5m) || 0;
	if (value <= 0) return 0;
	if (value < 0.35) return clamp01(0.5 * (value / 0.35));
	if (value <= 3) return 1;
	if (value <= 4) return 0.9;
	if (value <= 6) return clamp01(0.9 - 0.6 * ((value - 4) / 2));
	return 0;
}

function dexMomentum1hComponent(change1h) {
	const value = Number(change1h) || 0;
	if (value <= 0) return 0;
	if (value < 0.8) return clamp01(0.4 * (value / 0.8));
	if (value <= 15) return 1;
	if (value <= 30) return clamp01(1 - 0.6 * ((value - 15) / 15));
	return 0.2;
}

function dexBuyPressureComponent(buyRatio) {
	const value = Number(buyRatio) || 0;
	if (value < 0.45) return 0;
	if (value < 0.55) return clamp01(0.5 * ((value - 0.45) / 0.10));
	if (value <= 0.75) return 1;
	if (value <= 0.90) return clamp01(1 - 0.2 * ((value - 0.75) / 0.15));
	return 0.6;
}

function dexVolumeAccelerationComponent(volume5m, volume1h) {
	const v5 = Math.max(0, Number(volume5m) || 0);
	const v1h = Math.max(0, Number(volume1h) || 0);
	if (!(v1h > 0)) return 0;
	const expected5mAtHourlyPace = v1h / 12;
	if (!(expected5mAtHourlyPace > 0)) return 0;
	const accelerationRatio = v5 / expected5mAtHourlyPace;
	return clamp01(accelerationRatio / 2);
}

function rankDexActivityCandidates(candidates = [], limit = DEX_ACTIVITY_TOP_LIMIT) {
	const dexCandidates = candidates.filter(hasDexActivitySource);
	if (!dexCandidates.length) return [];

	const volumeLogs = dexCandidates.map(candidate => Math.log1p(Math.max(0, Number(candidate.volume5m) || 0)));
	const transactionLogs = dexCandidates.map(candidate => {
		const tx = (Number(candidate.buys5m) || 0) + (Number(candidate.sells5m) || 0);
		return Math.log1p(Math.max(0, tx));
	});

	for (const candidate of dexCandidates) {
		const volume5m = Math.max(0, Number(candidate.volume5m) || 0);
		const volume1h = Math.max(0, Number(candidate.volume1h) || 0);
		const transactions5m = Math.max(0, (Number(candidate.buys5m) || 0) + (Number(candidate.sells5m) || 0));
		const buyRatio5m = transactions5m > 0 ? (Number(candidate.buys5m) || 0) / transactions5m : 0;
		const change5m = Number(candidate.priceChange5m) || 0;
		const change1h = Number(candidate.priceChange1h) || 0;

		const volumePercentile = percentileRank(volumeLogs, Math.log1p(volume5m));
		const transactionsPercentile = percentileRank(transactionLogs, Math.log1p(transactions5m));
		const volumeAcceleration = dexVolumeAccelerationComponent(volume5m, volume1h);
		const momentum5m = dexMomentum5mComponent(change5m);
		const momentum1h = dexMomentum1hComponent(change1h);
		const buyPressure = dexBuyPressureComponent(buyRatio5m);

		let score =
			35 * volumePercentile +
			20 * transactionsPercentile +
			15 * volumeAcceleration +
			15 * momentum5m +
			10 * momentum1h +
			5 * buyPressure;

		if (change5m < 0) score -= 15;
		if (change5m > 6) score -= 20;
		if (change1h < 0) score -= 10;
		if (change1h > 30) score -= 10;

		candidate.dexActivity = {
			score: Math.max(0, Math.min(100, Number(score.toFixed(2)))),
			volumePercentile: Number(volumePercentile.toFixed(4)),
			transactionsPercentile: Number(transactionsPercentile.toFixed(4)),
			volumeAcceleration: Number(volumeAcceleration.toFixed(4)),
			momentum5m: Number(momentum5m.toFixed(4)),
			momentum1h: Number(momentum1h.toFixed(4)),
			buyPressure: Number(buyPressure.toFixed(4)),
			volume5m,
			volume1h,
			transactions5m,
			buyRatio5m
		};
	}

	return [...dexCandidates]
		.sort((a, b) =>
			Number(b.dexActivity?.score || 0) - Number(a.dexActivity?.score || 0) ||
			Number(b.volume5m || 0) - Number(a.volume5m || 0)
		)
		.slice(0, Math.max(1, Number(limit) || DEX_ACTIVITY_TOP_LIMIT));
}

function mergeDiscoveryTokens(sourceResults = []) {
	const uniqueSolanaTokens = new Map();

	for (const result of sourceResults) {
		for (const token of result.tokens || []) {
			if (token?.chainId !== "solana" || !token?.tokenAddress) continue;

			if (!uniqueSolanaTokens.has(token.tokenAddress)) {
				uniqueSolanaTokens.set(token.tokenAddress, {
					...token,
					discoverySources: [token.discoverySource || result.name],
					discoveryTypes: [token.discoveryType || result.type]
				});
				continue;
			}

			const existing = uniqueSolanaTokens.get(token.tokenAddress);
			const source = token.discoverySource || result.name;
			const type = token.discoveryType || result.type;
			if (source && !existing.discoverySources.includes(source)) existing.discoverySources.push(source);
			if (type && !existing.discoveryTypes.includes(type)) existing.discoveryTypes.push(type);
			if (Number.isFinite(Number(token.birdeyeRank))) {
				const rank = Number(token.birdeyeRank);
				existing.birdeyeRank = Number.isFinite(Number(existing.birdeyeRank))
					? Math.min(Number(existing.birdeyeRank), rank)
					: rank;
			}
		}
	}

	return Array.from(uniqueSolanaTokens.values());
}


async function mapWithConcurrency(items, concurrency, worker, signal) {
	const results = new Array(items.length);
	let nextIndex = 0;

	async function runWorker() {
		while (true) {
			if (signal?.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	}

	const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
	await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
	return results;
}



async function tokenSecuritySnapshot(tokenAddress, signal) {
	const now = Date.now();
	const cached = tokenSecurityCache.get(tokenAddress);
	if (cached && now - cached.updatedAt < TOKEN_SECURITY_CACHE_MS) {
		return { ...structuredClone(cached.snapshot), cached: true };
	}

	const base = {
		source: "Solana RPC getAccountInfo",
		status: "NOT_CHECKED",
		tokenAddress,
		mintAuthority: null,
		freezeAuthority: null,
		mintable: null,
		freezable: null,
		blocked: false,
		reasons: [],
		cached: false
	};

	try {
		const response = await axios.post(
			SOLANA_RPC_URL,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "getAccountInfo",
				params: [
					tokenAddress,
					{ encoding: "jsonParsed", commitment: "confirmed" }
				]
			},
			{ timeout: 10000, signal }
		);

		if (response.data?.error) {
			throw new Error(response.data.error.message || "Solana RPC returned an error");
		}

		const account = response.data?.result?.value;
		const parsed = account?.data?.parsed;
		const info = parsed?.info;

		if (!account || !info || parsed?.type !== "mint") {
			const snapshot = {
				...base,
				status: account ? "UNPARSEABLE_MINT" : "ACCOUNT_NOT_FOUND"
			};
			tokenSecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
			return snapshot;
		}

		const mintAuthority = info.mintAuthority ?? null;
		const freezeAuthority = info.freezeAuthority ?? null;
		const mintable = mintAuthority !== null;
		const freezable = freezeAuthority !== null;
		const authorityRisks = [];
		if (mintable) authorityRisks.push("MINT_AUTHORITY_ACTIVE");
		if (freezable) authorityRisks.push("FREEZE_AUTHORITY_ACTIVE");

		const verifiedWrappedAsset = VERIFIED_WRAPPED_ASSETS.get(tokenAddress) || null;
		const wrappedExceptionApplied =
			!!verifiedWrappedAsset &&
			authorityRisks.length > 0;

		const reasons = wrappedExceptionApplied
			? ["VERIFIED_WRAPPED_ASSET_AUTHORITY_EXCEPTION"]
			: [...authorityRisks];

		const snapshot = {
			...base,
			status: wrappedExceptionApplied ? "VERIFIED_WRAPPED_ASSET" : "OK",
			mintAuthority,
			freezeAuthority,
			mintable,
			freezable,
			authorityRisks,
			verifiedWrappedAsset: verifiedWrappedAsset
				? { ...verifiedWrappedAsset }
				: null,
			wrappedExceptionApplied,
			blocked: authorityRisks.length > 0 && !wrappedExceptionApplied,
			reasons
		};
		tokenSecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
		return snapshot;
	} catch (error) {
		console.log(
			"TOKEN SECURITY CHECK UNAVAILABLE | " + tokenAddress + " | " + error.message
		);
		return {
			...base,
			status: String(error?.response?.status || "ERROR")
		};
	}
}

async function liquiditySecuritySnapshot(tokenAddress, signal) {
	const now = Date.now();
	const cached = liquiditySecurityCache.get(tokenAddress);
	if (cached && now - cached.updatedAt < LIQUIDITY_SECURITY_CACHE_MS) {
		return { ...structuredClone(cached.snapshot), cached: true };
	}

	const base = {
		source: "RugCheck token summary",
		status: "NOT_CHECKED",
		tokenAddress,
		lpLockedPct: null,
		requiredLockedPct: MIN_LP_LOCKED_PERCENT,
		blocked: true,
		reasons: [],
		cached: false
	};

	try {
		const url = RUGCHECK_SUMMARY_BASE_URL + encodeURIComponent(tokenAddress) + "/report/summary";
		const response = await axios.get(url, {
			timeout: 10000,
			signal,
			headers: { accept: "application/json" }
		});
		const payload = response.data || {};
		const lpLockedPct = Number(payload.lpLockedPct);
		const mintMatches = !payload.mint || payload.mint === tokenAddress;

		const reasons = [];
		if (!mintMatches) reasons.push("RUGCHECK_TOKEN_ID_MISMATCH");
		if (!Number.isFinite(lpLockedPct)) reasons.push("LP_LOCK_UNVERIFIED");
		else if (lpLockedPct < MIN_LP_LOCKED_PERCENT) {
			reasons.push("LP_BELOW_MINIMUM_LOCK");
		}

		const snapshot = {
			...base,
			status: reasons.length ? "BLOCKED" : "OK",
			lpLockedPct: Number.isFinite(lpLockedPct) ? lpLockedPct : null,
			blocked: reasons.length > 0,
			reasons
		};
		liquiditySecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
		return snapshot;
	} catch (error) {
		const snapshot = {
			...base,
			status: String(error?.response?.status || "ERROR"),
			reasons: ["LP_LOCK_VERIFICATION_UNAVAILABLE"]
		};
		liquiditySecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
		console.log(
			"LIQUIDITY SECURITY CHECK UNAVAILABLE | " + tokenAddress + " | " + error.message
		);
		return snapshot;
	}
}

function marketDataIntegritySnapshot(data, expectedTokenAddress = null) {
	const price = Number(data?.priceUsd);
	const liquidity = Number(data?.liquidityUsd);
	const fdv = Number(data?.fdv);
	const marketCap = Number(data?.marketCap);
	const reasons = [];

	if (!(price > 0)) reasons.push("INVALID_PRICE");
	if (!data?.pairAddress) reasons.push("MISSING_PAIR");
	if (expectedTokenAddress && data?.tokenAddress && data.tokenAddress !== expectedTokenAddress) {
		reasons.push("TOKEN_ID_MISMATCH");
	}

	if (fdv > 0 && marketCap > 0) {
		const ratio = Math.max(fdv / marketCap, marketCap / fdv);
		if (ratio > MARKET_DATA_MAX_MCAP_FDV_RATIO) {
			reasons.push("EXTREME_MCAP_FDV_RATIO");
		}
	}

	const warnings = [];
	if (fdv > 0 && liquidity > 0 && liquidity / fdv > MARKET_DATA_MAX_LIQUIDITY_FDV_RATIO) {
		// DexScreener FDV can be absent/stale/wrong for wrapped or unusual supply models.
		// Treat this ratio as telemetry only; identity, pair presence and extreme MCAP/FDV
		// contradictions remain hard integrity failures.
		warnings.push("LIQUIDITY_FDV_INCONSISTENT");
	}

	return {
		ok: reasons.length === 0,
		reasons,
		warnings,
		source: data?.marketDataSource || "DexScreener",
		dexId: data?.dexId || null,
		pairAddress: data?.pairAddress || null,
		tokenAddress: data?.tokenAddress || expectedTokenAddress || null,
		quoteTokenAddress: data?.quoteTokenAddress || null,
		quoteTokenSymbol: data?.quoteTokenSymbol || null,
		priceUsd: Number.isFinite(price) ? price : null,
		liquidityUsd: Number.isFinite(liquidity) ? liquidity : null,
		fdv: Number.isFinite(fdv) && fdv > 0 ? fdv : null,
		marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null
	};
}

function adaptiveVolumeRequirement(data, analysis, heliusFlow) {
	const fallback = MIN_ENTRY_VOLUME_5M_USD;
	const regime = analysis?.v5?.regime?.name || "UNKNOWN";
	const acceleration = Number(analysis?.v5?.volumeAcceleration) || 0;
	const swaps = Number(heliusFlow?.swapsLast5m) || 0;
	const uniqueMakers = Number(heliusFlow?.uniqueMakers5m) || 0;
	const heliusConfirmed =
		heliusFlow?.status === "OK" &&
		swaps >= 4 &&
		uniqueMakers >= 3;

	if (!heliusConfirmed) {
		return {
			requiredVolume5m: fallback,
			mode: "FIXED_FALLBACK",
			regime,
			acceleration,
			heliusConfirmed: false
		};
	}

	let requiredVolume5m = fallback;
	if (regime === "LAUNCH") {
		requiredVolume5m = acceleration >= 1.25 ? 1500 : 2500;
	} else if (regime === "EARLY") {
		requiredVolume5m = acceleration >= 1.20 ? 2000 : 3000;
	} else if (regime === "EXPANSION") {
		requiredVolume5m = acceleration >= 1.10 ? 3000 : 4000;
	} else if (regime === "ESTABLISHED") {
		requiredVolume5m = acceleration >= 1.00 ? 4000 : fallback;
	}

	return {
		requiredVolume5m,
		mode: requiredVolume5m < fallback ? "ADAPTIVE" : "FIXED_FALLBACK",
		regime,
		acceleration,
		heliusConfirmed: true
	};
}

function entryQualitySnapshot(data, analysis = null, heliusFlow = null) {
	const liquidity = Number(data?.liquidityUsd) || 0;
	const volume5m = Number(data?.volume5m) || 0;
	const buys5m = Number(data?.buys5m) || 0;
	const sells5m = Number(data?.sells5m) || 0;
	const transactions5m = buys5m + sells5m;
	const buyRatio5m = transactions5m > 0 ? buys5m / transactions5m : 0;
	const volumeLiquidity5mPercent = liquidity > 0 ? volume5m / liquidity * 100 : 0;
	const change5m = Number(data?.priceChange5m) || 0;
	const change1h = Number(data?.priceChange1h) || 0;
	const adaptiveVolume = adaptiveVolumeRequirement(data, analysis, heliusFlow);

	return {
		volume5m,
		volume1h: Number(data?.volume1h) || 0,
		volumeLiquidity5mPercent,
		transactions5m,
		buyRatio5m,
		requiredVolume5m: adaptiveVolume.requiredVolume5m,
		volumeGateMode: adaptiveVolume.mode,
		volumeRegime: adaptiveVolume.regime,
		volumeAcceleration: adaptiveVolume.acceleration,
		heliusVolumeConfirmed: adaptiveVolume.heliusConfirmed,
		activityHealthy:
			volume5m >= adaptiveVolume.requiredVolume5m,
		lateMomentum:
			change1h >= LATE_ENTRY_1H_PERCENT &&
			change5m <= LATE_ENTRY_MAX_5M_PERCENT,
		change5m,
		change1h
	};
}

function entryDiagnostics(data, analysis) {
	const change5m = Number(data?.priceChange5m) || 0;
	const change1h = Number(data?.priceChange1h) || 0;
	const change24h = Number(data?.priceChange24h) || 0;
	const buys = Number(data?.buys5m) || 0;
	const sells = Number(data?.sells5m) || 0;
	const totalTransactions = buys + sells;
	const buyRatio = totalTransactions > 0 ? buys / totalTransactions : 0;
	const reasons = Array.isArray(analysis?.reasons) ? analysis.reasons : [];
	const v5 = analysis?.v5 || {};

	const blockers = [];
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 5m"))) blockers.push("ANTI_CHASE_5M");
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 1h"))) blockers.push("ANTI_CHASE_1H");
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 24h"))) blockers.push("ANTI_CHASE_24H");
	if (reasons.some(reason => reason.includes("POST-PUMP GUARD"))) blockers.push("POST_PUMP");
	if (reasons.some(reason => reason.includes("CURRENT ACTIVITY GATE"))) blockers.push("CURRENT_ACTIVITY");
	if (reasons.some(reason => reason.includes("LATE MOMENTUM GUARD"))) blockers.push("LATE_MOMENTUM");
	if (reasons.some(reason => reason.includes("MARKET DATA INTEGRITY"))) blockers.push("MARKET_DATA_INTEGRITY");
	if (reasons.some(reason => reason.includes("PRE-DISCOVERY PUMP"))) blockers.push("PRE_DISCOVERY_PUMP");
	if (reasons.some(reason => reason.includes("POST-PUMP REBOUND"))) blockers.push("POST_PUMP_REBOUND");
	if (reasons.some(reason => reason.includes("TOKEN SECURITY"))) blockers.push("TOKEN_SECURITY");
	if (reasons.some(reason => reason.includes("LIQUIDITY SECURITY"))) blockers.push("LIQUIDITY_SECURITY");

	if (!blockers.length && analysis?.signal !== "STRONG BUY") {
		if (Number(analysis?.score) < 65) blockers.push("SCORE_BELOW_65");
		if (change5m <= 0 || change5m >= 4) blockers.push("5M_CONFIRMATION");
		if (v5.dynamic1hPass === false || change1h > 30) blockers.push("1H_CONFIRMATION");
		if (buyRatio < 0.52) blockers.push("BUY_RATIO");
		if (totalTransactions < Number(v5.minTransactions || 20)) blockers.push("TRANSACTIONS");
	}

	return {
		blockers,
		change5m,
		change1h,
		change24h,
		buyRatio,
		totalTransactions,
		v5: structuredClone(v5)
	};
}

function buildRejectionTelemetry(candidates = []) {
	const telemetry = {
		notStrongBuy: 0,
		scoreBelow65: 0,
		fiveMinute: 0,
		oneHour: 0,
		buyRatio: 0,
		transactions: 0,
		antiChase5m: 0,
		antiChase1h: 0,
		antiChase24h: 0,
		postPump: 0,
		currentActivity: 0,
		lateMomentum: 0,
		marketDataIntegrity: 0,
		preDiscoveryPump: 0,
		postPumpRebound: 0,
		tokenSecurity: 0,
		liquiditySecurity: 0,
		nearEntries: []
	};

	for (const candidate of candidates) {
		if (candidate.signal === "STRONG BUY") continue;
		telemetry.notStrongBuy++;
		const blockers = candidate.entryDiagnostics?.blockers || [];
		if (blockers.includes("SCORE_BELOW_65")) telemetry.scoreBelow65++;
		if (blockers.includes("5M_CONFIRMATION")) telemetry.fiveMinute++;
		if (blockers.includes("1H_CONFIRMATION")) telemetry.oneHour++;
		if (blockers.includes("BUY_RATIO")) telemetry.buyRatio++;
		if (blockers.includes("TRANSACTIONS")) telemetry.transactions++;
		if (blockers.includes("ANTI_CHASE_5M")) telemetry.antiChase5m++;
		if (blockers.includes("ANTI_CHASE_1H")) telemetry.antiChase1h++;
		if (blockers.includes("ANTI_CHASE_24H")) telemetry.antiChase24h++;
		if (blockers.includes("POST_PUMP")) telemetry.postPump++;
		if (blockers.includes("CURRENT_ACTIVITY")) telemetry.currentActivity++;
		if (blockers.includes("LATE_MOMENTUM")) telemetry.lateMomentum++;
		if (blockers.includes("MARKET_DATA_INTEGRITY")) telemetry.marketDataIntegrity++;
		if (blockers.includes("PRE_DISCOVERY_PUMP")) telemetry.preDiscoveryPump++;
		if (blockers.includes("POST_PUMP_REBOUND")) telemetry.postPumpRebound++;
		if (blockers.includes("TOKEN_SECURITY")) telemetry.tokenSecurity++;
		if (blockers.includes("LIQUIDITY_SECURITY")) telemetry.liquiditySecurity++;

		if (Number(candidate.score) >= 58 || candidate.signal === "BUY") {
			telemetry.nearEntries.push({
				symbol: candidate.symbol || "-",
				score: Number(candidate.score) || 0,
				signal: candidate.signal || "-",
				blockers: [...blockers],
				priceChange5m: candidate.entryDiagnostics?.change5m ?? null,
				priceChange1h: candidate.entryDiagnostics?.change1h ?? null,
				buyRatio: candidate.entryDiagnostics?.buyRatio ?? null,
				transactions5m: candidate.entryDiagnostics?.totalTransactions ?? null,
				volume5m: Number(candidate.volume5m) || 0,
				volumeLiquidity5mPercent: Number(candidate.currentActivity?.volumeLiquidity5mPercent) || 0,
				postPumpExtensionPercent: Number(candidate.postPump?.extensionPercent) || 0,
				postPumpObservations: Number(candidate.postPump?.observations) || 0,
				preDiscoveryPump: candidate.preDiscoveryPump ? structuredClone(candidate.preDiscoveryPump) : null,
				tokenSecurity: candidate.tokenSecurity ? structuredClone(candidate.tokenSecurity) : null,
				smartMoney: candidate.smartMoney ? { ...candidate.smartMoney } : null,
				discoverySources: [...(candidate.discoverySources || [])]
			});
		}
	}

	telemetry.nearEntries.sort((a, b) => b.score - a.score);
	telemetry.nearEntries = telemetry.nearEntries.slice(0, 12);
	return telemetry;
}

async function analyzeDiscoveredToken(token, signal, prefetchedData = null) {
	if (signal?.aborted) return null;

	const data = prefetchedData || await getTokenData(token.tokenAddress, { signal });
	if (!data || signal?.aborted) return null;

	console.log(
		`CHECK ${data.symbol} | Liquidity: ${data.liquidityUsd || 0} | ` +
		`Volume24h: ${data.volume24h || 0} | Sources: ${token.discoverySources.join(", ")}`
	);

	if (
		(data.liquidityUsd || 0) < 50000 ||
		(data.volume24h || 0) < 100000
	) {
		return null;
	}

	let analysis = analyzeTokenV5(data);
	let heliusFlow = {
		status: "NOT_CHECKED",
		source: "Helius free-tier enrichment",
		pairAddress: data.pairAddress || null,
		swapsLast5m: 0,
		uniqueMakers5m: 0,
		uniqueMakerRatio: 0
	};
	if (Number(analysis.score) >= 58 && analysis.signal !== "AVOID") {
		heliusFlow = await heliusFlowSnapshot(token.tokenAddress || data.tokenAddress, { pairAddress: data.pairAddress, signal });
		analysis = analyzeTokenV5(data, { heliusFlow });
		if (heliusFlow.status === "OK") {
			console.log(
				"V5.4 HELIUS FLOW | " + (data.symbol || token.tokenAddress) +
				" | swaps5m: " + heliusFlow.swapsLast5m +
				" | unique makers: " + heliusFlow.uniqueMakers5m +
				" | samples5m: " + Number(heliusFlow.sampleTransactions || 0) +
				" | queried: " + (heliusFlow.fallbackUsed ? "PAIR_FALLBACK" : "TOKEN_MINT") +
				" | daily requests: " + Number(heliusFlow.usage?.requests || 0)
			);
		} else {
			console.log(
				"V5.4 HELIUS STATUS | " + (data.symbol || token.tokenAddress) +
				" | status: " + heliusFlow.status +
				" | http: " + (heliusFlow.errorStatus || "-") +
				" | daily requests: " + Number(heliusFlow.usage?.requests || 0)
			);
		}
	}
	const quality = entryQualitySnapshot(data, analysis, heliusFlow);
	const currentActivity = {
		volume5m: quality.volume5m,
		volume1h: quality.volume1h,
		volumeLiquidity5mPercent: quality.volumeLiquidity5mPercent,
		transactions5m: quality.transactions5m,
		buyRatio5m: quality.buyRatio5m,
		requiredVolume5m: quality.requiredVolume5m,
		volumeGateMode: quality.volumeGateMode,
		volumeRegime: quality.volumeRegime,
		volumeAcceleration: quality.volumeAcceleration,
		heliusVolumeConfirmed: quality.heliusVolumeConfirmed
	};
	const postPump = postPumpSnapshot(token.tokenAddress, data.priceUsd);
	const marketDataIntegrity = marketDataIntegritySnapshot(data, token.tokenAddress);

	if (analysis.signal === "STRONG BUY" && postPump.blocked) {
		console.log(
			"POST-PUMP BLOCK | " + (data.symbol || token.tokenAddress) +
			" | 15m observed extension: " + postPump.extensionPercent.toFixed(2) +
			"% | observations: " + postPump.observations
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"POST-PUMP GUARD: " + postPump.extensionPercent.toFixed(2) + "% above rolling 15m observed low"
			]
		};
	}

	if (analysis.signal === "STRONG BUY" && !quality.activityHealthy) {
		console.log(
			"CURRENT ACTIVITY BLOCK | " + (data.symbol || token.tokenAddress) +
			" | 5m volume: $" + quality.volume5m.toFixed(2) +
			" | required: $" + quality.requiredVolume5m.toFixed(0) +
			" | mode: " + quality.volumeGateMode +
			" | regime: " + quality.volumeRegime
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"CURRENT ACTIVITY GATE: requires adaptive 5m volume >= $" + quality.requiredVolume5m.toFixed(0) +
				"; observed $" + quality.volume5m.toFixed(2) +
				"; mode " + quality.volumeGateMode +
				"; regime " + quality.volumeRegime
			]
		};
	}

	if (analysis.signal === "STRONG BUY" && quality.lateMomentum) {
		console.log(
			"LATE MOMENTUM BLOCK | " + (data.symbol || token.tokenAddress) +
			" | 1h: " + quality.change1h.toFixed(2) + "% | 5m: " + quality.change5m.toFixed(2) + "%"
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"LATE MOMENTUM GUARD: 1h " + quality.change1h.toFixed(2) +
				"% with only " + quality.change5m.toFixed(2) + "% in the current 5m window"
			]
		};
	}

	if (analysis.signal === "STRONG BUY" && !marketDataIntegrity.ok) {
		console.log(
			"MARKET DATA INTEGRITY BLOCK | " + (data.symbol || token.tokenAddress) +
			" | " + marketDataIntegrity.reasons.join(", ") +
			" | Pair: " + (marketDataIntegrity.pairAddress || "missing")
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"MARKET DATA INTEGRITY: " + marketDataIntegrity.reasons.join(", ")
			]
		};
	}

	let preDiscoveryPump = {
		source: "Birdeye OHLCV 1m",
		status: "NOT_CHECKED",
		blocked: false,
		enoughHistory: false
	};

	if (analysis.signal === "STRONG BUY") {
		preDiscoveryPump = await preEntryHistoricalPumpCheck(
			token.tokenAddress,
			data.priceUsd,
			data.priceChange5m,
			signal
		);

		if (preDiscoveryPump.blocked) {
			const extension15 = Number(preDiscoveryPump.window15m?.extensionPercent);
			const extension30 = Number(preDiscoveryPump.window30m?.extensionPercent);
			console.log(
				"PRE-DISCOVERY PUMP BLOCK | " + (data.symbol || token.tokenAddress) +
				" | 15m: " + (Number.isFinite(extension15) ? extension15.toFixed(2) : "—") +
				"% | 30m: " + (Number.isFinite(extension30) ? extension30.toFixed(2) : "—") +
				"% | current 5m: " + (Number(data.priceChange5m) || 0).toFixed(2) + "%"
			);
			analysis = {
				...analysis,
				signal: "AVOID",
				reasons: [
					...(analysis.reasons || []),
					"PRE-DISCOVERY PUMP: Birdeye OHLCV shows recent extension before scanner observation"
				]
			};
		} else if (preDiscoveryPump.failedStructure?.blocked) {
			const failed = preDiscoveryPump.failedStructure;
			console.log(
				"POST-PUMP REBOUND BLOCK | " + (data.symbol || token.tokenAddress) +
				" | run-up: " + Number(failed.runupPercent).toFixed(2) +
				"% | drawdown: " + Number(failed.drawdownPercent).toFixed(2) +
				"% | rebound: " + Number(failed.reboundPercent).toFixed(2) +
				"% | below peak: " + Number(failed.belowPeakPercent).toFixed(2) + "%"
			);
			analysis = {
				...analysis,
				signal: "AVOID",
				reasons: [
					...(analysis.reasons || []),
					"POST-PUMP REBOUND: prior pump failed, sold off, and current move is only a partial rebound"
				]
			};
		}
	}

	let tokenSecurity = {
		source: "Solana RPC getAccountInfo",
		status: "NOT_CHECKED",
		tokenAddress: token.tokenAddress,
		mintAuthority: null,
		freezeAuthority: null,
		mintable: null,
		freezable: null,
		blocked: false,
		reasons: [],
		cached: false
	};

	if (analysis.signal === "STRONG BUY") {
		tokenSecurity = await tokenSecuritySnapshot(token.tokenAddress, signal);
		if (tokenSecurity.wrappedExceptionApplied) {
			console.log(
				"TOKEN SECURITY VERIFIED WRAPPED ASSET | " + (data.symbol || token.tokenAddress) +
				" | " + tokenSecurity.verifiedWrappedAsset?.name +
				" | Bridge: " + tokenSecurity.verifiedWrappedAsset?.bridgeProgramId +
				" | Authority flags recorded but not treated as creator-token risk"
			);
		}
		if (tokenSecurity.blocked) {
			console.log(
				"TOKEN SECURITY BLOCK | " + (data.symbol || token.tokenAddress) +
				" | " + tokenSecurity.reasons.join(", ")
			);
			analysis = {
				...analysis,
				signal: "AVOID",
				reasons: [
					...(analysis.reasons || []),
					"TOKEN SECURITY: " + tokenSecurity.reasons.join(", ")
				]
			};
		}
	}

	let liquiditySecurity = {
		source: "RugCheck token summary",
		status: "NOT_CHECKED",
		tokenAddress: token.tokenAddress,
		lpLockedPct: null,
		requiredLockedPct: MIN_LP_LOCKED_PERCENT,
		blocked: false,
		reasons: [],
		cached: false
	};

	if (analysis.signal === "STRONG BUY") {
		liquiditySecurity = await liquiditySecuritySnapshot(token.tokenAddress, signal);
		if (liquiditySecurity.blocked) {
			console.log(
				"LIQUIDITY SECURITY BLOCK | " + (data.symbol || token.tokenAddress) +
				" | Locked: " + (
					Number.isFinite(Number(liquiditySecurity.lpLockedPct))
						? Number(liquiditySecurity.lpLockedPct).toFixed(4) + "%"
						: "UNVERIFIED"
				) +
				" | Required: " + MIN_LP_LOCKED_PERCENT.toFixed(2) + "%" +
				" | " + liquiditySecurity.reasons.join(", ")
			);
			analysis = {
				...analysis,
				signal: "AVOID",
				reasons: [
					...(analysis.reasons || []),
					"LIQUIDITY SECURITY: " + liquiditySecurity.reasons.join(", ")
				]
			};
		}
	}

	const diagnostics = entryDiagnostics(data, analysis);

	console.log(
		`PASSED FILTERS: ${data.symbol} | Score: ${analysis.score} | ` +
		`Signal: ${analysis.signal} | Sources: ${token.discoverySources.join(", ")}`
	);

	if (Number(analysis.score) >= 58 && analysis.signal !== "STRONG BUY") {
		console.log(
			"NEAR ENTRY BLOCKERS | " + (data.symbol || token.tokenAddress) +
			" | Score: " + Number(analysis.score || 0) +
			" | Blockers: " + (diagnostics.blockers.length ? diagnostics.blockers.join(",") : "NONE") +
			" | 5m: " + Number(diagnostics.change5m || 0).toFixed(2) + "%" +
			" | 1h: " + Number(diagnostics.change1h || 0).toFixed(2) + "%" +
			" | Buy ratio: " + (Number(diagnostics.buyRatio || 0) * 100).toFixed(1) + "%" +
			" | Tx5m: " + Number(diagnostics.totalTransactions || 0) +
			" | Volume5m: $" + Number(quality.volume5m || 0).toFixed(2)
		);
	}

	return {
		tokenAddress: token.tokenAddress,
		...data,
		score: analysis.score,
		signal: analysis.signal,
		reasons: analysis.reasons,
		discoverySources: [...token.discoverySources],
		discoveryTypes: [...token.discoveryTypes],
		discoveryPriority: discoveryPriorityForSources(token.discoverySources),
		entryDiagnostics: diagnostics,
		currentActivity,
		postPump,
		preDiscoveryPump,
		tokenSecurity,
		liquiditySecurity,
		marketDataIntegrity,
		heliusFlow,
		v5Strategy: analysis.v5 ? structuredClone(analysis.v5) : null,
		smartMoney: null,
		birdeyeRank: Number.isFinite(Number(token.birdeyeRank)) ? Number(token.birdeyeRank) : null
	};
}

async function discoverCandidates({ signal } = {}) {
	const scanStartedAt = Date.now();
	console.log(
		`\nScanning Solana for active tokens... | Token concurrency: ${TOKEN_LOOKUP_CONCURRENCY}`
	);

	try {
		const results = await Promise.all([
			...DISCOVERY_SOURCES.map(source => fetchDiscoverySource(source, signal)),
			fetchBirdeyeTrendingTokens(signal),
			fetchTrendingMetaTokens(signal)
		]);

		const solanaTokens = mergeDiscoveryTokens(results);

		console.log(`Unique Solana candidates: ${solanaTokens.length}`);

		const rawSnapshots = await mapWithConcurrency(
			solanaTokens,
			TOKEN_LOOKUP_CONCURRENCY,
			async token => {
				const data = await getTokenData(token.tokenAddress, { signal });
				if (!data || signal?.aborted) return null;
				return {
					token,
					tokenAddress: token.tokenAddress,
					...data,
					discoverySources: [...token.discoverySources],
					discoveryTypes: [...token.discoveryTypes],
					birdeyeRank: Number.isFinite(Number(token.birdeyeRank)) ? Number(token.birdeyeRank) : null
				};
			},
			signal
		);

		if (signal?.aborted) return [];

		const rawCandidates = rawSnapshots.filter(Boolean);
		const rawDexCandidates = rawCandidates.filter(hasDexActivitySource);
		const dexActivityTopRaw = rankDexActivityCandidates(rawDexCandidates, DEX_ACTIVITY_TOP_LIMIT);
		const birdeyeRaw = rawCandidates.filter(hasBirdeyeTrendingSource);

		const selectedRawByToken = new Map();
		for (const candidate of birdeyeRaw) selectedRawByToken.set(candidate.tokenAddress, candidate);
		for (const candidate of dexActivityTopRaw) selectedRawByToken.set(candidate.tokenAddress, candidate);
		const selectedRawCandidates = Array.from(selectedRawByToken.values());

		console.log(
			"DEX ACTIVITY TOP 20 | Raw Dex candidates: " + rawDexCandidates.length +
			" | Selected before safety: " + dexActivityTopRaw.length +
			" | Birdeye raw: " + birdeyeRaw.length +
			" | Pre-safety union: " + selectedRawCandidates.length
		);
		if (dexActivityTopRaw.length) {
			console.log(
				"DEX ACTIVITY LEADERS | " +
				dexActivityTopRaw.slice(0, 5).map(candidate =>
					(candidate.symbol || "-") + ":" + Number(candidate.dexActivity?.score || 0).toFixed(1)
				).join(" | ")
			);
		}

		const analyzedSelected = await mapWithConcurrency(
			selectedRawCandidates,
			TOKEN_LOOKUP_CONCURRENCY,
			raw => analyzeDiscoveredToken(raw.token, signal, raw),
			signal
		);

		if (signal?.aborted) return [];

		const candidates = analyzedSelected.filter(Boolean);
		const safetyCandidates = candidates;
		const dexActivityTop = candidates
			.filter(candidate => dexActivityTopRaw.some(raw => raw.tokenAddress === candidate.tokenAddress));
		const birdeyeTrendingCandidates = candidates.filter(hasBirdeyeTrendingSource);

		console.log(
			"DEX ACTIVITY POST-SAFETY | Dex survivors: " + dexActivityTop.length +
			" | Birdeye survivors: " + birdeyeTrendingCandidates.length +
			" | Final union: " + candidates.length
		);

		if (candidates.length) {
			await refreshSmartMoney(signal);
			if (signal?.aborted) return [];
			for (const candidate of candidates) {
				candidate.smartMoney = smartMoneyForToken(candidate.tokenAddress);
			}
		}

		candidates.sort((a, b) =>
			Number(b.score || 0) - Number(a.score || 0) ||
			Number(a.discoveryPriority ?? 3) - Number(b.discoveryPriority ?? 3)
		);

		const cacheUpdatedAt = new Date().toISOString();
		lastCandidateCache = {
			updatedAt: cacheUpdatedAt,
			candidates: structuredClone(candidates)
		};

		lastDiscoveryTelemetry = {
			zeroExtraCreditMode: ZERO_EXTRA_CREDIT_MODE,
			heliusFreeTierMode: true,
			heliusFlowUsage: getHeliusFlowUsage(),
			updatedAt: cacheUpdatedAt,
			sources: results.map(result => ({
				name: result.name,
				type: result.type,
				received: result.tokens.length
			})),
			uniqueSolanaCandidates: solanaTokens.length,
			candidatesAfterSafetyFilters: candidates.length,
			selectedCandidates: candidates.length,
			strongBuys: candidates.filter(candidate => candidate.signal === "STRONG BUY").length,
			dexActivity: {
				topLimit: DEX_ACTIVITY_TOP_LIMIT,
				rawDexCandidates: rawDexCandidates.length,
				selectedDexCandidatesBeforeSafety: dexActivityTopRaw.length,
				selectedDexCandidatesAfterSafety: dexActivityTop.length,
				birdeyeCandidatesRaw: birdeyeRaw.length,
				birdeyeCandidatesRetained: birdeyeTrendingCandidates.length,
				preSafetyUnionCandidates: selectedRawCandidates.length,
				unionCandidates: candidates.length,
				leaders: dexActivityTopRaw.slice(0, 20).map(candidate => ({
					symbol: candidate.symbol || "-",
					score: Number(candidate.dexActivity?.score || 0),
					volume5m: Number(candidate.volume5m) || 0,
					volume1h: Number(candidate.volume1h) || 0,
					transactions5m: (Number(candidate.buys5m) || 0) + (Number(candidate.sells5m) || 0),
					change5m: Number(candidate.priceChange5m) || 0,
					change1h: Number(candidate.priceChange1h) || 0,
					discoverySources: [...(candidate.discoverySources || [])]
				}))
			},
			scanDurationMs: Date.now() - scanStartedAt,
			tokenLookupConcurrency: TOKEN_LOOKUP_CONCURRENCY,
			smartMoney: {
				status: smartMoneyCache.lastStatus,
				updatedAt: smartMoneyCache.updatedAt ? new Date(smartMoneyCache.updatedAt).toISOString() : null,
				matchedCandidates: candidates.filter(candidate => candidate.smartMoney).length,
				cacheSize: smartMoneyCache.items.size
			},
			postPumpGuard: {
				thresholdPercent: POST_PUMP_GUARD_PERCENT,
				windowMinutes: 15,
				blockedCandidates: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("POST_PUMP")).length
			},
			entryQualityGates: {
				activityRule: "ABSOLUTE_5M_VOLUME_ONLY",
				minVolume5mUsd: MIN_ENTRY_VOLUME_5M_USD,
				lateEntry1hPercent: LATE_ENTRY_1H_PERCENT,
				lateEntryMax5mPercent: LATE_ENTRY_MAX_5M_PERCENT,
				currentActivityBlocked: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("CURRENT_ACTIVITY")).length,
				lateMomentumBlocked: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("LATE_MOMENTUM")).length
			},
			preDiscoveryPumpGuard: {
				source: "Birdeye OHLCV 1m",
				extension15mPercent: PRE_ENTRY_PUMP_15M_PERCENT,
				extension30mPercent: PRE_ENTRY_PUMP_30M_PERCENT,
				maxCurrent5mPercent: PRE_ENTRY_PUMP_MAX_5M_PERCENT,
				maxRetracePercent: PRE_ENTRY_PUMP_MAX_RETRACE_PERCENT,
				blockedCandidates: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("PRE_DISCOVERY_PUMP")).length,
				postPumpReboundBlocked: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("POST_PUMP_REBOUND")).length,
				failedStructureThresholds: {
					minRunupPercent: FAILED_STRUCTURE_MIN_RUNUP_PERCENT,
					minDrawdownPercent: FAILED_STRUCTURE_MIN_DRAWDOWN_PERCENT,
					minReboundPercent: FAILED_STRUCTURE_MIN_REBOUND_PERCENT,
					maxReboundPercent: FAILED_STRUCTURE_MAX_REBOUND_PERCENT,
					minBelowHighPercent: FAILED_STRUCTURE_MIN_BELOW_HIGH_PERCENT
				},
				usage: { ...birdeyeOhlcvUsage }
			},
			tokenSecurityGate: {
				source: "Solana RPC getAccountInfo",
				cacheMinutes: Math.round(TOKEN_SECURITY_CACHE_MS / 60000),
				blockedCandidates: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("TOKEN_SECURITY")).length,
				verifiedWrappedExceptions: candidates.filter(candidate => candidate.tokenSecurity?.wrappedExceptionApplied).length,
				verifiedWrappedMints: Array.from(VERIFIED_WRAPPED_ASSETS.keys()),
				failMode: "OPEN_ON_RPC_ERROR"
			},
			liquiditySecurityGate: {
				source: "RugCheck token summary",
				requiredLockedPct: MIN_LP_LOCKED_PERCENT,
				cacheMinutes: Math.round(LIQUIDITY_SECURITY_CACHE_MS / 60000),
				blockedCandidates: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("LIQUIDITY_SECURITY")).length,
				failMode: "CLOSED_ON_UNVERIFIED"
			},
			marketDataIntegrityGate: {
				maxMcapFdvRatio: MARKET_DATA_MAX_MCAP_FDV_RATIO,
				maxLiquidityFdvRatio: MARKET_DATA_MAX_LIQUIDITY_FDV_RATIO,
				blockedCandidates: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("MARKET_DATA_INTEGRITY")).length
			},
			marketDataHealth: getMarketDataHealth(),
			rejectionTelemetry: buildRejectionTelemetry(candidates),
			topCandidates: candidates.slice(0, 12).map(candidate => ({
				symbol: candidate.symbol || "-",
				score: candidate.score,
				signal: candidate.signal,
				discoverySources: [...candidate.discoverySources],
				discoveryPriority: Number(candidate.discoveryPriority ?? 3)
			}))
		};

		const durationMs = Date.now() - scanStartedAt;
		console.log(
			`Candidates after safety filters: ${candidates.length} | Scan completed in ${(durationMs / 1000).toFixed(2)}s`
		);
		return candidates;
	} catch (error) {
		console.error("Scanner error:", error.message);
		return [];
	}
}

function getDiscoveryTelemetry() {
	return structuredClone(lastDiscoveryTelemetry);
}

function getCachedCandidates() {
	return structuredClone(lastCandidateCache);
}

module.exports = {
	discoverCandidates,
	getDiscoveryTelemetry,
	getCachedCandidates,
	mergeDiscoveryTokens,
	discoveryPriorityForSources,
	mapWithConcurrency,
	entryDiagnostics,
	buildRejectionTelemetry,
	entryQualitySnapshot,
	adaptiveVolumeRequirement,
	marketDataIntegritySnapshot,
	liquiditySecuritySnapshot,
	tokenSecuritySnapshot,
	preDiscoveryPumpSnapshot,
	failedStructureSnapshot,
	birdeyeOhlcvItems,
	normalizeBirdeyeCandle,
	updateRollingPriceHistory,
	postPumpSnapshot,
	analyzeDiscoveredToken,
	smartMoneyItems,
	normalizeSmartMoneyItem,
	birdeyeTrendingItems,
	birdeyeTrendingToTokens,
	rankDexActivityCandidates,
	dexVolumeAccelerationComponent,
	dexMomentum5mComponent,
	dexMomentum1hComponent,
	dexBuyPressureComponent
};
