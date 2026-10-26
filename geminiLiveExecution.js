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
  const parseBytes = value => {
    const text = String(value).trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = undefined; }
    if (Array.isArray(parsed)) {
      if (!parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255))
        throw new Error("GEMINI_LIVE_PRIVATE_KEY JSON array is invalid.");
      return Uint8Array.from(parsed);
    }
    // Some secret managers preserve a JSON-quoted base58 key. Unwrap it before
    // decoding instead of treating the quote characters as part of the key.
    const encoded = (typeof parsed === "string" ? parsed : text).replace(/\s+/g, "");
    // Jupiter Wallet also exports Solana private keys as hexadecimal. Detect
    // that deliberately before base58 because many hex characters overlap the
    // base58 alphabet and could otherwise decode to the wrong byte length.
    const hex = encoded.replace(/^0x/i, "");
    if (/^[0-9a-fA-F]{64}$/.test(hex) || /^[0-9a-fA-F]{128}$/.test(hex))
      return Uint8Array.from(Buffer.from(hex, "hex"));
    const imported = require("bs58");
    const bs58 = imported.default || imported;
    try { return bs58.decode(encoded); }
    catch (_) {
      // Base64 is another standard export form for a Solana secret key.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new Error("GEMINI_LIVE_PRIVATE_KEY must be a Solana JSON array, hexadecimal, base58 key, or base64 key.");
      return Uint8Array.from(Buffer.from(encoded, "base64"));
    }
  };
  const bytes = parseBytes(secret);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  throw new Error("GEMINI_LIVE_PRIVATE_KEY must decode to a 32-byte seed or 64-byte Solana secret key.");
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

  async function rpc(method, params) {
    const response = await fetchImpl(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body?.error?.message || "Solana balance lookup failed.");
    return body.result;
  }

  async function walletBalances(signer) {
    const owner = signer.publicKey.toBase58();
    const [sol, usdc] = await Promise.all([
      rpc("getBalance", [owner, { commitment: "confirmed" }]),
      rpc("getTokenAccountsByOwner", [owner, { mint: USDC }, { encoding: "jsonParsed", commitment: "confirmed" }])
    ]);
    return {
      solLamports: Number(sol?.value || 0),
      usdcRaw: (usdc?.value || []).reduce((total, account) => total + Number(account?.account?.data?.parsed?.info?.tokenAmount?.amount || 0), 0)
    };
  }

  async function entryInput(signer, amountUsd) {
    const desiredUsdcRaw = Math.round(Number(amountUsd) * 1e6);
    if (!(desiredUsdcRaw > 0)) throw new Error("Invalid live entry amount.");
    let balances;
    try { balances = await walletBalances(signer); }
    catch (_) {
      // Do not make a temporary public-RPC outage stop a wallet that is funded
      // with USDC. Jupiter remains the execution authority in that case.
      return { inputMint: USDC, amount: desiredUsdcRaw };
    }
    if (balances.usdcRaw >= desiredUsdcRaw) return { inputMint: USDC, amount: desiredUsdcRaw };

    // A wallet funded with SOL should work without requiring a manual USDC
    // conversion. Quote one SOL to determine the exact lamports for this
    // dollar-sized entry, then leave a small SOL reserve for transaction fees.
    const quote = await request("/order?" + new URLSearchParams({
      inputMint: SOL, outputMint: USDC, amount: "1000000000", taker: signer.publicKey.toBase58(), slippageBps: "300"
    }));
    const usdcPerSolRaw = Number(quote.outAmount);
    if (!(usdcPerSolRaw > 0)) throw new Error("Jupiter could not price SOL for the live entry.");
    const solLamports = Math.ceil(desiredUsdcRaw * 1e9 / usdcPerSolRaw);
    const feeReserveLamports = 5_000_000;
    if (balances.solLamports < solLamports + feeReserveLamports)
      throw new Error("Wallet needs at least the live trade amount in USDC or SOL plus a small SOL network-fee reserve.");
    return { inputMint: SOL, amount: solLamports };
  }

  async function executeSwap({ inputMint, outputMint, amount, slippageBps = 300, purpose = "entry" }) {
    // Turning the dashboard switch off blocks new buys, but never abandons a
    // real position that still needs a real exit transaction.
    const signer = purpose === "exit" || purpose === "manual-entry" ? requireSigningKey() : requireEnabled();
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

  async function executeEntry({ outputMint, amountUsd, slippageBps = 300 }) {
    const signer = requireEnabled();
    const input = await entryInput(signer, amountUsd);
    return executeSwap({ ...input, outputMint, slippageBps });
  }

  // This path is called only after the authorized Telegram chat taps a live Buy button.
  // It does not arm automatic Gemini live entries; the callback itself is the one-time authorization.
  async function executeManualEntry({ outputMint, amountUsd, slippageBps = 300 }) {
    if (!configured(env)) throw new Error("Gemini Live Trading is off; no order was placed.");
    const setup = require("./geminiLiveControl").readiness(env);
    if (!setup.ready) throw new Error("Live wallet setup is incomplete; no order was placed.");
    const signer = requireEnabled();
    const input = await entryInput(signer, amountUsd);
    return executeSwap({ ...input, outputMint, slippageBps, purpose: "manual-entry" });
  }

  return { status: () => status(env), executeSwap, executeEntry, executeManualEntry };
}

module.exports = { USDC, SOL, configured, status, signerFromSecret, createGeminiLiveExecution };
