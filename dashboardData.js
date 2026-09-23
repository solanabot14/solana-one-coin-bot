function groupCompletedTrades(history = [], position = null) {
  const groups = new Map();
  const key = trade => `${trade.tokenAddress || trade.symbol}-${trade.entryTime}`;
  for (const trade of history) {
    if (!trade.entryTime) continue;
    const id = key(trade);
    if (!groups.has(id)) groups.set(id, {
      symbol: trade.symbol || "-", name: trade.name || "-", tokenAddress: trade.tokenAddress || "",
      entryTime: trade.entryTime, entryPrice: Number(trade.entryPrice || 0),
      amountInvested: 0, quantityBought: 0, quantitySold: 0,
      saleValue: 0, pnl: 0, exitTime: null, sells: []
    });
    const group = groups.get(id);
    if (trade.type === "BUY") {
      group.amountInvested += Number(trade.amountInvested || 0);
      group.quantityBought += Number(trade.quantity || 0);
    }
    if (trade.type === "SELL") {
      group.saleValue += Number(trade.saleValue || 0);
      group.pnl += Number(trade.pnl || 0);
      group.quantitySold += Number(trade.quantitySold || 0);
      group.exitTime = trade.exitTime;
      group.sells.push(trade);
    }
  }
  return [...groups.entries()].filter(([id, g]) => {
    if (position && id === key(position)) return false;
    return g.quantityBought > 0 && g.sells.length > 0 &&
      (g.sells.some(s => Number(s.percentSold) === 100) ||
       g.quantitySold >= g.quantityBought * (1 - 1e-10));
  }).map(([, g]) => ({ ...g,
    exitPrice: g.quantitySold > 0 ? g.saleValue / g.quantitySold : null,
    pnlPercent: g.amountInvested > 0 ? g.pnl / g.amountInvested * 100 : 0
  })).sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime));
}

async function buildDashboardData(data, getTokenData) {
  const completedTrades = groupCompletedTrades(data.history, data.position);
  let live = null;
  if (data.position) {
    const fresh = await getTokenData(data.position.tokenAddress);
    const price = Number(fresh?.priceUsd);
    if (Number.isFinite(price) && price > 0) {
      const p = data.position;
      const currentValue = p.quantity * price;
      const pnl = currentValue - p.amountInvested;
      live = { currentPrice: price, currentValue, pnl,
        pnlPercent: pnl / p.amountInvested * 100, priceChange5m: fresh.priceChange5m,
        highestPrice: p.highestPrice, pairAddress: fresh.pairAddress };
    }
  }
  const grossProfit = completedTrades.reduce((s, t) => s + Math.max(t.pnl, 0), 0);
  const grossLoss = completedTrades.reduce((s, t) => s + Math.max(-t.pnl, 0), 0);
  const winners = completedTrades.filter(t => t.pnl > 0).length;
  const equity = data.position && !live ? null : data.cashBalance + (live?.currentValue || 0);
  return { ...data, live, equity, totalPnl: equity === null ? null : equity - data.startingBalance,
    priceUnavailable: !!data.position && !live, completedTrades,
    stats: {
      completedTrades: completedTrades.length, winners,
      losers: completedTrades.filter(t => t.pnl < 0).length,
      winRate: completedTrades.length ? winners / completedTrades.length * 100 : 0,
      netPnl: grossProfit - grossLoss, grossProfit, grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      profitFactorLabel: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "—"
    }
  };
}
module.exports = { groupCompletedTrades, buildDashboardData };
