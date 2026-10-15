// A slow historical provider must never hold up the live price scan.
function createHistoricalHydrator({ tracker, data, clock = Date.now, warn = console.warn }) {
  let pending = null;
  function schedule(coin, options = {}) {
    if (pending || options.signal?.aborted || tracker.hasHistorical(coin) || !data.canFetchHistorical(coin)) return false;
    const snapshot = { ...coin };
    pending = Promise.resolve().then(() => data.getHistoricalCandles(snapshot, options))
      .then(candles => { if (!options.signal?.aborted) tracker.hydrate(snapshot, candles, clock()); })
      .catch(error => warn("PROFIT SNIPER BACKGROUND HISTORY PENDING | " + snapshot.pairAddress + " | " + error.message))
      .finally(() => { pending = null; });
    return true;
  }
  return { schedule, isPending: () => !!pending };
}
module.exports = { createHistoricalHydrator };
