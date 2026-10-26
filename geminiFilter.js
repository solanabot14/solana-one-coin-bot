const { getMintSafety, getHolderConcentration, getLiquidityLock } = require("./geminiSources");

// Restored to the configuration that admitted Gemini's last entry (ELIZABETH).
const MIN_LIQUIDITY_USD = 5000;
const MIN_POOL_AGE_MS = 2 * 60 * 1000;
const MAX_POOL_AGE_MS = 120 * 60 * 1000;
const MIN_TRANSACTIONS_5M = 15;
const MIN_BUY_RATIO_5M = 0.55;
const MAX_TOP10_PERCENT = 35;
const MIN_PRICE_CHANGE_5M = 2;
const MIN_LIQUIDITY_LOCK_PERCENT = 95;

async function evaluateCandidate(candidate, { signal, mintSafety = getMintSafety, holderConcentration = getHolderConcentration, liquidityLock = getLiquidityLock } = {}) {
  const reject = (reason, details = {}) => ({ accepted: false, reason, details });
  if (!candidate.exactPoolVerified || String(candidate.dexId || "").toLowerCase() !== "pumpswap")
    return reject("Exact PumpSwap Pool Unverified");
  const priceChange5m = Number(candidate.priceChange5m);
  if (!Number.isFinite(priceChange5m)) return reject("5m Price Trend Unverified");
  if (priceChange5m < MIN_PRICE_CHANGE_5M)
    return reject("5m Momentum Below +2%", { priceChange5m, minimum: MIN_PRICE_CHANGE_5M });
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
  const buyRatio = tx ? buys / tx : 0;
  if (buys <= sells || buyRatio <= MIN_BUY_RATIO_5M)
    return reject("Buy Pressure Not Above 55%", { buys, sells, buyRatio, minimumExclusive: MIN_BUY_RATIO_5M });

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

  let lock;
  try { lock = await liquidityLock(candidate.tokenAddress, signal); }
  catch (error) { return reject("Liquidity Lock Check Failed", { error: error.message }); }
  if (!lock?.verified || !Number.isFinite(Number(lock.lockedPercent)))
    return reject(lock?.reason || "Liquidity Lock Unverified");
  if (Number(lock.lockedPercent) < MIN_LIQUIDITY_LOCK_PERCENT)
    return reject("Liquidity Lock Below 95%", { lockedPercent: Number(lock.lockedPercent), minimum: MIN_LIQUIDITY_LOCK_PERCENT });

  return {
    accepted: true,
    reason: "Solana pair passed Gemini safety checks",
    details: { dexId: candidate.dexId || null, liquidityUsd: liquidity, poolAgeMs: age, transactions5m: tx, volume5mUsd: Number(candidate.volume5m) || 0, buyRatio, priceChange5m, top10Percent: Number(holders.top10Percent), liquidityLockedPercent: Number(lock.lockedPercent) },
    mintSafety: mint
  };
}

module.exports = {
  evaluateCandidate,
  MIN_LIQUIDITY_USD,
  MIN_POOL_AGE_MS,
  MAX_POOL_AGE_MS,
  MIN_TRANSACTIONS_5M,
  MIN_BUY_RATIO_5M,
  MAX_TOP10_PERCENT,
  MIN_LIQUIDITY_LOCK_PERCENT,
};
