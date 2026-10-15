'use strict';

const NOT_ENOUGH_DATA = 'NOT ENOUGH DATA';

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = number(value);
    if (n !== null) return n;
  }
  return null;
}

function normalizeTrade(trade, system = 'unknown', mode = 'PAPER') {
  const sells = Array.isArray(trade.sells) ? trade.sells : [];
  const pnl = firstNumber(trade.pnl, trade.pnlUsd, trade.realizedPnl);
  const invested = firstNumber(trade.amountInvested, trade.invested, trade.investedUsd, trade.costBasisUsd, trade.amountInvestedUsd, trade.originalAmountInvested);
  const exitTime = trade.exitTime || sells[sells.length - 1]?.exitTime || sells[sells.length - 1]?.time || null;
  const entryTime = trade.entryTime || (trade.type === 'BUY' ? trade.time : null) || null;
  const holdMs = entryTime && exitTime ? Math.max(0, Date.parse(exitTime) - Date.parse(entryTime)) : null;
  const reason = Array.isArray(trade.exitReasons) ? trade.exitReasons.join(', ') : (trade.exitReason || trade.reason || null);
  return {
    ...trade,
    saleValue: firstNumber(trade.saleValue, trade.saleValueUsd, trade.amountReceived, trade.amountUsd),
    system,
    mode,
    pnl,
    invested,
    returnPercent: firstNumber(trade.pnlPercent, trade.returnPercent, invested && pnl !== null ? pnl / invested * 100 : null),
    entryTime,
    exitTime,
    holdMs: number(trade.holdTimeMs) ?? holdMs,
    entryReason: trade.entrySignal || trade.entryReason || (trade.entryReasons || []).join(', ') || null,
    exitReason: reason,
    token: trade.symbol || trade.tokenSymbol || '-',
    tokenAddress: trade.tokenAddress || '',
    positionId: trade.positionId || trade.id || ''
  };
}

function tradeMetrics(trades) {
  const valid = trades.filter(t => t.pnl !== null);
  const wins = valid.filter(t => t.pnl > 0);
  const losses = valid.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0);
  const returns = valid.map(t => t.returnPercent).filter(Number.isFinite);
  const hold = valid.map(t => t.holdMs).filter(Number.isFinite);
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const best = valid.length ? Math.max(...valid.map(t => t.pnl)) : null;
  const worst = valid.length ? Math.min(...valid.map(t => t.pnl)) : null;
  const invested = valid.reduce((s, t) => s + (t.invested || 0), 0);
  return {
    trades: valid.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: valid.filter(t => t.pnl === 0).length,
    winRate: valid.length ? wins.length / valid.length * 100 : null,
    grossProfit: valid.length ? grossProfit : null,
    grossLoss: valid.length ? grossLoss : null,
    netPnl: valid.length ? grossProfit - grossLoss : null,
    returnPercent: invested > 0 ? (grossProfit - grossLoss) / invested * 100 : null,
    averageTrade: avg(valid.map(t => t.pnl)),
    averageWin: avg(wins.map(t => t.pnl)),
    averageLoss: avg(losses.map(t => t.pnl)),
    averageReturn: avg(returns),
    averageHoldMs: avg(hold),
    capitalDeployed: valid.length ? invested : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null),
    bestTrade: best,
    worstTrade: worst
  };
}

function realizedSellEvents(rows) {
  const events = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = String(row?.type || '').toUpperCase();
    const sells = Array.isArray(row?.sells) ? row.sells : [];
    if (type === 'SELL') {
      const time = row.exitTime || row.time || row.timestamp || null;
      const pnl = number(row.pnl ?? row.netPnl ?? row.realizedPnl);
      if (time && pnl !== null) events.push({ ...row, time, exitTime: time, pnl });
      continue;
    }
    if (sells.length) {
      for (const sell of sells) {
        const time = sell.exitTime || sell.time || row.exitTime || null;
        const pnl = number(sell.pnl ?? sell.netPnl);
        if (time && pnl !== null) events.push({ ...sell, system: row.system, systemId: row.systemId, time, exitTime: time, pnl });
      }
      continue;
    }
    // Legacy feeds expose one row per closed position instead of SELL ledger rows.
    if (type === 'CLOSED TRADE' || type === 'TRADE') {
      const time = row.exitTime || row.time || null;
      const pnl = number(row.pnl ?? row.netPnl ?? row.realizedPnl);
      if (time && pnl !== null) events.push({ ...row, time, exitTime: time, pnl });
    }
  }
  return events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function pnlEvents(trades) {
  const events = [];
  for (const trade of trades) {
    const sells = Array.isArray(trade.sells) ? trade.sells : [];
    if (sells.length) {
      for (const sell of sells) {
        const time = sell.exitTime || sell.time || trade.exitTime;
        const pnl = number(sell.pnl);
        if (time && pnl !== null) events.push({ time, pnl, system: trade.system, trade });
      }
    } else if (trade.exitTime && trade.pnl !== null) {
      events.push({ time: trade.exitTime, pnl: trade.pnl, system: trade.system, trade });
    }
  }
  return events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, ...tradeMetrics(rows) }));
}

function groupByExitReason(trades) {
  const expanded = [];
  for (const trade of trades) {
    const sells = Array.isArray(trade.sells) ? trade.sells : [];
    if (sells.length) {
      for (const sell of sells) expanded.push({ ...trade, pnl: number(sell.pnl), returnPercent: number(sell.pnlPercent), exitReason: sell.reason || 'Unspecified', holdMs: trade.holdMs });
    } else expanded.push({ ...trade, exitReason: trade.exitReason || 'Unspecified' });
  }
  return groupBy(expanded, t => t.exitReason);
}

function dailyPnl(trades, timezone = 'America/Puerto_Rico') {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const daily = new Map();
  for (const event of pnlEvents(trades)) {
    const day = formatter.format(new Date(event.time));
    daily.set(day, (daily.get(day) || 0) + event.pnl);
  }
  return [...daily.entries()].map(([date, pnl]) => ({ date, pnl })).sort((a, b) => a.date.localeCompare(b.date));
}

function byHour(trades, timezone = 'America/Puerto_Rico') {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, '0') + ':00', pnl: 0, trades: 0 }));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  for (const event of pnlEvents(trades)) {
    const hour = Number(fmt.format(new Date(event.time)));
    if (Number.isInteger(hour) && buckets[hour]) { buckets[hour].pnl += event.pnl; buckets[hour].trades++; }
  }
  return buckets;
}

function byWeekday(trades, timezone = 'America/Puerto_Rico') {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const buckets = names.map(label => ({ label, pnl: 0, trades: 0 }));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  for (const event of pnlEvents(trades)) {
    const name = fmt.format(new Date(event.time));
    const bucket = buckets.find(b => b.label === name);
    if (bucket) { bucket.pnl += event.pnl; bucket.trades++; }
  }
  return buckets;
}

function filterRange(trades, range = 'ALL', now = Date.now()) {
  if (range === 'ALL') return trades;
  const days = ({ '1D': 1, '7D': 7, '30D': 30, '90D': 90 })[range];
  if (!days) return trades;
  const start = now - days * 86400000;
  return trades.filter(t => {
    const date = Date.parse(t.exitTime);
    return Number.isFinite(date) && date >= start;
  });
}

function drawdownFromRealizedPnl(trades) {
  const events = pnlEvents(trades);
  if (events.length < 2) return null;
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const event of events) {
    equity += event.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return { maxDrawdown, currentDrawdown: peak - equity, basis: 'CUMULATIVE REALIZED P&L' };
}

var OneCoinAnalytics = {
  NOT_ENOUGH_DATA, normalizeTrade, tradeMetrics, realizedSellEvents, pnlEvents, groupBy,
  groupByExitReason, dailyPnl, byHour, byWeekday, filterRange, drawdownFromRealizedPnl
};
if (typeof module !== 'undefined' && module.exports) module.exports = OneCoinAnalytics;
if (typeof window !== 'undefined') window.OneCoinAnalytics = OneCoinAnalytics;

