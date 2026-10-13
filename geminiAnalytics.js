function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : null;
}

function buildGeminiAnalytics(state, live = null) {
  const groups = new Map();
  for (const row of state.history || []) {
    if (!row?.positionId) continue;
    if (!groups.has(row.positionId)) groups.set(row.positionId, { positionId: row.positionId, symbol: row.symbol || "Unknown", buys: [], sells: [] });
    const group = groups.get(row.positionId);
    if (row.type === "BUY") group.buys.push(row);
    if (row.type === "SELL") group.sells.push(row);
  }
  const completedTrades = [...groups.values()].filter(g => g.sells.length && !(state.position?.id === g.positionId)).map(g => {
    const buy = g.buys[0] || {};
    const soldQty = g.sells.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
    const saleValue = g.sells.reduce((s, x) => s + (Number(x.amountUsd) || 0), 0);
    const costBasis = g.sells.reduce((s, x) => s + (Number(x.costBasisUsd) || 0), 0);
    const pnlUsd = g.sells.reduce((s, x) => s + (Number(x.pnlUsd) || 0), 0);
    const entryPrice = Number(buy.entryPrice) || Number(g.sells[0].entryPrice) || 0;
    const entryTime = buy.time || buy.entryTime || g.sells[0].entryTime;
    const lastExit = g.sells.reduce((latest, x) => Date.parse(x.time) > Date.parse(latest.time) ? x : latest, g.sells[0]);
    const holdTimeMs = Math.max(0, Date.parse(lastExit.time) - Date.parse(entryTime));
    return {
      positionId: g.positionId, symbol: g.symbol, tokenAddress: buy.tokenAddress || g.sells[0].tokenAddress,
      pairAddress: buy.pairAddress || g.sells[0].pairAddress, entryPrice,
      averageExitPrice: soldQty > 0 ? saleValue / soldQty : null,
      investedUsd: Number(buy.amountUsd) || costBasis,
      saleValueUsd: saleValue, pnlUsd,
      returnPercent: Number(buy.amountUsd) > 0 ? pnlUsd / Number(buy.amountUsd) * 100 : 0,
      maxGainPercent: Math.max(0, ...g.sells.map(x => Number(x.maxGainPercent) || 0)),
      entryTime, exitTime: lastExit.time, holdTimeMs,
      exitReasons: [...new Set(g.sells.map(x => x.reason).filter(Boolean))]
    };
  }).sort((a,b) => Date.parse(b.exitTime) - Date.parse(a.exitTime));

  const winners = completedTrades.filter(t => t.pnlUsd > 0);
  const losers = completedTrades.filter(t => t.pnlUsd < 0);
  const grossProfit = winners.reduce((s,t) => s + t.pnlUsd, 0);
  const grossLoss = losers.reduce((s,t) => s + Math.abs(t.pnlUsd), 0);
  const realizedPnlUsd = grossProfit - grossLoss;
  const position = state.position;
  const equityUsd = Number(state.cashUsd) + (position ? Number(live?.currentValueUsd ?? position.quantity * position.entryPrice) : 0);
  return {
    completedTrades,
    stats: {
      completedTrades: completedTrades.length, winners: winners.length, losers: losers.length,
      winRate: completedTrades.length ? winners.length / completedTrades.length * 100 : 0,
      grossProfit, grossLoss, realizedPnlUsd,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
      profitFactorLabel: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "—",
      averageWinnerUsd: average(winners.map(t => t.pnlUsd)),
      averageLoserUsd: average(losers.map(t => t.pnlUsd)),
      averageWinnerPercent: average(winners.map(t => t.returnPercent)),
      averageLoserPercent: average(losers.map(t => t.returnPercent)),
      averageHoldTimeMs: average(completedTrades.map(t => t.holdTimeMs)),
      averageMaxGainPercent: average(completedTrades.map(t => t.maxGainPercent))
    },
    equityUsd,
    totalPnlUsd: equityUsd - Number(state.startingBalanceUsd)
  };
}
module.exports = { buildGeminiAnalytics };
