const WINDOW_MS = 48 * 60 * 60 * 1000;

function puertoRicoDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Puerto_Rico", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function isWatchlistTrade(row) {
  return Array.isArray(row?.entryReasons) && row.entryReasons.includes("AGE WATCHLIST REENTRY");
}

function buildProfitSniper48h(portfolio, rejectionEvents = [], now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  const history = Array.isArray(portfolio?.history) ? portfolio.history : [];
  const entries = history.filter(row => row?.type === "BUY" && Date.parse(row.entryTime) >= cutoff);
  const exits = history.filter(row => row?.type === "SELL" && Date.parse(row.exitTime) >= cutoff);
  const entriesByDay = {};
  for (const row of entries) {
    const day = puertoRicoDay(row.entryTime);
    if (day) entriesByDay[day] = (entriesByDay[day] || 0) + 1;
  }

  const openIds = new Set((portfolio?.positions || []).map(row => row.positionId || row.id));
  const closedIds = new Set(exits.map(row => row.positionId).filter(id => id && !openIds.has(id)));
  const closed = [...closedIds].map(positionId => {
    const rows = history.filter(row => row?.type === "SELL" && row.positionId === positionId);
    return { positionId, pnl: rows.reduce((sum, row) => sum + (Number(row.netPnl ?? row.pnl) || 0), 0),
      watchlist: rows.some(isWatchlistTrade) };
  });
  const watchlistClosed = closed.filter(row => row.watchlist);
  const otherClosed = closed.filter(row => !row.watchlist);
  const writeOffs = exits.filter(row => /NO LIQUIDITY|WRITE-OFF|UNEXECUTABLE/i.test(String(row.reason || "")) ||
    row.exitPriceSource === "NO_LIQUIDITY_WRITE_OFF");

  const windowEvents = rejectionEvents.filter(event => Number(event?.at) >= cutoff);
  const rejectionCounts = {};
  for (const event of windowEvents) for (const [reason, count] of Object.entries(event.counts || {}))
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + (Number(count) || 0);

  return {
    windowHours: 48,
    timezone: "America/Puerto_Rico",
    from: new Date(cutoff).toISOString(),
    to: new Date(now).toISOString(),
    entries: { total: entries.length, byDay: entriesByDay,
      fromWatchlist: entries.filter(isWatchlistTrade).length },
    rejections: rejectionCounts,
    closedTrades: { total: closed.length,
      wins: closed.filter(row => row.pnl > 0).length,
      winRatePercent: closed.length ? closed.filter(row => row.pnl > 0).length / closed.length * 100 : null },
    pnlAfterCostsUsd: exits.reduce((sum, row) => sum + (Number(row.netPnl ?? row.pnl) || 0), 0),
    pnlByEntrySourceUsd: {
      watchlist: watchlistClosed.reduce((sum, row) => sum + row.pnl, 0),
      other: otherClosed.reduce((sum, row) => sum + row.pnl, 0)
    },
    noLiquidityOrWriteOff: { count: writeOffs.length,
      lossUsd: writeOffs.reduce((sum, row) => sum + Math.min(0, Number(row.netPnl ?? row.pnl) || 0), 0) }
  };
}

module.exports = { WINDOW_MS, buildProfitSniper48h };
