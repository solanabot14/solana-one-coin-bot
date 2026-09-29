const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hourlyActivityRequirement, entryQualitySnapshot } = require("../scanner");

function analysis(regime = "ESTABLISHED") {
	return { v5: { regime: { name: regime }, minTransactions: 20 } };
}

test("V5.9 uses one-hour activity as the hard volume gate", () => {
	const requirement = hourlyActivityRequirement(
		{ volume1h: 6500, volume5m: 700 },
		analysis("ESTABLISHED")
	);
	assert.equal(requirement.requiredVolume1h, 5000);
	assert.equal(requirement.healthy, true);
	assert.equal(requirement.mode, "HOURLY_ACTIVITY");
});

test("V5.9 does not require high 5m dollar volume when 1h activity is healthy", () => {
	const quality = entryQualitySnapshot(
		{
			liquidityUsd: 100000,
			volume5m: 1000,
			volume1h: 12000,
			buys5m: 14,
			sells5m: 6,
			priceChange5m: 0.8,
			priceChange1h: 2
		},
		analysis("ESTABLISHED"),
		{ status: "UNAVAILABLE" }
	);
	assert.equal(quality.activityHealthy, true);
	assert.equal(quality.requiredVolume1h, 5000);
	assert.equal(quality.volume5m, 1000);
});

test("V5.9 blocks genuinely inactive one-hour volume", () => {
	const quality = entryQualitySnapshot(
		{
			liquidityUsd: 100000,
			volume5m: 900,
			volume1h: 3000,
			buys5m: 14,
			sells5m: 6,
			priceChange5m: 0.8,
			priceChange1h: 2
		},
		analysis("EARLY"),
		{ status: "UNAVAILABLE" }
	);
	assert.equal(quality.activityHealthy, false);
});
