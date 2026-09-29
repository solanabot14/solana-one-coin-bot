const { test } = require("node:test");
const assert = require("node:assert/strict");
const { adaptiveVolumeRequirement, entryQualitySnapshot } = require("../scanner");

function analysis(regime, acceleration) {
	return {
		v5: {
			regime: { name: regime },
			volumeAcceleration: acceleration
		}
	};
}

const heliusOk = {
	status: "OK",
	swapsLast5m: 8,
	uniqueMakers5m: 5
};

test("V5.3 lowers launch threshold only when Helius confirms real flow", () => {
	const requirement = adaptiveVolumeRequirement({}, analysis("LAUNCH", 1.4), heliusOk);
	assert.equal(requirement.requiredVolume5m, 1500);
	assert.equal(requirement.mode, "ADAPTIVE");
	assert.equal(requirement.heliusConfirmed, true);
});

test("V5.3 keeps 5k fallback when Helius is unavailable", () => {
	const requirement = adaptiveVolumeRequirement({}, analysis("LAUNCH", 1.4), {
		status: "UNAVAILABLE",
		swapsLast5m: 0,
		uniqueMakers5m: 0
	});
	assert.equal(requirement.requiredVolume5m, 5000);
	assert.equal(requirement.mode, "FIXED_FALLBACK");
});

test("V5.3 uses higher threshold for established tokens", () => {
	const requirement = adaptiveVolumeRequirement({}, analysis("ESTABLISHED", 1.2), heliusOk);
	assert.equal(requirement.requiredVolume5m, 4000);
});

test("entry activity passes an early token at 2200 when adaptive threshold is 2000", () => {
	const quality = entryQualitySnapshot(
		{
			liquidityUsd: 100000,
			volume5m: 2200,
			volume1h: 18000,
			buys5m: 12,
			sells5m: 6,
			priceChange5m: 0.8,
			priceChange1h: 2
		},
		analysis("EARLY", 1.3),
		heliusOk
	);
	assert.equal(quality.requiredVolume5m, 2000);
	assert.equal(quality.activityHealthy, true);
});
