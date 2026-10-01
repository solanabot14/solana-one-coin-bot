const axios = require("axios");

const DEX_DISCOVERY_CIRCUIT_FAILURES = Math.max(
	2,
	Number.parseInt(process.env.DEX_DISCOVERY_CIRCUIT_FAILURES || "3", 10) || 3
);
const DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS = Math.max(
	30000,
	(Number.parseInt(process.env.DEX_DISCOVERY_CIRCUIT_SECONDS || "60", 10) || 60) * 1000
);

const PAIR_PRICE_SHOCK_PERCENT = Math.max(
	20,
	Number.parseFloat(process.env.PAIR_PRICE_SHOCK_PERCENT || "50") || 50
);
const PAIR_REFERENCE_MAX_DEVIATION_PERCENT = Math.max(
	5,
	Number.parseFloat(process.env.PAIR_REFERENCE_MAX_DEVIATION_PERCENT || "20") || 20
);
const PAIR_REFERENCE_MIN_LIQUIDITY_USD = Math.max(
	1000,
	Number.parseFloat(process.env.PAIR_REFERENCE_MIN_LIQUIDITY_USD || "10000") || 10000
);
const MARKET_DATA_QUARANTINE_MS = Math.max(
	60000,
	(Number.parseInt(process.env.MARKET_DATA_QUARANTINE_MINUTES || "15", 10) || 15) * 60 * 1000
);

const tokenMarketDataQuarantine = new Map();

// Scanner discovery is lower priority than live position monitoring.
// Dashboard reads may reuse recent pair data, but trading monitors always fetch fresh data.
const DISCOVERY_REQUEST_GAP_MS = 300;
const DASHBOARD_PAIR_CACHE_MS = 5000;
let discoveryRequestChain = Promise.resolve();
let lastDiscoveryRequestAt = 0;
let monitorRequestsInFlight = 0;
const dashboardPairCache = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForMonitorPriority(signal) {
	while (monitorRequestsInFlight > 0) {
		if (signal?.aborted) throw new Error("Request aborted");
		await sleep(50);
	}
}

function scheduleDiscoveryRequest(task, signal) {
	const run = async () => {
		await waitForMonitorPriority(signal);
		const waitMs = Math.max(0, DISCOVERY_REQUEST_GAP_MS - (Date.now() - lastDiscoveryRequestAt));
		if (waitMs) await sleep(waitMs);
		await waitForMonitorPriority(signal);
		lastDiscoveryRequestAt = Date.now();
		return task();
	};
	const scheduled = discoveryRequestChain.then(run, run);
	discoveryRequestChain = scheduled.catch(() => {});
	return scheduled;
}

function dashboardCacheKey(tokenAddress, pairAddress) {
	return tokenAddress + "::" + pairAddress;
}

function readDashboardPairCache(tokenAddress, pairAddress) {
	const key = dashboardCacheKey(tokenAddress, pairAddress);
	const cached = dashboardPairCache.get(key);
	if (!cached) return null;
	if (Date.now() - cached.at > DASHBOARD_PAIR_CACHE_MS) {
		dashboardPairCache.delete(key);
		return null;
	}
	return structuredClone(cached.data);
}

function writeDashboardPairCache(tokenAddress, pairAddress, data) {
	if (!data) return;
	dashboardPairCache.set(dashboardCacheKey(tokenAddress, pairAddress), {
		at: Date.now(),
		data: structuredClone(data)
	});
}

function percentDeviation(value, reference) {
	const current = Number(value);
	const baseline = Number(reference);
	if (!(current > 0) || !(baseline > 0)) return Infinity;
	return Math.abs(current - baseline) / baseline * 100;
}

function quarantineToken(tokenAddress, reason) {
	tokenMarketDataQuarantine.set(tokenAddress, {
		until: Date.now() + MARKET_DATA_QUARANTINE_MS,
		reason: String(reason || "MARKET_DATA_ANOMALY")
	});
}

function activeTokenQuarantine(tokenAddress) {
	const entry = tokenMarketDataQuarantine.get(tokenAddress);
	if (!entry) return null;
	if (Date.now() >= entry.until) {
		tokenMarketDataQuarantine.delete(tokenAddress);
		return null;
	}
	return entry;
}

function validReferencePairs(pairs, tokenAddress, excludedPairAddress) {
	return (Array.isArray(pairs) ? pairs : [])
		.filter(pair =>
			pair?.chainId === "solana" &&
			pair?.baseToken?.address === tokenAddress &&
			pair?.pairAddress !== excludedPairAddress &&
			Number(pair?.priceUsd) > 0 &&
			Number(pair?.liquidity?.usd) >= PAIR_REFERENCE_MIN_LIQUIDITY_USD
		)
		.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
}

const health = {
	consecutiveDiscoveryFailures: 0,
	circuitOpenedAt: 0,
	lastSuccessAt: null,
	lastErrorAt: null,
	lastErrorStatus: null,
	lastErrorMessage: null
};

function circuitOpen(now = Date.now()) {
	if (!health.circuitOpenedAt) return false;
	if (now - health.circuitOpenedAt >= DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS) {
		health.circuitOpenedAt = 0;
		health.consecutiveDiscoveryFailures = 0;
		return false;
	}
	return true;
}

function recordSuccess() {
	health.lastSuccessAt = new Date().toISOString();
	health.consecutiveDiscoveryFailures = 0;
	health.circuitOpenedAt = 0;
}

function recordFailure(error, { discovery = false } = {}) {
	health.lastErrorAt = new Date().toISOString();
	health.lastErrorStatus = error?.response?.status ?? null;
	health.lastErrorMessage = error?.message || String(error);
	if (!discovery) return;
	health.consecutiveDiscoveryFailures++;
	if (health.consecutiveDiscoveryFailures >= DEX_DISCOVERY_CIRCUIT_FAILURES) {
		health.circuitOpenedAt = health.circuitOpenedAt || Date.now();
	}
}

function getMarketDataHealth() {
	return {
		provider: "DexScreener",
		discoveryCircuitOpen: circuitOpen(),
		consecutiveDiscoveryFailures: health.consecutiveDiscoveryFailures,
		circuitCooldownSeconds: Math.round(DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS / 1000),
		lastSuccessAt: health.lastSuccessAt,
		lastErrorAt: health.lastErrorAt,
		lastErrorStatus: health.lastErrorStatus,
		lastErrorMessage: health.lastErrorMessage,
		activeMarketDataQuarantines: Array.from(tokenMarketDataQuarantine.values())
			.filter(entry => Date.now() < entry.until).length,
		pairPriceShockPercent: PAIR_PRICE_SHOCK_PERCENT,
		pairReferenceMaxDeviationPercent: PAIR_REFERENCE_MAX_DEVIATION_PERCENT
	};
}

function pairToTokenData(pair, tokenAddress) {
	if (!pair || pair.chainId !== "solana" || pair.baseToken?.address !== tokenAddress) {
		return null;
	}

	return {
		name: pair.baseToken?.name,
		symbol: pair.baseToken?.symbol,
		tokenAddress: pair.baseToken?.address,
		priceUsd: pair.priceUsd,
		liquidityUsd: pair.liquidity?.usd,
		volume5m: pair.volume?.m5,
		volume1h: pair.volume?.h1,
		volume24h: pair.volume?.h24,
		priceChange5m: pair.priceChange?.m5,
		priceChange1h: pair.priceChange?.h1,
		priceChange24h: pair.priceChange?.h24,
		buys5m: pair.txns?.m5?.buys,
		sells5m: pair.txns?.m5?.sells,
		pairAddress: pair.pairAddress,
		dexId: pair.dexId || null,
		quoteTokenAddress: pair.quoteToken?.address || null,
		quoteTokenSymbol: pair.quoteToken?.symbol || null,
		fdv: pair.fdv ?? null,
		marketCap: pair.marketCap ?? null,
		pairCreatedAt: pair.pairCreatedAt ?? null,
		marketDataSource: "DexScreener"
	};
}

async function getTokenData(tokenAddress, { signal, pairAddress, referencePrice, consumer = "trading" } = {}) {
	const discovery = !pairAddress;
	const quarantine = discovery ? activeTokenQuarantine(tokenAddress) : null;
	if (quarantine) {
		console.log(
			"MARKET DATA QUARANTINE | Skipping new entry data | " + tokenAddress +
			" | reason: " + quarantine.reason +
			" | remaining: " + Math.max(1, Math.ceil((quarantine.until - Date.now()) / 1000)) + "s"
		);
		return null;
	}
	if (discovery && circuitOpen()) {
		console.log(
			"DEX DISCOVERY CIRCUIT OPEN | Skipping new-token quote | cooldown " +
			Math.round(DEX_DISCOVERY_CIRCUIT_COOLDOWN_MS / 1000) + "s"
		);
		return null;
	}

	try {
		if (pairAddress) {
			if (consumer === "dashboard") {
				const cached = readDashboardPairCache(tokenAddress, pairAddress);
				if (cached) return cached;
			}

			const url = "https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(pairAddress);
			monitorRequestsInFlight++;
			let response;
			try {
				response = await axios.get(url, { timeout: 10000, signal });
			} finally {
				monitorRequestsInFlight = Math.max(0, monitorRequestsInFlight - 1);
			}
			const pairs = Array.isArray(response.data?.pairs)
				? response.data.pairs
				: response.data?.pair
					? [response.data.pair]
					: [];

			const exactPair = pairs.find(pair =>
				pair?.chainId === "solana" && pair?.pairAddress === pairAddress
			);

			if (!exactPair) {
				console.log("PAIR LOCK UNAVAILABLE | " + tokenAddress + " | Pair: " + pairAddress);
				return null;
			}

			const data = pairToTokenData(exactPair, tokenAddress);
			if (!data) {
				console.log("PAIR LOCK MISMATCH | " + tokenAddress + " | Pair: " + pairAddress);
				return null;
			}

			const expectedPrice = Number(referencePrice);
			const lockedPrice = Number(data.priceUsd);
			const priceShock =
				expectedPrice > 0 &&
				lockedPrice > 0 &&
				percentDeviation(lockedPrice, expectedPrice) >= PAIR_PRICE_SHOCK_PERCENT;

			if (priceShock) {
				console.log(
					"PAIR PRICE SHOCK | " + (data.symbol || tokenAddress) +
					" | locked: $" + lockedPrice +
					" | reference: $" + expectedPrice +
					" | deviation: " + percentDeviation(lockedPrice, expectedPrice).toFixed(2) + "%"
				);

				try {
					const tokenUrl = "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress);
					const tokenResponse = await axios.get(tokenUrl, { timeout: 10000, signal });
					const references = validReferencePairs(tokenResponse.data?.pairs, tokenAddress, pairAddress);
					const referencePair = references[0] || null;
					const referenceData = referencePair ? pairToTokenData(referencePair, tokenAddress) : null;
					const alternatePrice = Number(referenceData?.priceUsd);

					if (referenceData && alternatePrice > 0) {
						const lockedVsAlternate = percentDeviation(lockedPrice, alternatePrice);
						const alternateVsExpected = percentDeviation(alternatePrice, expectedPrice);

						if (
							lockedVsAlternate > PAIR_REFERENCE_MAX_DEVIATION_PERCENT &&
							alternateVsExpected <= PAIR_REFERENCE_MAX_DEVIATION_PERCENT
						) {
							quarantineToken(tokenAddress, "PAIR_PRICE_DISAGREEMENT");
							console.log(
								"PAIR PRICE SANITY FALLBACK | " + (data.symbol || tokenAddress) +
								" | rejected locked quote $" + lockedPrice +
								" | verified alternate $" + alternatePrice +
								" | alternate liquidity $" + Number(referenceData.liquidityUsd || 0).toFixed(2)
							);
							recordSuccess();
							return {
								...referenceData,
								marketDataSource: "DexScreener Verified Alternate",
								pairSanityFallbackApplied: true,
								lockedPairAddress: pairAddress,
								lockedPairPriceUsd: lockedPrice,
								referencePriceUsd: expectedPrice
							};
						}

						if (lockedVsAlternate <= PAIR_REFERENCE_MAX_DEVIATION_PERCENT) {
							console.log(
								"PAIR PRICE SHOCK CONFIRMED | " + (data.symbol || tokenAddress) +
								" | locked $" + lockedPrice +
								" | alternate $" + alternatePrice
							);
							recordSuccess();
							return {
								...data,
								pairSanityVerified: true,
								referencePairPriceUsd: alternatePrice
							};
						}
					}

					quarantineToken(tokenAddress, "UNVERIFIED_PAIR_PRICE_SHOCK");
					console.log(
						"PAIR PRICE SHOCK QUARANTINED | " + (data.symbol || tokenAddress) +
						" | refusing unverified quote $" + lockedPrice
					);
					return null;
				} catch (verificationError) {
					quarantineToken(tokenAddress, "PAIR_PRICE_VERIFICATION_FAILED");
					console.log(
						"PAIR PRICE VERIFICATION FAILED | " + (data.symbol || tokenAddress) +
						" | refusing shock quote | " + verificationError.message
					);
					return null;
				}
			}

			recordSuccess();
			writeDashboardPairCache(tokenAddress, pairAddress, data);
			return data;
		}

		const url = "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress);
		const response = await scheduleDiscoveryRequest(
			() => axios.get(url, { timeout: 10000, signal }),
			signal
		);
		const pairs = response.data.pairs || [];

		const solanaPairs = pairs.filter(
			pair => pair.chainId === "solana" && pair.baseToken?.address === tokenAddress
		);

		if (solanaPairs.length === 0) {
			return null;
		}

		const bestPair = solanaPairs.sort(
			(a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
		)[0];

		const data = pairToTokenData(bestPair, tokenAddress);
		if (data) recordSuccess();
		return data;
	} catch (error) {
		recordFailure(error, { discovery });
		const mode = pairAddress ? "pair-locked" : "token";
		console.error("DexScreener " + mode + " error:", error.message);
		return null;
	}
}

module.exports = {
	getTokenData,
	pairToTokenData,
	getMarketDataHealth
};
