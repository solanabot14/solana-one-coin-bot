const axios = require("axios");
const { PublicKey } = require("@solana/web3.js");
const { createHash } = require("node:crypto");

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const ACCOUNT_DISCRIMINATOR = createHash("sha256").update("account:Pool").digest().subarray(0, 8);

function decodeCanonicalPool(data) {
	const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
	if (bytes.length < 107 || !bytes.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) return null;
	return {
		index: bytes.readUInt16LE(9),
		creator: new PublicKey(bytes.subarray(11, 43)),
		baseMint: new PublicKey(bytes.subarray(43, 75)),
		quoteMint: new PublicKey(bytes.subarray(75, 107))
	};
}

function createPumpSwapVerifier({
	httpPost = (...args) => axios.post(...args),
	PublicKeyClass = PublicKey,
	rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
	timeoutMs = 7000
} = {}) {
	async function verifyCanonicalMigration(coin) {
		if (String(coin?.dexId || "").toLowerCase() !== "pumpswap" || !coin?.pairAddress || !coin?.tokenAddress) return false;
		try {
			const response = await httpPost(rpcUrl, {
				jsonrpc: "2.0", id: 1, method: "getAccountInfo",
				params: [coin.pairAddress, { encoding: "base64", commitment: "confirmed" }]
			}, { timeout: timeoutMs });
			const account = response?.data?.result?.value;
			if (!account || account.owner !== PUMPSWAP_PROGRAM_ID || !Array.isArray(account.data)) return false;
			const pool = decodeCanonicalPool(Buffer.from(account.data[0], "base64"));
			if (!pool || pool.index !== 0 || pool.baseMint.toBase58() !== coin.tokenAddress) return false;

			const pumpProgram = new PublicKeyClass(PUMP_PROGRAM_ID);
			const [expectedCreator] = PublicKeyClass.findProgramAddressSync(
				[Buffer.from("pool-authority"), pool.baseMint.toBuffer()], pumpProgram
			);
			if (!pool.creator.equals(expectedCreator)) return false;

			const ammProgram = new PublicKeyClass(PUMPSWAP_PROGRAM_ID);
			const [expectedPool] = PublicKeyClass.findProgramAddressSync(
				[Buffer.from("pool"), Buffer.from([0, 0]), pool.creator.toBuffer(), pool.baseMint.toBuffer(), pool.quoteMint.toBuffer()],
				ammProgram
			);
			return expectedPool.toBase58() === coin.pairAddress;
		} catch (_) {
			return false;
		}
	}
	return { verifyCanonicalMigration };
}

const client = createPumpSwapVerifier();
module.exports = {
	PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, DEFAULT_RPC_URL,
	ACCOUNT_DISCRIMINATOR, decodeCanonicalPool, createPumpSwapVerifier,
	verifyCanonicalMigration: client.verifyCanonicalMigration
};
