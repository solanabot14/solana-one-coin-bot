function createRecoveryWatchlist({ maxAgeMs, maxSize, minimumLiquidityUsd, minimumVolume5mUsd }) {
  const items = new Map();

  function keyFor(coin) {
    return String(coin?.tokenAddress || "") + ":" + String(coin?.pairAddress || "");
  }

  function isPromising(coin) {
    const pattern = coin?.momentumPattern || {};
    return (pattern.ready === true || pattern.recovering === true ||
        (pattern.pumpSeen === true && pattern.pullbackObserved === true)) &&
      Number(coin?.liquidityUsd) >= minimumLiquidityUsd &&
      Number(coin?.volume5m) >= minimumVolume5mUsd;
  }

  function remember(coin, now = Date.now()) {
    if (!isPromising(coin)) return false;
    const key = keyFor(coin);
    if (!key || key === ":") return false;
    const existing = items.get(key);
    if (!existing && items.size >= maxSize) {
      const oldest = [...items.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt)[0];
      if (oldest) items.delete(oldest[0]);
    }
    items.set(key, { addedAt: existing?.addedAt || now, lastSeenAt: now,
      tokenAddress: coin.tokenAddress, pairAddress: coin.pairAddress, lastSnapshot: coin,
      directRechecks: existing?.directRechecks || 0 });
    return true;
  }

  function missing(currentKeys, now = Date.now()) {
    const result = [];
    for (const [key, item] of items) {
      if (now - item.addedAt > maxAgeMs) {
        items.delete(key);
      } else if (!currentKeys.has(key)) {
        result.push({ key, ...item });
      }
    }
    return result;
  }

  function recordDirectRecheck(key, coin, now = Date.now()) {
    const item = items.get(key);
    if (!item) return;
    item.lastSnapshot = coin;
    item.lastSeenAt = now;
    item.directRechecks++;
  }

  return { remember, missing, recordDirectRecheck, remove: key => items.delete(key),
    size: () => items.size, values: () => [...items.values()] };
}

module.exports = { createRecoveryWatchlist };
