const axios = require("axios");
const { retry } = require("./geminiHttp");

const SOLANA_RPC_URL = process.env.RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1/tokens/";
const GT_BASE = "https://api.geckoterminal.com/api/v2";

async function rpc(method, params, signal) {
  const { data } = await retry(() => axios.post(SOLANA_RPC_URL, {
    jsonrpc: "2.0", id: Date.now(), method, params
  }, { timeout: 12000, signal, headers: { "content-type": "application/json" } }));
  if (data?.error) throw new Error(data.error.message || "Solana RPC error");
  return data?.result;
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

module.exports = { getMintSafety, getHolderConcentration, extractTop10Concentration, getGeckoPools, getGeckoTokenQuote, getDexProfiles, getDexPairs, getPairDetails };
