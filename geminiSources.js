const axios = require("axios");
const { PublicKey } = require("@solana/web3.js");
const { createHash } = require("node:crypto");
const { retry } = require("./geminiHttp");

const SOLANA_RPC_URL = process.env.RPC_URL || process.env.SOLANA_RPC_URL ||
  (process.env.HELIUS_API_KEY ? "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(process.env.HELIUS_API_KEY) : "https://api.mainnet-beta.solana.com");
const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_POOL_DISCRIMINATOR = createHash("sha256").update("account:Pool").digest().subarray(0, 8);
const canonicalPoolCache = new Map();
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1/tokens/";
const GT_BASE = "https://api.geckoterminal.com/api/v2";

async function rpc(method, params, signal, { timeoutMs = 12000, attempts = 5, baseDelayMs = 350, endpoint = SOLANA_RPC_URL } = {}) {
  const { data } = await retry(() => axios.post(endpoint, {
    jsonrpc: "2.0", id: Date.now(), method, params
  }, { timeout: timeoutMs, signal, headers: { "content-type": "application/json" } }), { attempts, baseDelayMs, signal });
  if (data?.error) throw new Error(data.error.message || "Solana RPC error");
  return data?.result;
}

function verifyCanonicalPumpSwapPool(account, poolAddress, tokenAddress) {
  try {
    if (!account || account.owner !== PUMP_AMM_PROGRAM.toBase58() || !Array.isArray(account.data) || typeof account.data[0] !== "string")
      return { verified: false, reason: "Pool account is not owned by PumpSwap" };
    const data = Buffer.from(account.data[0], "base64");
    // Anchor discriminator (8), bump (1), index (u16), creator (32), base mint (32), quote mint (32).
    if (data.length < 107 || !data.subarray(0, 8).equals(PUMP_POOL_DISCRIMINATOR))
      return { verified: false, reason: "PumpSwap Pool account layout is unverified" };
    const index = data.readUInt16LE(9);
    const creator = new PublicKey(data.subarray(11, 43));
    const baseMint = new PublicKey(data.subarray(43, 75));
    const quoteMint = new PublicKey(data.subarray(75, 107));
    const expectedMint = new PublicKey(tokenAddress);
    if (index !== 0 || !baseMint.equals(expectedMint))
      return { verified: false, reason: "Pool is not the canonical Pump migration pool for this token" };
    const [expectedCreator] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool-authority"), expectedMint.toBuffer()], PUMP_PROGRAM
    );
    if (!creator.equals(expectedCreator))
      return { verified: false, reason: "Pump migration pool authority does not match" };
    const [expectedPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from([index & 255, index >> 8]), creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()],
      PUMP_AMM_PROGRAM
    );
    if (!expectedPool.equals(new PublicKey(poolAddress)))
      return { verified: false, reason: "Pool address does not match its on-chain fields" };
    return { verified: true, reason: null };
  } catch (_) {
    return { verified: false, reason: "PumpSwap Pool account could not be decoded" };
  }
}

async function getCanonicalPumpSwapPools(pools, signal) {
  const results = new Map();
  const unique = new Map();
  const now = Date.now();
  for (const pool of Array.isArray(pools) ? pools : []) {
    const address = String(pool?.pairAddress || "");
    const key = address.toLowerCase();
    if (!address || !pool?.tokenAddress) continue;
    const cached = canonicalPoolCache.get(key);
    if (cached && now - cached.at < (cached.result.verified ? 5 * 60_000 : 15_000)) {
      results.set(key, cached.result);
    } else if (!unique.has(key)) {
      unique.set(key, pool);
    }
  }
  if (unique.size) {
    const entries = [...unique.entries()];
    try {
      const poolAddresses = entries.map(([, pool]) => pool.pairAddress);
      let response;
      try {
        response = await rpc("getMultipleAccounts", [
          poolAddresses, { encoding: "base64", commitment: "confirmed" }
        ], signal, { timeoutMs: 3000, attempts: 1 });
      } catch (primaryError) {
        const status = primaryError?.response?.status;
        if (status && status !== 429 && status < 500) throw primaryError;
        response = await rpc("getMultipleAccounts", [
          poolAddresses, { encoding: "base64", commitment: "confirmed" }
        ], signal, { timeoutMs: 3000, attempts: 1, endpoint: "https://api.mainnet-beta.solana.com" });
        console.warn("Gemini pool verification used public Solana RPC after primary RPC was unavailable.");
      }
      const accounts = Array.isArray(response?.value) ? response.value : [];
      entries.forEach(([key, pool], index) => {
        const result = verifyCanonicalPumpSwapPool(accounts[index], pool.pairAddress, pool.tokenAddress);
        results.set(key, result);
        canonicalPoolCache.set(key, { at: Date.now(), result });
      });
    } catch (error) {
      for (const [key] of entries) {
        const result = { verified: false, reason: "PumpSwap pool RPC unavailable" };
        results.set(key, result);
        canonicalPoolCache.set(key, { at: Date.now(), result });
      }
      console.warn("Gemini canonical PumpSwap pool verification unavailable:", error.message);
    }
  }
  const verificationCounts = {};
  for (const result of results.values()) {
    const label = result.verified ? "verified" : result.reason || "unverified";
    verificationCounts[label] = (verificationCounts[label] || 0) + 1;
  }
  console.log("[INFO] Gemini canonical PumpSwap validation", { pools: results.size, ...verificationCounts });
  return results;
}

async function getMintSafety(tokenAddress, signal) {
  const result = await rpc("getAccountInfo", [tokenAddress, { encoding: "jsonParsed", commitment: "confirmed" }], signal);
  const parsed = result?.value?.data?.parsed;
  if (parsed?.type !== "mint" || !parsed?.info) return { verified: false, reason: "MINT_ACCOUNT_UNVERIFIED" };
  const { mintAuthority, freezeAuthority } = parsed.info;
  return {
    verified: true,
    mintAuthority,
    freezeAuthority,
    mintRevoked: mintAuthority == null,
    freezeDisabled: freezeAuthority == null
  };
}

function extractTop10Concentration(report) {
  const holderList = [report?.topHolders, report?.holders, report?.token?.topHolders].find(Array.isArray);
  if (!holderList) return null;
  const knownAccounts = report?.knownAccounts || {};
  const nonPoolHolders = holderList.filter(holder => {
    if (!holder) return false;
    if (holder.isPool === true || holder.isLiquidityPool === true) return false;
    const addresses = [holder.address, holder.owner].filter(Boolean);
    if (addresses.some(address => String(address).toLowerCase() === "pool")) return false;
    return !addresses.some(address => {
      const type = String(knownAccounts[address]?.type || knownAccounts[address]?.name || "").toUpperCase();
      return /AMM|POOL|LIQUIDITY|DEX/.test(type);
    });
  });
  if (nonPoolHolders.length < 10) return null;
  const top10 = nonPoolHolders.slice(0, 10);
  const values = top10.map(holder => Number(holder.pct ?? holder.percentage ?? holder.share ?? holder.amountPct));
  if (values.some(value => !Number.isFinite(value) || value < 0)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

async function getHolderConcentration(tokenAddress, signal) {
  const { data } = await retry(() => axios.get(
    RUGCHECK_BASE + encodeURIComponent(tokenAddress) + "/report",
    { timeout: 12000, signal, headers: { accept: "application/json" } }
  ));
  const concentration = extractTop10Concentration(data);
  return { verified: concentration != null, top10Percent: concentration };
}

// RugCheck summary reports the share of LP value locked or burned. Cache briefly to
// avoid repeated summary requests while scanning the same candidate.
const liquidityLockCache = new Map();
const LIQUIDITY_LOCK_CACHE_MS = 30_000;
async function getLiquidityLock(tokenAddress, signal) {
  if (!tokenAddress) return { verified: false, reason: "Liquidity lock mint missing" };
  const key = String(tokenAddress);
  const cached = liquidityLockCache.get(key);
  if (cached && Date.now() - cached.at < LIQUIDITY_LOCK_CACHE_MS) return cached.result;

  let result;
  try {
    const { data } = await retry(() => axios.get(
      RUGCHECK_BASE + encodeURIComponent(key) + "/report/summary",
      { timeout: 12000, signal, headers: { accept: "application/json" } }
    ));
    const lockedPercent = Number(data?.lpLockedPct);
    result = Number.isFinite(lockedPercent) && lockedPercent >= 0 && lockedPercent <= 100
      ? { verified: true, lockedPercent }
      : { verified: false, reason: "RugCheck liquidity lock percentage unavailable" };
  } catch (error) {
    result = { verified: false, reason: "RugCheck liquidity lock check failed", error: error.message };
  }
  liquidityLockCache.set(key, { at: Date.now(), result });
  return result;
}

const geckoTokenQuoteCache = new Map();
const GECKO_TOKEN_QUOTE_CACHE_MS = 30_000;

async function getGeckoTokenQuote(tokenAddress, signal) {
  if (!tokenAddress) return null;
  const key = String(tokenAddress);
  const cached = geckoTokenQuoteCache.get(key);
  if (cached && Date.now() - cached.at < GECKO_TOKEN_QUOTE_CACHE_MS) return cached.quote;

  let quote = null;
  try {
    const { data } = await retry(() => axios.get(
      GT_BASE + "/networks/solana/tokens/" + encodeURIComponent(key) + "/pools",
      {
        timeout: 12000, signal,
        headers: { accept: "application/json;version=20230203" },
        params: { page: 1, include: "base_token,quote_token" }
      }
    ));
    const rows = Array.isArray(data?.data) ? data.data : [];
    const normalized = rows.map(row => {
      const attributes = row.attributes || {};
      const relationships = row.relationships || {};
      const baseAddress = relationships.base_token?.data?.id?.split("_").at(-1);
      const quoteAddress = relationships.quote_token?.data?.id?.split("_").at(-1);
      const priceUsd = baseAddress === key
        ? Number(attributes.base_token_price_usd)
        : quoteAddress === key ? Number(attributes.quote_token_price_usd) : NaN;
      return {
        priceUsd,
        liquidityUsd: Number(attributes.reserve_in_usd) || 0,
        volume24hUsd: Number(attributes.volume_usd?.h24) || 0,
        pairAddress: attributes.address || row.id?.split("_").at(-1) || null
      };
    }).filter(pool => Number.isFinite(pool.priceUsd) && pool.priceUsd > 0 && pool.liquidityUsd > 0)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd || b.volume24hUsd - a.volume24hUsd);

    if (normalized[0]) quote = {
      ...normalized[0],
      quoteProvider: "GeckoTerminal",
      quoteWarning: "DexScreener has no quote for this token; price is from GeckoTerminal's highest-liquidity pool."
    };
  } catch (error) {
    console.warn("Gemini GeckoTerminal fallback quote unavailable:", error.message);
  }

  geckoTokenQuoteCache.set(key, { at: Date.now(), quote });
  return quote;
}

async function getGeckoPools(signal) {
  const { data } = await retry(() => axios.get(
    GT_BASE + "/networks/solana/new_pools",
    { timeout: 12000, signal, headers: { accept: "application/json;version=20230302" }, params: { page: 1 } }
  ));
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map(row => {
    const a = row.attributes || {};
    const rel = row.relationships || {};
    const tokenAddress = rel.base_token?.data?.id?.split("_").at(-1);
    return {
      tokenAddress,
      pairAddress: a.address || row.id?.split("_").at(-1),
      symbol: a.name || "Unknown",
      poolCreatedAt: a.pool_created_at || a.created_at || null,
      liquidityUsd: Number(a.reserve_in_usd) || 0,
      priceUsd: Number(a.base_token_price_usd) || 0,
      priceChange5m: Number(a.price_change_percentage?.m5),
      volume5m: Number(a.volume_usd?.m5) || 0,
      buys5m: Number(a.transactions?.m5?.buys) || 0,
      sells5m: Number(a.transactions?.m5?.sells) || 0,
      source: "GeckoTerminal"
    };
  }).filter(pool => pool.tokenAddress && pool.pairAddress);
}

async function getDexProfiles(signal) {
  const { data } = await retry(() => axios.get(
    "https://api.dexscreener.com/token-profiles/latest/v1",
    { timeout: 12000, signal }
  ));
  const rows = Array.isArray(data) ? data : [];
  return rows.filter(row => row.chainId === "solana" && row.tokenAddress).map(row => ({
    tokenAddress: row.tokenAddress, pairAddress: null, symbol: row.description || row.header || "Unknown",
    poolCreatedAt: null, liquidityUsd: 0, source: "DexScreener"
  }));
}

async function getDexPairs(tokenAddress, signal) {
  const { data } = await retry(() => axios.get(
    "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress),
    { timeout: 12000, signal }
  ));
  return Array.isArray(data?.pairs) ? data.pairs.filter(p => p.chainId === "solana") : [];
}

async function getPairDetails(pairAddress, signal) {
  const { data } = await retry(() => axios.get(
    "https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(pairAddress),
    { timeout: 12000, signal }
  ));
  return Array.isArray(data?.pairs) ? data.pairs[0] || null : null;
}

module.exports = { getMintSafety, getHolderConcentration, getLiquidityLock, extractTop10Concentration, getGeckoPools, getCanonicalPumpSwapPools, verifyCanonicalPumpSwapPool, getGeckoTokenQuote, getDexProfiles, getDexPairs, getPairDetails };
