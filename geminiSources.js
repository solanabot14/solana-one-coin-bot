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
  const holderList = [report?.topHolders, report?.holders, report?.token?.topHolders]
    .find(Array.isArray);
  if (!holderList || holderList.length < 10) return null;
  const top10 = holderList.slice(0, 10)
    .filter(h => h && h.isPool !== true && h.isLiquidityPool !== true && h.owner !== "pool")
    .slice(0, 10);
  if (top10.length < 10) return null;
  const values = top10.map(h => Number(h.pct ?? h.percentage ?? h.share ?? h.amountPct));
  if (values.some(v => !Number.isFinite(v) || v < 0)) return null;
  // RugCheck pct is reported in percentage points (e.g. 2.5 means 2.5%).
  return values.reduce((a, b) => a + b, 0);
}

async function getHolderConcentration(tokenAddress, signal) {
  const { data } = await retry(() => axios.get(
    RUGCHECK_BASE + encodeURIComponent(tokenAddress) + "/report",
    { timeout: 12000, signal, headers: { accept: "application/json" } }
  ));
  const concentration = extractTop10Concentration(data);
  return { verified: concentration != null, top10Percent: concentration };
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
      liquidityUsd: Number(a.reserve_in_usd) || 0,\n      priceUsd: Number(a.base_token_price_usd) || 0,
      volume5m: Number(a.volume_usd?.m5) || 0,
      buys5m: Number(a.transactions?.m5?.buys) || 0,
      sells5m: Number(a.transactions?.m5?.sells) || 0,
      source: "GeckoTerminal"
    };
  }).filter(pool => pool.tokenAddress && pool.pairAddress);
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

module.exports = { getMintSafety, getHolderConcentration, getGeckoPools, getDexPairs, getPairDetails };
