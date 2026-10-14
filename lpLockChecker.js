const API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const MIN_LOCKED_PERCENT = 85;
const SUCCESS_CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 8000;
const { verifyCanonicalMigration } = require("./pumpSwapVerifier");

function createLpLockChecker({ httpGet = (...args) => require("axios").get(...args), verifyPumpSwapMigration = verifyCanonicalMigration, clock = Date.now } = {}) {
	const cache = new Map();
	const pending = new Map();
	async function getLockStatus(tokenAddress, coin = null) {
		if (!tokenAddress) return { allowed: false, lockedPercent: null, reason: "MISSING_TOKEN_ADDRESS" };
		const cacheKey = `${tokenAddress}:${coin?.pairAddress || ""}:${coin?.dexId || ""}`;
		const cached = cache.get(cacheKey);
		if (cached && cached.expiresAt > clock()) return cached.value;
		if (pending.has(cacheKey)) return pending.get(cacheKey);
		const request = (async () => {
			let value;
			try {
				const response = await httpGet(`${API_BASE}/${encodeURIComponent(tokenAddress)}/report/summary`, { timeout: TIMEOUT_MS });
				const raw = response?.data?.lpLockedPct ?? response?.data?.lp_lock_pct;
				const lockedPercent = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
				value = Number.isFinite(lockedPercent)
					? { allowed: lockedPercent >= MIN_LOCKED_PERCENT, lockedPercent, reason: lockedPercent >= MIN_LOCKED_PERCENT ? "LOCKED_LIQUIDITY_CONFIRMED" : "LIQUIDITY_NOT_LOCKED_ENOUGH" }
					: { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" };
			} catch (_) {
				value = { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" };
			}
			if (String(coin?.dexId || "").toLowerCase() === "pumpswap" && await verifyPumpSwapMigration(coin)) {
				value = { allowed: true, lockedPercent: null, reason: "CANONICAL_PUMPSWAP_MIGRATION_VERIFIED", canonicalPumpSwapMigration: true };
			}
			cache.set(cacheKey, { value, expiresAt: clock() + (value.allowed ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS) });
			return value;
		})().finally(() => pending.delete(cacheKey));
		pending.set(cacheKey, request);
		return request;
	}
	return { getLockStatus };
}

const client = createLpLockChecker();
module.exports = { API_BASE, MIN_LOCKED_PERCENT, SUCCESS_CACHE_MS, FAILURE_CACHE_MS, createLpLockChecker, getLockStatus: client.getLockStatus };
