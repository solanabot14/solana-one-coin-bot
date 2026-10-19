'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const strategy = 'Pump Lane PAPER · curve 15–90% · TP40%: sell 40%, TP90%: sell 30% · 15% trail after TP1 · −18% stop · 18-minute timeout below +12% · 0.75% slippage per side';
const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
const defaultFile = () => path.join(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname), 'pump-lane-state.json');
function createPumpLaneTrader(file = defaultFile(), io = fs) {
  const start = positive(process.env.PUMP_LANE_START_USD, 200);
  let state = { startingBalance: start, cashBalance: start, position: null, completedTradeRecords: [], history: [], rejections: [], boughtMints: [], lastScanAt: null };
  function valid(s) {
    const finite = x => typeof x === 'number' && Number.isFinite(x);
    return s && finite(s.startingBalance) && s.startingBalance > 0 && finite(s.cashBalance) && s.cashBalance >= 0 &&
      ['completedTradeRecords','history','rejections','boughtMints'].every(k => Array.isArray(s[k])) &&
      (s.position === null || (s.position && typeof s.position.tokenAddress === 'string' && ['entryPrice','quantity','originalQuantity','originalCostUsd','highestPrice','currentPrice','entryAt','proceedsUsd'].every(k => finite(s.position[k])) && s.position.quantity > 0 && s.position.originalQuantity >= s.position.quantity && s.position.entryPrice > 0));
  }
  if (io.existsSync(file)) {
    try { const saved = JSON.parse(io.readFileSync(file, 'utf8')); if (!valid(saved)) throw new Error('Invalid schema'); state = saved; }
    catch (e) { throw new Error('Invalid Pump Lane paper state; refusing to reset: ' + e.message); }
  }
  function commit(next) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try { io.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', flush: true }); io.renameSync(tmp, file); }
    finally { if (io.existsSync(tmp)) io.unlinkSync(tmp); }
    state = next;
  }
  function buy(c, now = Date.now()) {
    const mint = c.tokenAddress || c.mint;
    if (state.position || state.boughtMints.includes(mint)) return { success: false, error: 'Already open / previously bought' };
    const price = Number(c.priceUsd) * 1.0075;
    const size = Math.min(positive(process.env.PUMP_LANE_TRADE_USD, 10), state.cashBalance);
    if (!mint || !Number.isFinite(price) || price <= 0 || size <= 0) return { success: false, error: 'Invalid buy' };
    const next = structuredClone(state);
    const p = { id: randomUUID(), tokenAddress: mint, symbol: c.symbol, entryPrice: price, currentPrice: Number(c.priceUsd), highestPrice: Number(c.priceUsd), quantity: size / price, originalQuantity: size / price, originalCostUsd: size, entryAt: now, lastQuoteAt: Number(c.lastQuoteAt) || now, entryTime: new Date(now).toISOString(), tp1Done: false, tp2Done: false, proceedsUsd: 0 };
    next.cashBalance -= size; next.position = p; next.boughtMints.push(mint);
    next.history.unshift({ ...p, type: 'BUY', time: p.entryTime, amountUsd: size, mode: 'PAPER' });
    commit(next); return { success: true, position: structuredClone(p) };
  }
  function decideExit(priceUsd, now = Date.now(), quoteAt = now) {
    const price = Number(priceUsd), p = state.position;
    if (!p || !Number.isFinite(price) || price <= 0) return null;
    const next = structuredClone(state), pos = next.position;
    pos.lastQuoteAt = Number(quoteAt) || pos.lastQuoteAt || pos.entryAt;
    pos.currentPrice = price; pos.highestPrice = Math.max(pos.highestPrice, price);
    const gain = (price / pos.entryPrice - 1) * 100;
    const fills = [];
    function sell(fraction, reason) {
      const quantity = Math.min(pos.quantity, pos.originalQuantity * fraction);
      const fillPrice = price * 0.9925, proceeds = quantity * fillPrice;
      const basis = quantity / pos.originalQuantity * pos.originalCostUsd;
      pos.quantity -= quantity; pos.proceedsUsd += proceeds; next.cashBalance += proceeds;
      const row = { id: randomUUID(), positionId: pos.id, tokenAddress: pos.tokenAddress, symbol: pos.symbol, type: 'SELL', entryPrice: pos.entryPrice, exitPrice: fillPrice, quantity, amountUsd: proceeds, costBasisUsd: basis, pnlUsd: proceeds - basis, pnlPercent: (fillPrice / pos.entryPrice - 1) * 100, percentOfOriginalSold: quantity / pos.originalQuantity * 100, reason, time: new Date(now).toISOString(), entryTime: pos.entryTime, mode: 'PAPER' };
      next.history.unshift(row); fills.push(row);
    }
    if (gain <= -18) sell(1, 'Hard stop -18%');
    else {
      if (!pos.tp1Done && gain >= 40) { sell(0.4, 'TP1 +40%'); pos.tp1Done = true; }
      if (!pos.tp2Done && gain >= 90) { sell(0.3, 'TP2 +90%'); pos.tp2Done = true; }
      if (pos.quantity > 0 && pos.tp1Done && price <= pos.highestPrice * 0.85) sell(1, 'Trailing stop 15%');
      if (pos.quantity > 0 && now - pos.entryAt >= 18 * 60000 && gain < 12) sell(1, '18-minute timeout');
    }
    if (pos.quantity <= pos.originalQuantity * 1e-9) {
      const pnl = pos.proceedsUsd - pos.originalCostUsd;
      next.completedTradeRecords.unshift({ ...structuredClone(pos), amountInvestedUsd: pos.originalCostUsd, amountReceivedUsd: pos.proceedsUsd, pnlUsd: pnl, pnlPercent: pnl / pos.originalCostUsd * 100, exitTime: new Date(now).toISOString(), exitPrice: price * 0.9925, reason: fills.at(-1)?.reason, mode: 'PAPER' });
      next.position = null;
    }
    commit(next); return fills;
  }
  function dashboard(now = Date.now()) {
    const p = state.position;
    const lastQuoteAt = p ? Number(p.lastQuoteAt || p.entryAt) : null;
    const quoteAvailable = !p || (Number.isFinite(lastQuoteAt) && now - lastQuoteAt <= 120000);
    const value = p && quoteAvailable ? p.quantity * p.currentPrice * 0.9925 : null;
    const equity = p ? quoteAvailable ? state.cashBalance + value : null : state.cashBalance;
    const basis = p ? p.originalCostUsd * p.quantity / p.originalQuantity : 0;
    const pnl = p && value !== null ? value - basis : null;
    const livePositions = p ? [{
      ...structuredClone(p), priceUsd: quoteAvailable ? p.currentPrice : null,
      currentPrice: quoteAvailable ? p.currentPrice : null, currentValue: value,
      amountInvestedUsd: basis, pnl, pnlUsd: pnl,
      pnlPercent: pnl !== null && basis > 0 ? pnl / basis * 100 : null,
      holdTimeMs: Math.max(0, now - p.entryAt), quoteAvailable,
      lastQuoteAt: new Date(lastQuoteAt).toISOString()
    }] : [];
    return {
      strategy, startingBalance: state.startingBalance, cashBalance: state.cashBalance, equity,
      totalPnl: equity === null ? null : equity - state.startingBalance,
      totalPnlPercent: equity === null ? null : (equity / state.startingBalance - 1) * 100,
      completedTrades: state.completedTradeRecords.length, completedTradeRecords: structuredClone(state.completedTradeRecords),
      history: structuredClone(state.history), livePositions, lastScanAt: state.lastScanAt,
      quoteAvailable, lastQuoteAt: lastQuoteAt ? new Date(lastQuoteAt).toISOString() : null
    };
  }
  function recordRejection(candidate, reason) { const next = structuredClone(state); next.rejections.unshift({ mint: candidate.mint || candidate.tokenAddress, reason, time: new Date().toISOString() }); next.rejections = next.rejections.slice(0, 200); commit(next); }
  function touchScan() { const next = structuredClone(state); next.lastScanAt = new Date().toISOString(); commit(next); }
  return { dashboard, getState: () => structuredClone(state), buy, decideExit, recordRejection, touchScan };
}
let instance;
const current = () => instance ||= createPumpLaneTrader();
module.exports = { createPumpLaneTrader, ...Object.fromEntries(['dashboard','getState','buy','decideExit','recordRejection','touchScan'].map(k => [k, (...args) => current()[k](...args)])) };
