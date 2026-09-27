const axios = require("axios");
const vm = require("node:vm");
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
const TRENDING_TIMEFRAME_SOURCES = [
	{
		name: "Trending 1H",
		url: "https://dexscreener.com/solana/1h?rankBy=trendingScoreH1&order=desc",
		type: "organic",
		limit: 20
	},
	{
		name: "Trending 5M",
		url: "https://dexscreener.com/solana/5m?rankBy=trendingScoreM5&order=desc",
		type: "organic",
		limit: 10
	}
];
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
		nearEntries: []
	}
};

let lastCandidateCache = {
	updatedAt: null,
	candidates: []
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


function extractDexScreenerServerData(html) {
	if (typeof html !== "string" || !html.length) {
		throw new Error("empty DexScreener page");
	}

	const marker = "window.__SERVER_DATA";
	const markerIndex = html.indexOf(marker);
	if (markerIndex < 0) throw new Error("DexScreener server data marker missing");

	const equalsIndex = html.indexOf("=", markerIndex + marker.length);
	const scriptEndIndex = html.indexOf("</script>", equalsIndex + 1);
	if (equalsIndex < 0 || scriptEndIndex < 0) {
		throw new Error("DexScreener server data assignment incomplete");
	}

	let expression = html.slice(equalsIndex + 1, scriptEndIndex).trim();
	expression = expression.replace(/;\s*$/, "").trim();

	if (!expression || expression.length > 5_000_000) {
		throw new Error("DexScreener server data size invalid");
	}

	const sandbox = { data: null, URL, Date };
	const context = vm.createContext(sandbox, {
		codeGeneration: { strings: false, wasm: false }
	});
	vm.runInContext(`data = ${expression}`, context, { timeout: 100 });
	return sandbox.data;
}

function trendingPairsToTokens(pairs = [], source) {
	const limit = Math.max(0, Number(source?.limit) || 0);
	const seen = new Set();
	const tokens = [];

	for (const pair of Array.isArray(pairs) ? pairs : []) {
		const tokenAddress = pair?.baseToken?.address;
		if (pair?.chainId !== "solana" || !tokenAddress || seen.has(tokenAddress)) continue;

		seen.add(tokenAddress);
		tokens.push({
			chainId: "solana",
			tokenAddress,
			discoverySource: source.name,
			discoveryType: source.type
		});

		if (tokens.length >= limit) break;
	}

	return tokens;
}

async function fetchTrendingTimeframeSource(source, signal) {
	try {
		const response = await axios.get(source.url, {
			timeout: 10000,
			signal,
			responseType: "text",
			transformResponse: [data => data],
			headers: {
				Accept: "text/html,application/xhtml+xml",
				"User-Agent": "Mozilla/5.0 (compatible; SolanaOneCoinBot/1.0)"
			}
		});

		const serverData = extractDexScreenerServerData(response.data);
		const pairs = serverData?.route?.data?.dexScreenerData?.pairs || [];
		const tokens = trendingPairsToTokens(pairs, source);

		console.log(`${source.name}: ${tokens.length} Solana tokens received`);
		return { name: source.name, type: source.type, tokens };
	} catch (error) {
		console.log(`${source.name} unavailable: ${error.message}`);
		return { name: source.name, type: source.type, tokens: [] };
	}
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

	const analysis = analyzeToken(data);
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
		entryDiagnostics: diagnostics
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
			...TRENDING_TIMEFRAME_SOURCES.map(source => fetchTrendingTimeframeSource(source, signal)),
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
	extractDexScreenerServerData,
	trendingPairsToTokens
};
