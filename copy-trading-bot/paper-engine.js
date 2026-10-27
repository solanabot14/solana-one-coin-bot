'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { runGmgn, firstNumber, firstString } = require('./gmgn');

const stateFile = path.join(__dirname, 'paper-state.json');

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
    fs.writeFileSync(stateFile, JSON.stringify({ positions: [...this.positions.values()], closed: this.closed.slice(-500) }, null, 2));
  }

  async market(token) {
    const info = await runGmgn(['token','info','--chain',config.chain,'--address',token]);
    return {
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
      wallet, token, signalId,
      mode: 'paper', amountUsd: config.paperTradeUsd,
      entryPrice: m.price, entryLiquidity: m.liquidity,
      openedAt: new Date().toISOString()
    };
    this.positions.set(key, p);
    this.save();
    console.log('[PAPER BUY]', JSON.stringify(p));
    return p;
  }

  async close(key, reason, market) {
    const p = this.positions.get(key);
    if (!p) return;
    const exitPrice = market.price;
    const pnlPct = ((exitPrice / p.entryPrice) - 1) * 100;
    const closed = { ...p, exitPrice, pnlPct, pnlUsd: p.amountUsd * pnlPct / 100, reason, closedAt: new Date().toISOString() };
    this.positions.delete(key);
    this.closed.push(closed);
    this.save();
    console.log('[PAPER SELL]', JSON.stringify(closed));
  }

  async leaderSold(wallet, token) {
    const key = `${wallet}:${token}`;
    if (!this.positions.has(key)) return;
    const m = await this.market(token);
    if (Number.isFinite(m.price)) await this.close(key, 'leader_wallet_sell', m);
  }

  async evaluate() {
    for (const [key, p] of [...this.positions.entries()]) {
      try {
        const m = await this.market(p.token);
        if (!Number.isFinite(m.price)) continue;
        const pnlPct = ((m.price / p.entryPrice) - 1) * 100;
        if (pnlPct >= config.takeProfitPct) await this.close(key, 'take_profit', m);
        else if (pnlPct <= -config.stopLossPct) await this.close(key, 'stop_loss', m);
        else if (Number.isFinite(p.entryLiquidity) && Number.isFinite(m.liquidity) && m.liquidity <= p.entryLiquidity * (1 - config.liquidityExitDropPct / 100)) {
          await this.close(key, 'liquidity_drop', m);
        }
      } catch (e) { console.error('[evaluate]', p.token, e.message); }
    }
  }
}

module.exports = PaperEngine;
