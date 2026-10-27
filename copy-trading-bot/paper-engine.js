'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { runGmgn, firstNumber, firstString } = require('./gmgn');

const stateFile = process.env.COPY_STATE_FILE || path.join(__dirname, 'paper-state.json');

class PaperEngine {
  constructor() {
    this.positions = new Map();
    this.closed = [];
    this.load();
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      for (const p of s.positions || []) this.positions.set(`${p.wallet}:${p.token}`, p);
      this.closed = s.closed || [];
    } catch {}
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ positions: [...this.positions.values()], closed: this.closed.slice(-500) }, null, 2));
    } catch (error) {
      console.error('[state save]', error.message);
    }
  }

  async market(token) {
    const info = await runGmgn(['token','info','--chain',config.chain,'--address',token]);
    return {
      symbol: firstString(info, ['symbol','token_symbol','name']) || token.slice(0, 6),
      price: firstNumber(info, ['price','price_usd','priceUsd','usd_price']),
      liquidity: firstNumber(info, ['liquidity','liquidity_usd','liquidityUsd'])
    };
  }

  async open(wallet, token, signalId) {
    if (this.positions.size >= config.maxOpenPositions) return null;
    const key = `${wallet}:${token}`;
    if (this.positions.has(key)) return null;
    const m = await this.market(token);
    if (!Number.isFinite(m.price) || m.price <= 0) return null;
    const p = {
      wallet, token, symbol: m.symbol, signalId,
      mode: 'paper', amountUsd: config.paperTradeUsd,
      entryPrice: m.price, entryLiquidity: m.liquidity,
      lastPrice: m.price, lastLiquidity: m.liquidity,
      unrealizedPnlPct: 0, unrealizedPnlUsd: 0,
      openedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString()
    };
    this.positions.set(key, p);
    this.save();
    console.log('[PAPER BUY]', JSON.stringify(p));
    return p;
  }

  async close(key, reason, market) {
    const p = this.positions.get(key);
    if (!p || !Number.isFinite(market.price)) return;
    const exitPrice = market.price;
    const pnlPct = ((exitPrice / p.entryPrice) - 1) * 100;
    const closed = {
      ...p,
      exitPrice,
      exitLiquidity: market.liquidity,
      pnlPct,
      pnlUsd: p.amountUsd * pnlPct / 100,
      reason,
      closedAt: new Date().toISOString()
    };
    this.positions.delete(key);
    this.closed.push(closed);
    this.save();
    console.log('[PAPER SELL]', JSON.stringify(closed));
    return closed;
  }

  async leaderSold(wallet, token) {
    const key = `${wallet}:${token}`;
    if (!this.positions.has(key)) return;
    const m = await this.market(token);
    if (Number.isFinite(m.price)) return this.close(key, 'leader_wallet_sell', m);
  }

  async evaluate() {
    let changed = false;
    for (const [key, p] of [...this.positions.entries()]) {
      try {
        const m = await this.market(p.token);
        if (!Number.isFinite(m.price)) continue;
        const pnlPct = ((m.price / p.entryPrice) - 1) * 100;
        p.lastPrice = m.price;
        p.lastLiquidity = m.liquidity;
        p.unrealizedPnlPct = pnlPct;
        p.unrealizedPnlUsd = p.amountUsd * pnlPct / 100;
        p.lastCheckedAt = new Date().toISOString();
        changed = true;
        if (pnlPct >= config.takeProfitPct) await this.close(key, 'take_profit', m);
        else if (pnlPct <= -config.stopLossPct) await this.close(key, 'stop_loss', m);
        else if (Number.isFinite(p.entryLiquidity) && Number.isFinite(m.liquidity) && m.liquidity <= p.entryLiquidity * (1 - config.liquidityExitDropPct / 100)) {
          await this.close(key, 'liquidity_drop', m);
        }
      } catch (e) { console.error('[evaluate]', p.token, e.message); }
    }
    if (changed) this.save();
  }

  snapshot() {
    const openPositions = [...this.positions.values()];
    const closedTrades = this.closed.slice(-100).reverse();
    const realizedPnlUsd = this.closed.reduce((sum, t) => sum + (Number(t.pnlUsd) || 0), 0);
    const wins = this.closed.filter(t => Number(t.pnlUsd) > 0).length;
    const losses = this.closed.filter(t => Number(t.pnlUsd) < 0).length;
    const unrealizedPnlUsd = openPositions.reduce((sum, t) => sum + (Number(t.unrealizedPnlUsd) || 0), 0);
    return {
      mode: 'paper',
      paperTradeUsd: config.paperTradeUsd,
      openPositions,
      closedTrades,
      metrics: {
        openPositions: openPositions.length,
        closedTrades: this.closed.length,
        wins,
        losses,
        winRate: this.closed.length ? wins / this.closed.length * 100 : null,
        realizedPnlUsd,
        unrealizedPnlUsd
      }
    };
  }
}

module.exports = PaperEngine;
