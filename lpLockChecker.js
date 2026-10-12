const API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const MIN_LOCKED_PERCENT = 85;
const SUCCESS_CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 8000;
const REPORT_CACHE_MS = 2 * 60 * 1000;
const reportCache = new Map();

function createLpLockChecker({ httpGet = (...args) => require("axios").get(...args), clock = Date.now, minimumLockedPercent = MIN_LOCKED_PERCENT } = {}) {
	const configuredMinimum = Number(minimumLockedPercent);
	const requiredLockedPercent = Number.isFinite(configuredMinimum) && configuredMinimum >= 0 && configuredMinimum <= 100
		? configuredMinimum
		: MIN_LOCKED_PERCENT;
	const cache = new Map();
	const pending = new Map();
	async function getLockStatus(tokenAddress) {
		if (!tokenAddress) return { allowed: false, lockedPercent: null, reason: "MISSING_TOKEN_ADDRESS" };
		const cached = cache.get(tokenAddress);
		if (cached && cached.expiresAt > clock()) return cached.value;
		if (pending.has(tokenAddress)) return pending.get(tokenAddress);
		const request = (async () => {
			let value;
			try {
				const response = await httpGet(`${API_BASE}/${encodeURIComponent(tokenAddress)}/report/summary`, { timeout: TIMEOUT_MS });
				const raw = response?.data?.lpLockedPct ?? response?.data?.lp_lock_pct;
				const lockedPercent = Number(raw);
				value = Number.isFinite(lockedPercent)
					? { allowed: lockedPercent >= requiredLockedPercent, lockedPercent, reason: lockedPercent >= requiredLockedPercent ? "LOCKED_LIQUIDITY_CONFIRMED" : "LIQUIDITY_NOT_LOCKED_ENOUGH" }
					: { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" };
			} catch (_) {
				value = { allowed: false, lockedPercent: null, reason: "LOCK_STATUS_UNAVAILABLE" };
			}
			cache.set(tokenAddress, { value, expiresAt: clock() + (value.allowed ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS) });
			return value;
		})().finally(() => pending.delete(tokenAddress));
		pending.set(tokenAddress, request);
		return request;
	}
	return { getLockStatus };
}

async function getTokenReport(tokenAddress, { httpGet = (...args) => require("axios").get(...args), clock = Date.now } = {}) {
	if (!tokenAddress) return null;
	const cached = reportCache.get(tokenAddress);
	if (cached && cached.expiresAt > clock()) return cached.value;
	try {
		const response = await httpGet(`${API_BASE}/${encodeURIComponent(tokenAddress)}/report`, { timeout: TIMEOUT_MS });
		const report = response?.data;
		if (!report || typeof report !== "object") return null;
		reportCache.set(tokenAddress, { value: report, expiresAt: clock() + REPORT_CACHE_MS });
		return report;
	} catch (_) {
		return null;
	}
}

const client = createLpLockChecker();
module.exports = { API_BASE, MIN_LOCKED_PERCENT, SUCCESS_CACHE_MS, FAILURE_CACHE_MS, createLpLockChecker, getLockStatus: client.getLockStatus, getTokenReport };
