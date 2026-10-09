"use strict";

const LOSS_STREAK_LIMIT = 2;
const RECOVERY_MIN_MOMENTUM_5M = 0.5;
const RECOVERY_MIN_BUY_RATIO = 0.55;
const RECOVERY_MIN_VOLUME_RETENTION = 0.75;
const RECOVERY_SCAN_WINDOW_MULTIPLIER = 2.5;

function completedTrades(history = []) {
  const byPosition = new Map();
  const completed = [];
  let order = 0;

  for (const trade of Array.isArray(history) ? history : []) {
    if (!trade || !["BUY", "SELL"].includes(trade.type)) continue;
    const positionId = String(trade.positionId || trade.id || "");
    const tokenAddress = trade.tokenAddress;
    if (!positionId || !tokenAddress) continue;

    let position = byPosition.get(positionId);
    if (!position) {
      position = { tokenAddress, pnl: 0, sells: 0, order: order++, exitTime: null };
      byPosition.set(positionId, position);
    }
    position.tokenAddress = tokenAddress;

    if (trade.type !== "SELL") continue;
    position.pnl += Number(trade.pnl) || 0;
    position.sells += 1;
    position.exitTime = trade.exitTime || trade.time || trade.timestamp || position.exitTime;
    if (Number(trade.percentSold) >= 99.999) {
      completed.push({ ...position, order: order++ });
      byPosition.delete(positionId);
    }
  }

  return completed.sort((a, b) => {
    const at = Date.parse(a.exitTime || "");
    const bt = Date.parse(b.exitTime || "");
    return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? at - bt : a.order - b.order;
  });
}

function getConsecutiveLosses(history, tokenAddress) {
  if (!tokenAddress) return 0;
  const tokenTrades = completedTrades(history).filter(trade => trade.tokenAddress === tokenAddress);
  let streak = 0;
  for (let i = tokenTrades.length - 1; i >= 0; i -= 1) {
    if (!(tokenTrades[i].pnl < 0)) break;
    streak += 1;
  }
  return streak;
}

function createTokenLossGuard({
  getHistory = () => [],
  scannerIntervalMs = 30000,
  now = () => Date.now(),
  logger = console
} = {}) {
  const observations = new Map();

  function lossStreak(tokenAddress) {
    return getConsecutiveLosses(getHistory(), tokenAddress);
  }

  function allows(coin) {
    const tokenAddress = coin?.tokenAddress;
    if (!tokenAddress) return true;

    const streak = lossStreak(tokenAddress);
    if (streak < LOSS_STREAK_LIMIT) {
      observations.delete(tokenAddress);
      return true;
    }

    const buys = Number(coin.buys5m) || 0;
    const sells = Number(coin.sells5m) || 0;
    const transactions = buys + sells;
    const buyRatio = transactions > 0 ? buys / transactions : 0;
    const momentum5m = Number(coin.priceChange5m) || 0;
    const volume5m = Number(coin.volume5m) || 0;
    const hasRecoveryMomentum =
      momentum5m >= RECOVERY_MIN_MOMENTUM_5M &&
      buys > sells &&
      buyRatio >= RECOVERY_MIN_BUY_RATIO &&
      volume5m > 0;

    if (!hasRecoveryMomentum) {
      observations.delete(tokenAddress);
      logger.log?.(`TOKEN LOSS LOCK | ${coin.symbol || tokenAddress} | ${streak} consecutive losing trades | skipping without recovery momentum`);
      return false;
    }

    const current = { at: now(), momentum5m, volume5m };
    const previous = observations.get(tokenAddress);
    const confirmed =
      previous &&
      current.at - previous.at <= scannerIntervalMs * RECOVERY_SCAN_WINDOW_MULTIPLIER &&
      current.volume5m >= previous.volume5m * RECOVERY_MIN_VOLUME_RETENTION &&
      current.momentum5m >= previous.momentum5m - 0.5;

    if (!confirmed) {
      observations.set(tokenAddress, current);
      logger.log?.(`TOKEN LOSS LOCK | ${coin.symbol || tokenAddress} | recovery check 1/2; waiting for sustained momentum`);
      return false;
    }

    observations.delete(tokenAddress);
    logger.log?.(`TOKEN LOSS LOCK | ${coin.symbol || tokenAddress} | released after two recovery scans`);
    return true;
  }

  return { allows, lossStreak };
}

module.exports = { completedTrades, getConsecutiveLosses, createTokenLossGuard };
