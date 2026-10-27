const { getMintSafety, getHolderConcentration } = require("./geminiSources");

// Restore yesterday's entry thresholds while keeping current on-chain safety gates.
const MIN_LIQUIDITY_USD = 5000;
const MIN_POOL_AGE_MS = 2 * 60 * 1000;
const MAX_POOL_AGE_MS = 120 * 60 * 1000;
const MIN_TRANSACTIONS_5M = 15;
const MIN_VOLUME_5M_USD = 500;
const MIN_BUY_RATIO_5M = 0.60;
const MAX_TOP10_PERCENT = 35;

async function evaluateCandidate(candidate, { signal, mintSafety = getMintSafety, holderConcentration = getHolderConcentration, marketOnly = false } = {}) {
  const reject = (reason, details = {}) => ({ accepted: false, reason, details });
  if (!candidate.exactPoolVerified || String(candidate.dexId || "").toLowerCase() !== "pumpswap")
    return reject("Exact PumpSwap Pool Unverified", { validation: candidate.canonicalPoolFailureReason || null });
  const liquidity = Number(candidate.liquidityUsd);
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD)
    return reject("Low Liquidity", { liquidityUsd: liquidity || 0, minimum: MIN_LIQUIDITY_USD });

  const created = Date.parse(candidate.poolCreatedAt || "");
  if (!Number.isFinite(created)) return reject("Pool Age Unverified");
  const age = Date.now() - created;
  if (age < MIN_POOL_AGE_MS)
    return reject("Pool Age Below 2 Minutes", { ageMs: age, minimum: MIN_POOL_AGE_MS });
  if (age > MAX_POOL_AGE_MS)
    return reject("Pool Age Above 120 Minutes", { ageMs: age, maximum: MAX_POOL_AGE_MS });

  const buys = Number(candidate.buys5m) || 0;
  const sells = Number(candidate.sells5m) || 0;
  const tx = buys + sells;
  if (tx < MIN_TRANSACTIONS_5M) return reject("Low 5m Activity", { transactions5m: tx, minimum: MIN_TRANSACTIONS_5M });
  const volume5mUsd = Number(candidate.volume5m) || 0;
  if (volume5mUsd < MIN_VOLUME_5M_USD)
    return reject("Low 5m Dollar Volume", { volume5mUsd, minimum: MIN_VOLUME_5M_USD });
  const buyRatio = tx ? buys / tx : 0;
  if (buyRatio < MIN_BUY_RATIO_5M)
    return reject("Buy Pressure Below 60%", { buys, sells, buyRatio, minimum: MIN_BUY_RATIO_5M });
  const marketDetails = {
    dexId: candidate.dexId || null, liquidityUsd: liquidity, poolAgeMs: age,
    transactions5m: tx, volume5mUsd, buyRatio,
    priceChange5m: Number.isFinite(Number(candidate.priceChange5m)) ? Number(candidate.priceChange5m) : null
  };
  if (marketOnly) return { accepted: true, reason: "Gemini market checks passed", details: marketDetails };

  let mint;
  try { mint = await mintSafety(candidate.tokenAddress, signal); }
  catch (error) { return reject("Mint Authority Check Failed", { error: error.message }); }
  if (!mint?.verified) return reject(mint?.reason || "Mint Account Unverified");
  if (!mint.mintRevoked) return reject("Mint Authority Active");
  if (!mint.freezeDisabled) return reject("Freeze Authority Active");

  let holders;
  try { holders = await holderConcentration(candidate.tokenAddress, signal); }
  catch (error) { return reject("Holder Check Failed", { error: error.message }); }
  if (!holders?.verified || !Number.isFinite(Number(holders.top10Percent)))
    return reject("Top 10 Holder Data Unverified");
  if (Number(holders.top10Percent) >= MAX_TOP10_PERCENT)
    return reject("Top 10 Concentration At or Above 35%", { top10Percent: Number(holders.top10Percent) });

  return {
    accepted: true,
    reason: "Solana pair passed Gemini safety checks",
    details: { ...marketDetails, top10Percent: Number(holders.top10Percent), liquidityVerification: "canonical PumpSwap pool verified on-chain" },
    mintSafety: mint
  };
}

module.exports = {
  evaluateCandidate,
  MIN_LIQUIDITY_USD,
  MIN_POOL_AGE_MS,
  MAX_POOL_AGE_MS,
  MIN_TRANSACTIONS_5M,
  MIN_VOLUME_5M_USD,
  MIN_BUY_RATIO_5M,
  MAX_TOP10_PERCENT,
};
