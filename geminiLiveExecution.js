// Live execution is deliberately opt-in.  Merely deploying this module can never
// sign or submit a transaction: it requires both an explicit enable flag and a
// signing key stored as a Railway secret.

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const API = "https://api.jup.ag/swap/v2";

function configured(env = process.env) {
  // Live entry is controlled only by the protected dashboard switch.  A
  // deployment/restart defaults to off because the persisted switch defaults
  // to false.  An environment variable alone can never arm this wallet.
  return require("./geminiLiveControl").isEnabled() && !!env.GEMINI_LIVE_PRIVATE_KEY;
}

function status(env = process.env) {
  const enabled = env.GEMINI_LIVE_ENABLED === "true";
  const hasSigningKey = !!env.GEMINI_LIVE_PRIVATE_KEY;
  return {
    mode: configured(env) ? "LIVE_READY" : "PAPER_ONLY",
    enabled,
    hasSigningKey,
    walletAddress: env.GEMINI_LIVE_WALLET_ADDRESS || null,
    tradeSizeUsd: 5,
    maxOpenPositions: 1,
    reason: configured(env) ? null : "Live trading is off or the signing key is not configured."
  };
}

function signerFromSecret(secret) {
  const { Keypair } = require("@solana/web3.js");
  if (!secret) throw new Error("GEMINI_LIVE_PRIVATE_KEY is not configured.");
  let bytes;
  try { bytes = Uint8Array.from(JSON.parse(secret)); }
  catch (_) {
    const imported = require("bs58");
    const bs58 = imported.default || imported;
    bytes = bs58.decode(secret.trim());
  }
  return Keypair.fromSecretKey(bytes);
}

function createGeminiLiveExecution({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  function requireSigningKey() {
    if (!env.GEMINI_LIVE_PRIVATE_KEY) throw new Error("GEMINI_LIVE_PRIVATE_KEY is not configured.");
    const signer = signerFromSecret(env.GEMINI_LIVE_PRIVATE_KEY);
    if (env.GEMINI_LIVE_WALLET_ADDRESS && signer.publicKey.toBase58() !== env.GEMINI_LIVE_WALLET_ADDRESS) {
      throw new Error("Configured wallet address does not match the signing key.");
    }
    return signer;
  }
  function requireEnabled() {
    if (!configured(env)) throw new Error("Live entry is disabled.");
    return requireSigningKey();
  }

  async function request(path, options = {}) {
    const response = await fetchImpl(API + path, { ...options, headers: { Accept: "application/json", ...(env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {}), ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error || body.errorCode) throw new Error(body.error || body.message || "Jupiter request failed (" + response.status + ").");
    return body;
  }

  async function executeSwap({ inputMint, outputMint, amount, slippageBps = 300, purpose = "entry" }) {
    // Turning the dashboard switch off blocks new buys, but never abandons a
    // real position that still needs a real exit transaction.
    const signer = purpose === "exit" ? requireSigningKey() : requireEnabled();
    if (!inputMint || !outputMint || outputMint === inputMint) throw new Error("Unsupported live swap request.");
    if (!Number.isSafeInteger(Number(amount)) || Number(amount) <= 0) throw new Error("Invalid live swap amount.");
    const order = await request("/order?" + new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker: signer.publicKey.toBase58(), slippageBps: String(slippageBps) }));
    if (!order.transaction || !order.requestId || !/^\d+$/.test(String(order.outAmount || ""))) throw new Error("Jupiter did not return an executable order.");
    const { VersionedTransaction } = require("@solana/web3.js");
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([signer]);
    const submitted = await request("/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signedTransaction: Buffer.from(transaction.serialize()).toString("base64"), requestId: order.requestId }) });
    // Jupiter V2 reports the wallet-reflected fill in totalOutputAmount.  Never
    // use the quote (or a route-only amount) as the live fill: that could make
    // the next sell request use a token amount the wallet does not actually own.
    if (submitted.status !== "Success" || Number(submitted.code) !== 0 || !submitted.signature)
      throw new Error(submitted.error || "Jupiter did not confirm the transaction.");
    if (!/^\d+$/.test(String(submitted.totalOutputAmount || "")))
      throw new Error("Jupiter confirmation did not include the wallet-reflected output amount.");
    return {
      signature: submitted.signature,
      inputMint,
      outputMint,
      inputAmount: String(amount),
      quotedOutputAmount: String(order.outAmount),
      actualOutputAmount: String(submitted.totalOutputAmount),
      actualInputAmount: /^\d+$/.test(String(submitted.totalInputAmount || "")) ? String(submitted.totalInputAmount) : null,
      status: submitted.status
    };
  }

  return { status: () => status(env), executeSwap };
}

module.exports = { USDC, SOL, configured, status, createGeminiLiveExecution };
