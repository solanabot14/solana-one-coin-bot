const axios = require("axios");
const { getTokenData } = require("./dexscreener");
const { analyzeToken } = require("./strategy");

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
const MIN_ENTRY_VOLUME_LIQUIDITY_5M_PERCENT = Number.parseFloat(process.env.MIN_ENTRY_VOLUME_LIQUIDITY_5M_PERCENT || "1") || 1;
const LATE_ENTRY_1H_PERCENT = Number.parseFloat(process.env.LATE_ENTRY_1H_PERCENT || "20") || 20;
const LATE_ENTRY_MAX_5M_PERCENT = Number.parseFloat(process.env.LATE_ENTRY_MAX_5M_PERCENT || "1.5") || 1.5;
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
		scoreBelow8: 0,
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
		nearEntries: []
	}
};

let lastCandidateCache = {
	updatedAt: null,
	candidates: []
};

const rollingPriceHistory = new Map();

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
			discoveryType: "organic"
		});
		if (tokens.length >= limit) break;
	}
	return tokens;
}

async function fetchBirdeyeTrendingTokens(signal) {
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
		const sinceTrendingRefresh = Date.now() - birdeyeTrendingCache.updatedAt;
		if (birdeyeTrendingCache.updatedAt && sinceTrendingRefresh >= 0 && sinceTrendingRefresh < 1100) {
			await new Promise(resolve => setTimeout(resolve, 1100 - sinceTrendingRefresh));
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


function entryDiagnostics(data, analysis) {
	const change5m = Number(data?.priceChange5m) || 0;
	const change1h = Number(data?.priceChange1h) || 0;
	const change24h = Number(data?.priceChange24h) || 0;
	const buys = Number(data?.buys5m) || 0;
	const sells = Number(data?.sells5m) || 0;
	const totalTransactions = buys + sells;
	const buyRatio = totalTransactions > 0 ? buys / totalTransactions : 0;
	const reasons = Array.isArray(analysis?.reasons) ? analysis.reasons : [];

	const blockers = [];
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 5m"))) blockers.push("ANTI_CHASE_5M");
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 1h"))) blockers.push("ANTI_CHASE_1H");
	if (reasons.some(reason => reason.includes("ANTI-CHASE: 24h"))) blockers.push("ANTI_CHASE_24H");
	if (reasons.some(reason => reason.includes("POST-PUMP GUARD"))) blockers.push("POST_PUMP");
	if (reasons.some(reason => reason.includes("CURRENT ACTIVITY GATE"))) blockers.push("CURRENT_ACTIVITY");
	if (reasons.some(reason => reason.includes("LATE MOMENTUM GUARD"))) blockers.push("LATE_MOMENTUM");

	if (!blockers.length && analysis?.signal !== "STRONG BUY") {
		if (Number(analysis?.score) < 8) blockers.push("SCORE_BELOW_8");
		if (change5m < 0.50 || change5m > 6) blockers.push("5M_CONFIRMATION");
		if (change1h < 0.80 || change1h > 30) blockers.push("1H_CONFIRMATION");
		if (buyRatio < 0.55) blockers.push("BUY_RATIO");
		if (totalTransactions < 20) blockers.push("TRANSACTIONS");
	}

	return {
		blockers,
		change5m,
		change1h,
		change24h,
		buyRatio,
		totalTransactions
	};
}

function buildRejectionTelemetry(candidates = []) {
	const telemetry = {
		notStrongBuy: 0,
		scoreBelow8: 0,
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
		nearEntries: []
	};

	for (const candidate of candidates) {
		if (candidate.signal === "STRONG BUY") continue;
		telemetry.notStrongBuy++;
		const blockers = candidate.entryDiagnostics?.blockers || [];
		if (blockers.includes("SCORE_BELOW_8")) telemetry.scoreBelow8++;
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

		if (Number(candidate.score) >= 6 || candidate.signal === "BUY") {
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
				smartMoney: candidate.smartMoney ? { ...candidate.smartMoney } : null,
				discoverySources: [...(candidate.discoverySources || [])]
			});
		}
	}

	telemetry.nearEntries.sort((a, b) => b.score - a.score);
	telemetry.nearEntries = telemetry.nearEntries.slice(0, 12);
	return telemetry;
}

async function analyzeDiscoveredToken(token, signal) {
	if (signal?.aborted) return null;

	const data = await getTokenData(token.tokenAddress, { signal });
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

	let analysis = analyzeToken(data);
	const liquidity = Number(data.liquidityUsd) || 0;
	const volume5m = Number(data.volume5m) || 0;
	const buys5m = Number(data.buys5m) || 0;
	const sells5m = Number(data.sells5m) || 0;
	const transactions5m = buys5m + sells5m;
	const buyRatio5m = transactions5m > 0 ? buys5m / transactions5m : 0;
	const volumeLiquidity5mPercent = liquidity > 0 ? volume5m / liquidity * 100 : 0;
	const currentActivity = {
		volume5m,
		volume1h: Number(data.volume1h) || 0,
		volumeLiquidity5mPercent,
		transactions5m,
		buyRatio5m
	};
	const postPump = postPumpSnapshot(token.tokenAddress, data.priceUsd);

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

	const activityHealthy =
		volume5m >= MIN_ENTRY_VOLUME_5M_USD ||
		volumeLiquidity5mPercent >= MIN_ENTRY_VOLUME_LIQUIDITY_5M_PERCENT;

	if (analysis.signal === "STRONG BUY" && !activityHealthy) {
		console.log(
			"CURRENT ACTIVITY BLOCK | " + (data.symbol || token.tokenAddress) +
			" | 5m volume: $" + volume5m.toFixed(2) +
			" | 5m vol/liquidity: " + volumeLiquidity5mPercent.toFixed(2) + "%"
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"CURRENT ACTIVITY GATE: 5m volume $" + volume5m.toFixed(2) +
				" and 5m vol/liquidity " + volumeLiquidity5mPercent.toFixed(2) + "% are below entry thresholds"
			]
		};
	}

	const change5m = Number(data.priceChange5m) || 0;
	const change1h = Number(data.priceChange1h) || 0;
	const lateMomentum =
		change1h >= LATE_ENTRY_1H_PERCENT &&
		change5m <= LATE_ENTRY_MAX_5M_PERCENT;

	if (analysis.signal === "STRONG BUY" && lateMomentum) {
		console.log(
			"LATE MOMENTUM BLOCK | " + (data.symbol || token.tokenAddress) +
			" | 1h: " + change1h.toFixed(2) + "% | 5m: " + change5m.toFixed(2) + "%"
		);
		analysis = {
			...analysis,
			signal: "AVOID",
			reasons: [
				...(analysis.reasons || []),
				"LATE MOMENTUM GUARD: 1h " + change1h.toFixed(2) +
				"% with only " + change5m.toFixed(2) + "% in the current 5m window"
			]
		};
	}

	const diagnostics = entryDiagnostics(data, analysis);

	console.log(
		`PASSED FILTERS: ${data.symbol} | Score: ${analysis.score} | ` +
		`Signal: ${analysis.signal} | Sources: ${token.discoverySources.join(", ")}`
	);

	return {
		tokenAddress: token.tokenAddress,
		...data,
		score: analysis.score,
		signal: analysis.signal,
		reasons: analysis.reasons,
		discoverySources: [...token.discoverySources],
		discoveryTypes: [...token.discoveryTypes],
		entryDiagnostics: diagnostics,
		currentActivity,
		postPump,
		smartMoney: null
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

		const analyzed = await mapWithConcurrency(
			solanaTokens,
			TOKEN_LOOKUP_CONCURRENCY,
			token => analyzeDiscoveredToken(token, signal),
			signal
		);

		if (signal?.aborted) return [];

		const candidates = analyzed.filter(Boolean);

		if (candidates.length) {
			await refreshSmartMoney(signal);
			if (signal?.aborted) return [];
			for (const candidate of candidates) {
				candidate.smartMoney = smartMoneyForToken(candidate.tokenAddress);
			}
		}

		candidates.sort((a, b) => b.score - a.score);

		const cacheUpdatedAt = new Date().toISOString();
		lastCandidateCache = {
			updatedAt: cacheUpdatedAt,
			candidates: structuredClone(candidates)
		};

		lastDiscoveryTelemetry = {
			updatedAt: cacheUpdatedAt,
			sources: results.map(result => ({
				name: result.name,
				type: result.type,
				received: result.tokens.length
			})),
			uniqueSolanaCandidates: solanaTokens.length,
			candidatesAfterSafetyFilters: candidates.length,
			strongBuys: candidates.filter(candidate => candidate.signal === "STRONG BUY").length,
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
				minVolume5mUsd: MIN_ENTRY_VOLUME_5M_USD,
				minVolumeLiquidity5mPercent: MIN_ENTRY_VOLUME_LIQUIDITY_5M_PERCENT,
				lateEntry1hPercent: LATE_ENTRY_1H_PERCENT,
				lateEntryMax5mPercent: LATE_ENTRY_MAX_5M_PERCENT,
				currentActivityBlocked: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("CURRENT_ACTIVITY")).length,
				lateMomentumBlocked: candidates.filter(candidate => candidate.entryDiagnostics?.blockers?.includes("LATE_MOMENTUM")).length
			},
			rejectionTelemetry: buildRejectionTelemetry(candidates),
			topCandidates: candidates.slice(0, 12).map(candidate => ({
				symbol: candidate.symbol || "-",
				score: candidate.score,
				signal: candidate.signal,
				discoverySources: [...candidate.discoverySources]
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
	mapWithConcurrency,
	entryDiagnostics,
	buildRejectionTelemetry,
	updateRollingPriceHistory,
	postPumpSnapshot,
	smartMoneyItems,
	normalizeSmartMoneyItem,
	birdeyeTrendingItems,
	birdeyeTrendingToTokens
};
