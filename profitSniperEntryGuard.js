const axios = require("axios");
const { getMomentumFailureReasons, constants } = require("./profitSniperStrategy");
const CONFIG = require("./profitSniperConfig");

const MAX_OBSERVATION_GAP_MS = 75_000;
const MIN_LIQUIDITY_RETENTION = 0.90;
const MIN_PRICE_RETENTION = 0.90;
const MAX_PRICE_INCREASE = 1.15;
const MIN_REPORT_RESERVE_RATIO = 0.75;
const MIN_LOCKED_PERCENT = CONFIG.MIN_LP_LOCK_PERCENT;

function hasCatastrophicLoss(history, tokenAddress) {
  return (Array.isArray(history) ? history : []).some(row =>
    row?.type === "SELL" && row.tokenAddress === tokenAddress &&
    (/WRITE-OFF/i.test(row.reason || "") ||
      (Number(row.entryPrice) > 0 && Number(row.exitPrice) >= 0 &&
        Number(row.exitPrice) <= Number(row.entryPrice) / 2))
  );
}

function isLiquidityBurned(report, market) {
  const lp = market?.lp || {};
  return lp.burned === true || lp.lpBurned === true || market?.lpBurned === true ||
    report?.lpBurned === true || Number(lp.lpBurnedPct) >= 99.99 ||
    Number(market?.lpBurnedPct) >= 99.99;
}

function holderConcentration(report) {
  const holders = Array.isArray(report?.topHolders) ? report.topHolders
    : Array.isArray(report?.tokenHolders) ? report.tokenHolders
    : Array.isArray(report?.holders) ? report.holders : null;
  if (!holders || holders.length < 1) return { verified: false, top10Percent: null, largestPercent: null };
  const percentages = holders.slice(0, 10).map(holder => {
    const raw = holder?.pct ?? holder?.percentage ?? holder?.percent;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : NaN;
  });
  if (percentages.some(value => !Number.isFinite(value)))
    return { verified: false, top10Percent: null, largestPercent: null };
  return { verified: true, top10Percent: percentages.reduce((sum, value) => sum + value, 0),
    largestPercent: Math.max(...percentages) };
}

function tokenAuthoritiesRenounced(report) {
  const token = report?.token || {};
  const mintAuthority = token.mintAuthority !== undefined ? token.mintAuthority : report?.mintAuthority;
  const freezeAuthority = token.freezeAuthority !== undefined ? token.freezeAuthority : report?.freezeAuthority;
  const renounced = value => value === null || value === "" || value === false;
  return { mintRenounced: renounced(mintAuthority), freezeRenounced: renounced(freezeAuthority) };
}

function evaluatePoolReport(report, coin, liquidityUsd) {
  if (!report || report.mint !== coin.tokenAddress || report.rugged === true) return "RugCheck report unavailable or flagged";
  const market = (Array.isArray(report.markets) ? report.markets : [])
    .find(item => item.pubkey === coin.pairAddress);
  if (!market) return "RugCheck did not verify the exact pool";
  const authorities = tokenAuthoritiesRenounced(report);
  if (!authorities.mintRenounced) return "Mint authority is active or unverified";
  if (!authorities.freezeRenounced) return "Freeze authority is active or unverified";
  const holders = holderConcentration(report);
  if (!holders.verified) return "Top-holder concentration is unavailable";
  if (holders.top10Percent > CONFIG.MAX_TOP10_HOLDER_PERCENT)
    return "Top 10 holders exceed 35%";
  if (holders.largestPercent > CONFIG.MAX_SINGLE_HOLDER_PERCENT)
    return "A holder exceeds 8%";
  const lp = market.lp || {};
  const reserveUsd = Number(lp.baseUSD) + Number(lp.quoteUSD);
  const burned = isLiquidityBurned(report, market);
  const lockedPercent = Number(lp.lpLockedPct);
  const lockedUsd = Number(lp.lpLockedUSD);
  if (!Number.isFinite(reserveUsd) || reserveUsd < CONFIG.MIN_LIQUIDITY_USD ||
      reserveUsd < liquidityUsd * MIN_REPORT_RESERVE_RATIO) return "RugCheck pool reserve is too low or disagrees with DexScreener";
  if (!burned && (!Number.isFinite(lockedPercent) || lockedPercent < MIN_LOCKED_PERCENT || lockedPercent > 100 ||
      !Number.isFinite(lockedUsd) || lockedUsd < reserveUsd * MIN_LOCKED_PERCENT / 100 * MIN_REPORT_RESERVE_RATIO)) {
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
  let lastSecurityDiagnostics = null;

  function pruneStaleObservations(now = clock()) {
    for (const [key, item] of observations) {
      if (now - item.lastAt > 2 * MAX_OBSERVATION_GAP_MS) observations.delete(key);
    }
  }

  function observe(coin, now = clock()) {
    pruneStaleObservations(now);
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
    const ready = next.count >= CONFIG.MIN_STABLE_POOL_OBSERVATIONS && now - next.firstAt >= CONFIG.MIN_STABLE_POOL_SPAN_MS;
    return { ready, reason: reset && previous ? "liquidity or price fell during observation" :
      ready ? null : "waiting for stable pool observations", observations: next.count };
  }

  function getStatus(now = clock()) {
    pruneStaleObservations(now);
    const waiting = [];
    for (const [key, item] of observations) {
      const waitedMs = Math.max(0, now - item.firstAt);
      if (item.count < CONFIG.MIN_STABLE_POOL_OBSERVATIONS ||
          waitedMs < CONFIG.MIN_STABLE_POOL_SPAN_MS) {
        const [tokenAddress, pairAddress] = key.split(":");
        waiting.push({ tokenAddress, pairAddress, observations: item.count, waitedMs });
      }
    }
    return {
      requiredObservations: CONFIG.MIN_STABLE_POOL_OBSERVATIONS,
      minimumSpanMs: CONFIG.MIN_STABLE_POOL_SPAN_MS,
      waitingCandidates: waiting.length,
      longestWaitMs: waiting.reduce((longest, item) => Math.max(longest, item.waitedMs), 0),
      candidates: waiting
    };
  }

  async function validate(coin, { signal, portfolio } = {}) {
    if (hasCatastrophicLoss(portfolio?.history, coin?.tokenAddress)) {
      return { allowed: false, reason: "previous catastrophic loss for this mint" };
    }
    const observed = observations.get(coin?.tokenAddress + ":" + coin?.pairAddress);
    if (!observed || observed.count < CONFIG.MIN_STABLE_POOL_OBSERVATIONS ||
        clock() - observed.firstAt < CONFIG.MIN_STABLE_POOL_SPAN_MS ||
        clock() - observed.lastAt > MAX_OBSERVATION_GAP_MS) {
      return { allowed: false, reason: "exact pool did not hold liquidity across two scans" };
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
    const holders = holderConcentration(report);
    const authorities = tokenAuthoritiesRenounced(report);
    lastSecurityDiagnostics = {
      tokenAddress: coin.tokenAddress,
      pairAddress: coin.pairAddress,
      checkedAt: new Date(clock()).toISOString(),
      top10HoldersPercent: holders.top10Percent,
      largestHolderPercent: holders.largestPercent,
      holderConcentrationVerified: holders.verified,
      mintAuthorityRenounced: authorities.mintRenounced,
      freezeAuthorityRenounced: authorities.freezeRenounced
    };
    const poolRisk = evaluatePoolReport(report, coin, liquidity);
    if (poolRisk) return { allowed: false, reason: poolRisk };
    return { allowed: true, coin: { ...fresh,
      reasons: [...(coin.reasons || []), "Fresh exact-pool quote and RugCheck pool reserve verified immediately before paper entry"] } };
  }

  return { observe, validate, getStatus, getSecurityDiagnostics: () => lastSecurityDiagnostics };
}

module.exports = { createSniperEntryGuard, hasCatastrophicLoss, evaluatePoolReport, holderConcentration, tokenAuthoritiesRenounced, isLiquidityBurned };

