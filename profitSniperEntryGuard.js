const axios = require("axios");
const { getMomentumFailureReasons, constants } = require("./profitSniperStrategy");

const MIN_OBSERVATIONS = 3;
const MIN_OBSERVATION_SPAN_MS = 45_000;
const MAX_OBSERVATION_GAP_MS = 75_000;
const MIN_LIQUIDITY_RETENTION = 0.90;
const MIN_PRICE_RETENTION = 0.90;
const MAX_PRICE_INCREASE = 1.15;
const MIN_REPORT_RESERVE_RATIO = 0.75;
const MIN_LOCKED_PERCENT = 70;

function hasCatastrophicLoss(history, tokenAddress) {
  return (Array.isArray(history) ? history : []).some(row =>
    row?.type === "SELL" && row.tokenAddress === tokenAddress &&
    (/WRITE-OFF/i.test(row.reason || "") ||
      (Number(row.entryPrice) > 0 && Number(row.exitPrice) >= 0 &&
        Number(row.exitPrice) <= Number(row.entryPrice) / 2))
  );
}

function evaluatePoolReport(report, coin, liquidityUsd) {
  if (!report || report.mint !== coin.tokenAddress || report.rugged === true) return "RugCheck report unavailable or flagged";
  const market = (Array.isArray(report.markets) ? report.markets : [])
    .find(item => item.pubkey === coin.pairAddress);
  if (!market) return "RugCheck did not verify the exact pool";
  const lp = market.lp || {};
  const reserveUsd = Number(lp.baseUSD) + Number(lp.quoteUSD);
  const lockedPercent = Number(lp.lpLockedPct);
  const lockedUsd = Number(lp.lpLockedUSD);
  if (!Number.isFinite(reserveUsd) || reserveUsd < constants.MIN_LIQUIDITY_USD ||
      reserveUsd < liquidityUsd * MIN_REPORT_RESERVE_RATIO) return "RugCheck pool reserve is too low or disagrees with DexScreener";
  if (!Number.isFinite(lockedPercent) || lockedPercent < MIN_LOCKED_PERCENT ||
      !Number.isFinite(lockedUsd) || lockedUsd < reserveUsd * MIN_LOCKED_PERCENT / 100 * MIN_REPORT_RESERVE_RATIO) {
    return "Exact pool lock cannot be verified";
  }
  if ((Array.isArray(report.risks) ? report.risks : []).some(risk =>
    /high ownership|single holder ownership/i.test(risk?.name || ""))) {
    return "RugCheck reports concentrated token ownership";
  }
  return null;
}

function refreshedCoin(coin, pair) {
  return {
    ...coin,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidity?.usd,
    volume5m: pair.volume?.m5,
    volume24h: pair.volume?.h24,
    priceChange5m: pair.priceChange?.m5,
    priceChange1h: pair.priceChange?.h1,
    priceChange24h: pair.priceChange?.h24,
    buys5m: pair.txns?.m5?.buys,
    sells5m: pair.txns?.m5?.sells,
    pairCreatedAt: pair.pairCreatedAt,
    chainId: pair.chainId,
    tokenAddress: pair.baseToken?.address,
    pairAddress: pair.pairAddress
  };
}

function createSniperEntryGuard({
  clock = Date.now,
  fetchPair = async (address, signal) => (await axios.get(
    "https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(address),
    { timeout: 10_000, signal }
  )).data?.pairs,
  fetchReport = async (address, signal) => (await axios.get(
    "https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(address) + "/report",
    { timeout: 8_000, signal }
  )).data
} = {}) {
  const observations = new Map();

  function observe(coin, now = clock()) {
    if (!coin?.tokenAddress || !coin.pairAddress) return { ready: false, reason: "missing exact pool identity" };
    const key = coin.tokenAddress + ":" + coin.pairAddress;
    const liquidity = Number(coin.liquidityUsd);
    const price = Number(coin.priceUsd);
    if (!(liquidity >= constants.MIN_LIQUIDITY_USD) || !(price > 0)) {
      observations.delete(key);
      return { ready: false, reason: "invalid liquidity or price" };
    }
    const previous = observations.get(key);
    const reset = !previous || now - previous.lastAt > MAX_OBSERVATION_GAP_MS ||
      liquidity < previous.liquidity * MIN_LIQUIDITY_RETENTION ||
      liquidity < previous.peakLiquidity * MIN_LIQUIDITY_RETENTION ||
      price < previous.price * MIN_PRICE_RETENTION;
    const next = reset
      ? { firstAt: now, lastAt: now, count: 1, liquidity, peakLiquidity: liquidity, price }
      : { firstAt: previous.firstAt, lastAt: now,
          count: previous.count + (now - previous.lastAt >= 20_000 ? 1 : 0),
          liquidity, peakLiquidity: Math.max(previous.peakLiquidity, liquidity), price };
    observations.set(key, next);
    for (const [address, item] of observations) {
      if (now - item.lastAt > 2 * MAX_OBSERVATION_GAP_MS) observations.delete(address);
    }
    const ready = next.count >= MIN_OBSERVATIONS && now - next.firstAt >= MIN_OBSERVATION_SPAN_MS;
    return { ready, reason: reset && previous ? "liquidity or price fell during observation" :
      ready ? null : "waiting for stable pool observations", observations: next.count };
  }

  async function validate(coin, { signal, portfolio } = {}) {
    if (hasCatastrophicLoss(portfolio?.history, coin?.tokenAddress)) {
      return { allowed: false, reason: "previous catastrophic loss for this mint" };
    }
    const observed = observations.get(coin?.tokenAddress + ":" + coin?.pairAddress);
    if (!observed || observed.count < MIN_OBSERVATIONS ||
        clock() - observed.firstAt < MIN_OBSERVATION_SPAN_MS ||
        clock() - observed.lastAt > MAX_OBSERVATION_GAP_MS) {
      return { allowed: false, reason: "exact pool did not hold liquidity across three scans" };
    }
    const [pairs, report] = await Promise.all([
      fetchPair(coin.pairAddress, signal), fetchReport(coin.tokenAddress, signal)
    ]);
    const pair = (Array.isArray(pairs) ? pairs : [])
      .find(item => item.chainId === "solana" && item.pairAddress === coin.pairAddress &&
        item.baseToken?.address === coin.tokenAddress);
    if (!pair) return { allowed: false, reason: "fresh exact pool and mint quote unavailable" };
    const fresh = refreshedCoin(coin, pair);
    const failures = getMomentumFailureReasons(fresh, clock());
    if (failures.length) return { allowed: false, reason: "fresh quote failed: " + failures.join(", ") };
    const liquidity = Number(fresh.liquidityUsd);
    const price = Number(fresh.priceUsd);
    if (!(price > 0) || liquidity < Number(coin.liquidityUsd) * MIN_LIQUIDITY_RETENTION ||
        liquidity < observed.peakLiquidity * MIN_LIQUIDITY_RETENTION ||
        price < Number(coin.priceUsd) * MIN_PRICE_RETENTION ||
        price > Number(coin.priceUsd) * MAX_PRICE_INCREASE) {
      return { allowed: false, reason: "pool liquidity or price changed before purchase" };
    }
    const poolRisk = evaluatePoolReport(report, coin, liquidity);
    if (poolRisk) return { allowed: false, reason: poolRisk };
    return { allowed: true, coin: { ...fresh,
      reasons: [...(coin.reasons || []), "Fresh exact-pool quote and RugCheck pool reserve verified immediately before paper entry"] } };
  }

  return { observe, validate };
}

module.exports = { createSniperEntryGuard, hasCatastrophicLoss, evaluatePoolReport };
