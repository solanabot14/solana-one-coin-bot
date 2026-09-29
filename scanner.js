const axios = require("axios");
const { getTokenData } = require("./dexscreener");
const { analyzeToken } = require("./strategy");

const DISCOVERY_SOURCES = [
	{ name: "Latest Profiles", url: "https://api.dexscreener.com/token-profiles/latest/v1" },
	{ name: "Community Takeovers", url: "https://api.dexscreener.com/community-takeovers/latest/v1" },
	{ name: "Latest Boosts", url: "https://api.dexscreener.com/token-boosts/latest/v1" },
	{ name: "Top Boosts", url: "https://api.dexscreener.com/token-boosts/top/v1" }
];

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const RUGCHECK_SUMMARY_BASE_URL = "https://api.rugcheck.xyz/v1/tokens/";
const MIN_LP_LOCKED_PERCENT = Math.min(
	100,
	Math.max(0, Number.parseFloat(process.env.MIN_LP_LOCKED_PERCENT || "90") || 90)
);
const TOKEN_SECURITY_CACHE_MS = 30 * 60 * 1000;
const LIQUIDITY_SECURITY_CACHE_MS = 15 * 60 * 1000;
const MARKET_DATA_MAX_MCAP_FDV_RATIO = 100;

const tokenSecurityCache = new Map();
const liquiditySecurityCache = new Map();
let lastDiscoveryTelemetry = {
	updatedAt: null,
	strategy: "V3.1R",
	uniqueSolanaCandidates: 0,
	candidatesAfterSafetyFilters: 0,
	strongBuys: 0,
	topCandidates: []
};

const VERIFIED_WRAPPED_ASSETS = new Map([
	[
		"WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp",
		{ name: "wXMR" }
	]
]);

async function fetchDiscoverySource(source, signal) {
	try {
		const response = await axios.get(source.url, { timeout: 10000, signal });
		const tokens = Array.isArray(response.data) ? response.data : [];
		console.log(`${source.name}: ${tokens.length} tokens received`);
		return tokens;
	} catch (error) {
		console.log(`${source.name} unavailable: ${error.message}`);
		return [];
	}
}

async function tokenSecuritySnapshot(tokenAddress, signal) {
	const now = Date.now();
	const cached = tokenSecurityCache.get(tokenAddress);
	if (cached && now - cached.updatedAt < TOKEN_SECURITY_CACHE_MS) {
		return structuredClone(cached.snapshot);
	}

	const base = {
		status: "NOT_CHECKED",
		blocked: false,
		reasons: [],
		mintAuthority: null,
		freezeAuthority: null
	};

	try {
		const response = await axios.post(
			SOLANA_RPC_URL,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "getAccountInfo",
				params: [tokenAddress, { encoding: "jsonParsed", commitment: "confirmed" }]
			},
			{ timeout: 10000, signal }
		);

		if (response.data?.error) throw new Error(response.data.error.message || "RPC error");
		const account = response.data?.result?.value;
		const parsed = account?.data?.parsed;
		const info = parsed?.info;

		if (!account || !info || parsed?.type !== "mint") {
			const snapshot = { ...base, status: account ? "UNPARSEABLE_MINT" : "ACCOUNT_NOT_FOUND" };
			tokenSecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
			return snapshot;
		}

		const mintAuthority = info.mintAuthority ?? null;
		const freezeAuthority = info.freezeAuthority ?? null;
		const authorityRisks = [];
		if (mintAuthority !== null) authorityRisks.push("MINT_AUTHORITY_ACTIVE");
		if (freezeAuthority !== null) authorityRisks.push("FREEZE_AUTHORITY_ACTIVE");

		const wrappedException = VERIFIED_WRAPPED_ASSETS.has(tokenAddress) && authorityRisks.length > 0;
		const snapshot = {
			status: wrappedException ? "VERIFIED_WRAPPED_ASSET" : "OK",
			blocked: authorityRisks.length > 0 && !wrappedException,
			reasons: wrappedException ? ["VERIFIED_WRAPPED_ASSET_AUTHORITY_EXCEPTION"] : authorityRisks,
			mintAuthority,
			freezeAuthority
		};
		tokenSecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
		return snapshot;
	} catch (error) {
		// Fail open on RPC availability; do not make V3.1 depend on the public RPC.
		console.log(`TOKEN SECURITY CHECK UNAVAILABLE | ${tokenAddress} | ${error.message}`);
		return { ...base, status: String(error?.response?.status || "ERROR") };
	}
}

async function liquiditySecuritySnapshot(tokenAddress, signal) {
	const now = Date.now();
	const cached = liquiditySecurityCache.get(tokenAddress);
	if (cached && now - cached.updatedAt < LIQUIDITY_SECURITY_CACHE_MS) {
		return structuredClone(cached.snapshot);
	}

	const base = {
		status: "NOT_CHECKED",
		blocked: true,
		reasons: [],
		lpLockedPct: null,
		requiredLockedPct: MIN_LP_LOCKED_PERCENT
	};

	try {
		const response = await axios.get(
			RUGCHECK_SUMMARY_BASE_URL + encodeURIComponent(tokenAddress) + "/report/summary",
			{ timeout: 10000, signal, headers: { accept: "application/json" } }
		);
		const payload = response.data || {};
		const lpLockedPct = Number(payload.lpLockedPct);
		const mintMatches = !payload.mint || payload.mint === tokenAddress;
		const reasons = [];

		if (!mintMatches) reasons.push("RUGCHECK_TOKEN_ID_MISMATCH");
		if (!Number.isFinite(lpLockedPct)) reasons.push("LP_LOCK_UNVERIFIED");
		else if (lpLockedPct < MIN_LP_LOCKED_PERCENT) reasons.push("LP_BELOW_MINIMUM_LOCK");

		const snapshot = {
			...base,
			status: reasons.length ? "BLOCKED" : "OK",
			blocked: reasons.length > 0,
			reasons,
			lpLockedPct: Number.isFinite(lpLockedPct) ? lpLockedPct : null
		};
		liquiditySecurityCache.set(tokenAddress, { updatedAt: now, snapshot });
		return snapshot;
	} catch (error) {
		console.log(`LIQUIDITY SECURITY CHECK UNAVAILABLE | ${tokenAddress} | ${error.message}`);
		return { ...base, status: String(error?.response?.status || "ERROR"), reasons: ["LP_LOCK_VERIFICATION_UNAVAILABLE"] };
	}
}

function marketDataIntegritySnapshot(data, expectedTokenAddress) {
	const price = Number(data?.priceUsd);
	const fdv = Number(data?.fdv);
	const marketCap = Number(data?.marketCap);
	const reasons = [];
	if (!(price > 0)) reasons.push("INVALID_PRICE");
	if (!data?.pairAddress) reasons.push("MISSING_PAIR");
	if (data?.tokenAddress && data.tokenAddress !== expectedTokenAddress) reasons.push("TOKEN_ID_MISMATCH");
	if (fdv > 0 && marketCap > 0) {
		const ratio = Math.max(fdv / marketCap, marketCap / fdv);
		if (ratio > MARKET_DATA_MAX_MCAP_FDV_RATIO) reasons.push("EXTREME_MCAP_FDV_RATIO");
	}
	return { ok: reasons.length === 0, reasons };
}

async function discoverCandidates({ signal } = {}) {
	console.log("\nScanning Solana with V3.1R entry logic...");

	try {
		const results = await Promise.all(
			DISCOVERY_SOURCES.map(source => fetchDiscoverySource(source, signal))
		);
		const allTokens = results.flat();
		const uniqueSolanaTokens = new Map();

		for (const token of allTokens) {
			if (token.chainId !== "solana" || !token.tokenAddress) continue;
			if (!uniqueSolanaTokens.has(token.tokenAddress)) {
				uniqueSolanaTokens.set(token.tokenAddress, token);
			}
		}

		const solanaTokens = Array.from(uniqueSolanaTokens.values());
		console.log(`Unique Solana candidates: ${solanaTokens.length}`);
		lastDiscoveryTelemetry.uniqueSolanaCandidates = solanaTokens.length;
		const candidates = [];

		for (const token of solanaTokens) {
			if (signal?.aborted) return [];
			const data = await getTokenData(token.tokenAddress, { signal });
			if (!data) continue;

			console.log(
				`CHECK ${data.symbol} | Liquidity: $${data.liquidityUsd || 0} | Volume24h: $${data.volume24h || 0}`
			);

			// Preserve the original V3.1 coarse market safety floor.
			if ((data.liquidityUsd || 0) < 50000 || (data.volume24h || 0) < 100000) continue;

			// IMPORTANT: V3.1 strategy logic itself remains untouched.
			const analysis = analyzeToken(data);

			// Run modern safety only on coins V3.1 itself wants to buy.
			if (analysis.signal === "STRONG BUY") {
				const integrity = marketDataIntegritySnapshot(data, token.tokenAddress);
				if (!integrity.ok) {
					console.log(`MARKET DATA INTEGRITY BLOCK | ${data.symbol} | ${integrity.reasons.join(", ")}`);
					continue;
				}

				const tokenSecurity = await tokenSecuritySnapshot(token.tokenAddress, signal);
				if (tokenSecurity.blocked) {
					console.log(`TOKEN SECURITY BLOCK | ${data.symbol} | ${tokenSecurity.reasons.join(", ")}`);
					continue;
				}

				const liquiditySecurity = await liquiditySecuritySnapshot(token.tokenAddress, signal);
				if (liquiditySecurity.blocked) {
					console.log(
						`LIQUIDITY SECURITY BLOCK | ${data.symbol} | ${liquiditySecurity.reasons.join(", ")} | LP locked: ${liquiditySecurity.lpLockedPct ?? "unverified"}`
					);
					continue;
				}
			}

			console.log(
				`PASSED V3.1R: ${data.symbol} | Score: ${analysis.score} | Signal: ${analysis.signal}`
			);

			candidates.push({
				tokenAddress: token.tokenAddress,
				...data,
				score: analysis.score,
				signal: analysis.signal,
				reasons: analysis.reasons
			});
		}

		candidates.sort((a, b) => b.score - a.score);
		console.log(`Candidates after V3.1R filters: ${candidates.length}`);
		lastDiscoveryTelemetry = {
			updatedAt: new Date().toISOString(),
			strategy: "V3.1R",
			uniqueSolanaCandidates: solanaTokens.length,
			candidatesAfterSafetyFilters: candidates.length,
			strongBuys: candidates.filter(candidate => candidate.signal === "STRONG BUY").length,
			topCandidates: candidates.slice(0, 10).map(candidate => ({
				symbol: candidate.symbol,
				tokenAddress: candidate.tokenAddress,
				score: candidate.score,
				signal: candidate.signal
			}))
		};
		return candidates;
	} catch (error) {
		console.error("Scanner error:", error.message);
		return [];
	}
}

module.exports = {
	discoverCandidates,
	tokenSecuritySnapshot,
	liquiditySecuritySnapshot,
	marketDataIntegritySnapshot,
	getDiscoveryTelemetry: () => structuredClone(lastDiscoveryTelemetry)
};
