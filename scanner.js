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

let lastDiscoveryTelemetry = {
	updatedAt: null,
	sources: [],
	uniqueSolanaCandidates: 0,
	candidatesAfterSafetyFilters: 0,
	strongBuys: 0,
	topCandidates: []
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
		for (const detail of details) {
			const pairs = Array.isArray(detail?.pairs) ? detail.pairs : [];
			let accepted = 0;
			for (const pair of pairs) {
				if (
					pair?.chainId !== "solana" ||
					!pair?.baseToken?.address
				) {
					continue;
				}
				tokens.push({
					chainId: "solana",
					tokenAddress: pair.baseToken.address,
					discoverySource: "Trending Metas",
					discoveryType: "organic"
				});
				accepted++;
				if (accepted >= TRENDING_PAIRS_PER_META) break;
			}
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

async function discoverCandidates({ signal } = {}) {
	console.log("\nScanning Solana for active tokens...");

	try {
		const results = await Promise.all([
			...DISCOVERY_SOURCES.map(source => fetchDiscoverySource(source, signal)),
			fetchTrendingMetaTokens(signal)
		]);

		const solanaTokens = mergeDiscoveryTokens(results);

		console.log(`Unique Solana candidates: ${solanaTokens.length}`);

		const candidates = [];

		for (const token of solanaTokens) {
			if (signal?.aborted) return [];

			const data = await getTokenData(token.tokenAddress, { signal });
			if (!data) continue;

			console.log(
				`CHECK ${data.symbol} | Liquidity: $${data.liquidityUsd || 0} | ` +
				`Volume24h: $${data.volume24h || 0} | Sources: ${token.discoverySources.join(", ")}`
			);

			if (
				(data.liquidityUsd || 0) < 50000 ||
				(data.volume24h || 0) < 100000
			) {
				continue;
			}

			const analysis = analyzeToken(data);

			console.log(
				`PASSED FILTERS: ${data.symbol} | Score: ${analysis.score} | ` +
				`Signal: ${analysis.signal} | Sources: ${token.discoverySources.join(", ")}`
			);

			candidates.push({
				tokenAddress: token.tokenAddress,
				...data,
				score: analysis.score,
				signal: analysis.signal,
				reasons: analysis.reasons,
				discoverySources: [...token.discoverySources],
				discoveryTypes: [...token.discoveryTypes]
			});
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
			topCandidates: candidates.slice(0, 12).map(candidate => ({
				symbol: candidate.symbol || "-",
				score: candidate.score,
				signal: candidate.signal,
				discoverySources: [...candidate.discoverySources]
			}))
		};

		console.log(`Candidates after safety filters: ${candidates.length}`);
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
	mergeDiscoveryTokens
};
