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

function buildNext25Review(portfolio, strategyVersion, target = 25) {
  const history = Array.isArray(portfolio?.history) ? portfolio.history : [];
  const openIds = new Set((portfolio?.positions || []).map(position => position.positionId || position.id));
  const buysById = new Map();
  const sellsById = new Map();
  for (const row of history) {
    if (row?.strategyVersion !== strategyVersion || !row.positionId) continue;
    if (row.type === "BUY") buysById.set(row.positionId, row);
    if (row.type === "SELL") {
      const rows = sellsById.get(row.positionId) || [];
      rows.push(row);
      sellsById.set(row.positionId, rows);
    }
  }

  const completed = [];
  for (const [positionId, entry] of buysById) {
    const sells = (sellsById.get(positionId) || [])
      .slice().sort((a, b) => Date.parse(a.exitTime || 0) - Date.parse(b.exitTime || 0));
    if (!sells.length || openIds.has(positionId)) continue;
    const finalExit = sells.at(-1);
    completed.push({
      positionId,
      exitTime: finalExit.exitTime || null,
      pnl: sells.reduce((sum, row) => sum + (Number(row.netPnl ?? row.pnl) || 0), 0),
      finalExitReason: finalExit.reason || "not recorded",
      hardStopAudits: sells.filter(row => /HARD STOP/i.test(String(row.reason || ""))),
      entryTime: entry.entryTime || null
    });
  }
  completed.sort((a, b) => Date.parse(a.exitTime || 0) - Date.parse(b.exitTime || 0));
  const sample = completed.slice(0, target);
  const winners = sample.filter(row => row.pnl > 0);
  const losses = sample.filter(row => row.pnl < 0);
  const reasonTotals = {};
  for (const row of sample) {
    const item = reasonTotals[row.finalExitReason] || { trades: 0, netPnlUsd: 0 };
    item.trades++;
    item.netPnlUsd += row.pnl;
    reasonTotals[row.finalExitReason] = item;
  }
  const stopAudits = sample.flatMap(row => row.hardStopAudits);
  const recordedStopAudits = stopAudits.filter(row => Number.isFinite(Number(row.fillVsTriggerPercent)));
  const stopFillGaps = recordedStopAudits.map(row => Number(row.fillVsTriggerPercent));
  const grossWins = winners.reduce((sum, row) => sum + row.pnl, 0);
  const grossLosses = losses.reduce((sum, row) => sum + row.pnl, 0);

  return {
    strategyVersion,
    targetTrades: target,
    closedTrades: sample.length,
    remainingTrades: Math.max(0, target - sample.length),
    complete: sample.length >= target,
    startedAt: sample[0]?.entryTime || null,
    lastClosedAt: sample.at(-1)?.exitTime || null,
    netPnlUsd: sample.reduce((sum, row) => sum + row.pnl, 0),
    wins: winners.length,
    losses: losses.length,
    winRatePercent: sample.length ? winners.length / sample.length * 100 : null,
    profitFactor: grossLosses < 0 ? grossWins / Math.abs(grossLosses) : (grossWins > 0 ? null : 0),
    finalExitReasons: Object.fromEntries(Object.entries(reasonTotals).map(([reason, metrics]) =>
      [reason, { trades: metrics.trades, netPnlUsd: Number(metrics.netPnlUsd.toFixed(6)) }])),
    hardStopFillAudit: {
      exits: stopAudits.length,
      exitsWithTriggerAndFill: recordedStopAudits.length,
      missingTriggerOrFill: stopAudits.length - recordedStopAudits.length,
      averageFillVsTriggerPercent: stopFillGaps.length
        ? stopFillGaps.reduce((sum, value) => sum + value, 0) / stopFillGaps.length : null,
      worstFillVsTriggerPercent: stopFillGaps.length ? Math.min(...stopFillGaps) : null
    }
  };
}

module.exports = { WINDOW_MS, buildProfitSniper48h, buildNext25Review };
