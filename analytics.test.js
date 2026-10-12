'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('./analytics-core');

test('summarizes wins, losses, and breakeven without hiding dollar contribution', () => {
  const rows = [
    { pnl: 10, amountInvested: 20, pnlPercent: 50 },
    { pnl: -15, amountInvested: 20, pnlPercent: -75 },
    { pnl: 0, amountInvested: 10, pnlPercent: 0 }
  ].map(t => a.normalizeTrade(t, 'test'));
  const m = a.tradeMetrics(rows);
  assert.equal(m.trades, 3);
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.breakeven, 1);
  assert.equal(m.netPnl, -5);
  assert.ok(Math.abs(m.winRate - 100 / 3) < 1e-8);
  assert.ok(Math.abs(m.profitFactor - 10 / 15) < 1e-8);
});

test('uses each recorded partial sale once for daily realized P&L', () => {
  const rows = [{ system:'V3.1', entryTime:'2026-10-01T16:00:00.000Z', exitTime:'2026-10-02T01:00:00.000Z',
    pnl:5, amountInvested:10, sells:[
      { time:'2026-10-02T00:10:00.000Z', pnl:2 },
      { time:'2026-10-02T01:00:00.000Z', pnl:3 }
    ] }].map(t => a.normalizeTrade(t, 'V3.1'));
  const ev = a.pnlEvents(rows);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].pnl + ev[1].pnl, 5);
  assert.equal(a.dailyPnl(rows, 'UTC')[0].pnl, 5);
});

test('does not manufacture a fee, hold time, or trade result when fields are missing', () => {
  const row = a.normalizeTrade({ symbol:'TEST', amountInvested:5 }, 'test');
  assert.equal(row.pnl, null);
  assert.equal(row.returnPercent, null);
  assert.equal(row.holdMs, null);
  assert.equal(row.entryTime, null);
});

test('drawdown is explicitly labeled as realized P&L only', () => {
  const trades = [
    { pnl:10, exitTime:'2026-10-01T12:00:00Z' },
    { pnl:-4, exitTime:'2026-10-01T13:00:00Z' }
  ].map(t => a.normalizeTrade(t, 'test'));
  const d = a.drawdownFromRealizedPnl(trades);
  assert.equal(d.maxDrawdown, 4);
  assert.equal(d.basis, 'CUMULATIVE REALIZED P&L');
});

test('counts partial sell events in realized ledger before the whole position closes', () => {
  const rows = [
    { type:'SELL', systemId:'test', time:'2026-10-01T12:00:00Z', pnl:2, percentSold:40 },
    { type:'SELL', systemId:'test', time:'2026-10-01T13:00:00Z', pnl:-3, percentSold:60 }
  ];
  const events = a.realizedSellEvents(rows);
  assert.equal(events.length, 2);
  assert.equal(events.reduce((sum, row) => sum + row.pnl, 0), -1);
  assert.equal(a.dailyPnl(events, 'UTC')[0].pnl, -1);
});

test('keeps legacy closed-trade rows in realized ledger fallback', () => {
  const events = a.realizedSellEvents([{ type:'CLOSED TRADE', time:'2026-10-01T12:00:00Z', pnl:4 }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].pnl, 4);
});
