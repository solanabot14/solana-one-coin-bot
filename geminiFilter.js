const { getMintSafety, getHolderConcentration, getLiquidityLock } = require("./geminiSources");

const MIN_LIQUIDITY_USD = 10000;
const MIN_LIQUIDITY_LOCK_PERCENT = 95;
const MIN_POOL_AGE_MS = 15 * 60 * 1000;
const MIN_TRANSACTIONS_5M = 30;
const MIN_VOLUME_5M_USD = 5000;
const MIN_BUY_RATIO_5M = 0.55;
const MAX_TOP10_PERCENT = 35;
const MIN_PRICE_CHANGE_5M = 0;

async function evaluateCandidate(candidate, { signal, mintSafety = getMintSafety, holderConcentration = getHolderConcentration } = {}) {
  const reject = (reason, details = {}) => ({ accepted: false, reason, details });
  const priceChange5m = Number(candidate.priceChange5m);
  if (!Number.isFinite(priceChange5m)) return reject("5m Price Trend Unverified");
  if (priceChange5m <= MIN_PRICE_CHANGE_5M)
    return reject("5m Momentum Not Positive", { priceChange5m, minimumExclusive: MIN_PRICE_CHANGE_5M });
  const liquidity = Number(candidate.liquidityUsd);
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD)
    return reject("Low Liquidity", { liquidityUsd: liquidity || 0, minimum: MIN_LIQUIDITY_USD });

  let liquidityLock;
  try { liquidityLock = await getLiquidityLock(candidate.tokenAddress, signal); }
  catch (error) { return reject("Liquidity Lock Check Failed", { error: error.message }); }
  if (!liquidityLock?.verified || !Number.isFinite(Number(liquidityLock.lockedPercent)))
    return reject("Liquidity Lock Unverified");
  if (Number(liquidityLock.lockedPercent) < MIN_LIQUIDITY_LOCK_PERCENT)
    return reject("Liquidity Lock Below 95%", { lockedPercent: Number(liquidityLock.lockedPercent), minimum: MIN_LIQUIDITY_LOCK_PERCENT });

  const created = Date.parse(candidate.poolCreatedAt || "");
  if (!Number.isFinite(created)) return reject("Pool Age Unverified");
  const age = Date.now() - created;
  if (age < MIN_POOL_AGE_MS)
    return reject("Pool Age Below 15 Minutes", { ageMs: age, minimum: MIN_POOL_AGE_MS });

  const buys = Number(candidate.buys5m) || 0;
  const sells = Number(candidate.sells5m) || 0;
  const tx = buys + sells;
  if (tx < MIN_TRANSACTIONS_5M) return reject("Low 5m Activity", { transactions5m: tx, minimum: MIN_TRANSACTIONS_5M });
  const volume5m = Number(candidate.volume5m);
  if (!Number.isFinite(volume5m) || volume5m < MIN_VOLUME_5M_USD)
    return reject("Low 5m Volume", { volume5mUsd: volume5m || 0, minimum: MIN_VOLUME_5M_USD });
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

  return {
    accepted: true,
    reason: "Solana pair passed Gemini safety checks",
    details: { dexId: candidate.dexId || null, liquidityUsd: liquidity, liquidityLockedPercent: Number(liquidityLock.lockedPercent), poolAgeMs: age, transactions5m: tx, volume5mUsd: volume5m, buyRatio, priceChange5m, top10Percent: Number(holders.top10Percent) },
    mintSafety: mint
  };
}

module.exports = {
  evaluateCandidate,
  MIN_LIQUIDITY_USD,
  MIN_LIQUIDITY_LOCK_PERCENT,
  MIN_POOL_AGE_MS,
  MIN_TRANSACTIONS_5M,
  MIN_BUY_RATIO_5M,
  MAX_TOP10_PERCENT,
  MIN_VOLUME_5M_USD,
};
