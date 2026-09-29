const { test } = require("node:test");
const assert = require("node:assert/strict");
const { adaptiveVolumeRequirement, entryQualitySnapshot } = require("../scanner");

function analysis(regime, acceleration, minTransactions = 20) {
	return {
		v5: {
			regime: { name: regime },
			volumeAcceleration: acceleration,
			minTransactions
		}
	};
}

const goodDex = {
	buys5m: 14,
	sells5m: 6
};

test("V5.7 lowers launch threshold from Dex quality even when Helius is unavailable", () => {
	const requirement = adaptiveVolumeRequirement(
		goodDex,
		analysis("LAUNCH", 1.4),
		{ status: "UNAVAILABLE", swapsLast5m: 0, uniqueMakers5m: 0 }
	);
	assert.equal(requirement.requiredVolume5m, 1500);
	assert.equal(requirement.mode, "ADAPTIVE_DEX");
	assert.equal(requirement.dexQualityConfirmed, true);
	assert.equal(requirement.heliusConfirmed, false);
});

test("V5.7 keeps 5k fallback when transactions or buy ratio are weak", () => {
	const requirement = adaptiveVolumeRequirement(
		{ buys5m: 3, sells5m: 2 },
		analysis("LAUNCH", 1.4),
		{ status: "UNAVAILABLE" }
	);
	assert.equal(requirement.requiredVolume5m, 5000);
	assert.equal(requirement.mode, "FIXED_FALLBACK");
	assert.equal(requirement.dexQualityConfirmed, false);
});

test("V5.7 uses higher adaptive threshold for established tokens", () => {
	const requirement = adaptiveVolumeRequirement(
		goodDex,
		analysis("ESTABLISHED", 1.2),
		{ status: "OK", swapsLast5m: 8, uniqueMakers5m: 5 }
	);
	assert.equal(requirement.requiredVolume5m, 4000);
	assert.equal(requirement.heliusConfirmed, true);
});

test("entry activity passes an early token at 2200 without requiring Helius", () => {
	const quality = entryQualitySnapshot(
		{
			liquidityUsd: 100000,
			volume5m: 2200,
			volume1h: 18000,
			buys5m: 14,
			sells5m: 6,
			priceChange5m: 0.8,
			priceChange1h: 2
		},
		analysis("EARLY", 1.3),
		{ status: "UNAVAILABLE" }
	);
	assert.equal(quality.requiredVolume5m, 2000);
	assert.equal(quality.volumeGateMode, "ADAPTIVE_DEX");
	assert.equal(quality.activityHealthy, true);
});
