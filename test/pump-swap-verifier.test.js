const test = require("node:test");
const assert = require("node:assert/strict");
const { PublicKey } = require("@solana/web3.js");
const {
	PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, ACCOUNT_DISCRIMINATOR,
	createPumpSwapVerifier
} = require("../pumpSwapVerifier");
const { createLpLockChecker } = require("../lpLockChecker");

function canonicalFixture() {
	const tokenAddress = "So11111111111111111111111111111111111111112";
	const baseMint = new PublicKey(tokenAddress);
	const quoteMint = new PublicKey("11111111111111111111111111111111");
	const [creator] = PublicKey.findProgramAddressSync(
		[Buffer.from("pool-authority"), baseMint.toBuffer()], new PublicKey(PUMP_PROGRAM_ID)
	);
	const [pairAddress] = PublicKey.findProgramAddressSync(
		[Buffer.from("pool"), Buffer.from([0, 0]), creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()],
		new PublicKey(PUMPSWAP_PROGRAM_ID)
	);
	const data = Buffer.alloc(107);
	ACCOUNT_DISCRIMINATOR.copy(data, 0);
	data[8] = 255;
	data.writeUInt16LE(0, 9);
	creator.toBuffer().copy(data, 11);
	baseMint.toBuffer().copy(data, 43);
	quoteMint.toBuffer().copy(data, 75);
	return { tokenAddress, pairAddress: pairAddress.toBase58(), dexId: "pumpswap", account: { owner: PUMPSWAP_PROGRAM_ID, data: [data.toString("base64"), "base64"] } };
}

test("accepts only a verified canonical PumpSwap migration pool", async () => {
	const fixture = canonicalFixture();
	const verifier = createPumpSwapVerifier({ httpPost: async () => ({ data: { result: { value: fixture.account } } }) });
	assert.equal(await verifier.verifyCanonicalMigration(fixture), true);
	assert.equal(await verifier.verifyCanonicalMigration({ ...fixture, dexId: "raydium" }), false);
	assert.equal(await verifier.verifyCanonicalMigration({ ...fixture, pairAddress: fixture.tokenAddress }), false);
});

test("rejects noncanonical pool index and a pool account owned by another program", async () => {
	const fixture = canonicalFixture();
	const accountFor = patch => {
		const bytes = Buffer.from(fixture.account.data[0], "base64");
		patch(bytes);
		return { ...fixture.account, data: [bytes.toString("base64"), "base64"] };
	};
	const nonzeroIndex = createPumpSwapVerifier({ httpPost: async () => ({ data: { result: { value: accountFor(data => data.writeUInt16LE(1, 9)) } } }) });
	assert.equal(await nonzeroIndex.verifyCanonicalMigration(fixture), false);
	const wrongOwner = createPumpSwapVerifier({ httpPost: async () => ({ data: { result: { value: { ...fixture.account, owner: "11111111111111111111111111111111" } } } }) });
	assert.equal(await wrongOwner.verifyCanonicalMigration(fixture), false);
});

test("LP gate uses verified migration as a separate case even if RugCheck reports a low percentage", async () => {
	const fixture = canonicalFixture();
	const checker = createLpLockChecker({
		httpGet: async () => ({ data: { lpLockedPct: 20 } }),
		verifyPumpSwapMigration: async coin => coin.pairAddress === fixture.pairAddress
	});
	const result = await checker.getLockStatus(fixture.tokenAddress, fixture);
	assert.deepEqual(result, {
		allowed: true,
		lockedPercent: null,
		reason: "CANONICAL_PUMPSWAP_MIGRATION_VERIFIED",
		canonicalPumpSwapMigration: true
	});
});
