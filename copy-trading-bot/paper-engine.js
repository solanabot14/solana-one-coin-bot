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
    this.account = null;
    this.load();
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      for (const p of s.positions || []) this.positions.set(`${p.wallet}:${p.token}`, p);
      this.closed = s.closed || [];
      if (s.account && Number.isFinite(Number(s.account.cashBalanceUsd))) {
        this.account = s.account;
      }
    } catch {}
    if (!this.account) {
      const committed = [...this.positions.values()].reduce((sum,p)=>sum+(Number(p.amountUsd)||0),0);
      this.account = {
        startingBalanceUsd: config.startingBalanceUsd,
        cashBalanceUsd: Math.max(0, config.startingBalanceUsd - committed),
        initializedAt: new Date().toISOString()
      };
      this.save();
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ account: this.account, positions: [...this.positions.values()], closed: this.closed.slice(-500) }, null, 2));
    } catch (error) {
      console.error('[state save]', error.message);
    }
  }

  hasPosition(wallet, token) { return this.positions.has(`${wallet}:${token}`); }
  getPosition(wallet, token) { return this.positions.get(`${wallet}:${token}`) || null; }

  walletPerformance(wallet) {
    const trades = this.closed.filter(t => t.wallet === wallet);
    const wins = trades.filter(t => Number(t.pnlUsd) > 0).length;
    const losses = trades.filter(t => Number(t.pnlUsd) < 0).length;
    const realizedPnlUsd = trades.reduce((sum, t) => sum + (Number(t.pnlUsd) || 0), 0);
    let consecutiveLosses = 0;
    for (let i = trades.length - 1; i >= 0; i--) { if (Number(trades[i].pnlUsd) < 0) consecutiveLosses++; else break; }
    const winRate = trades.length ? wins / trades.length * 100 : null;
    const suspended = trades.length >= config.copySuspendMinTrades && realizedPnlUsd < 0 && (
      consecutiveLosses >= config.copySuspendLossStreak || (Number.isFinite(winRate) && winRate < config.copySuspendWinRatePct)
    );
    return { wallet, trades: trades.length, wins, losses, winRate, realizedPnlUsd, consecutiveLosses, suspended };
  }

  isWalletSuspended(wallet) { return this.walletPerformance(wallet).suspended; }
  allWalletPerformance() {
    const wallets = new Set();
    for (const t of this.closed) wallets.add(t.wallet);
    for (const p of this.positions.values()) wallets.add(p.wallet);
    return [...wallets].map(w => this.walletPerformance(w)).sort((a,b) => b.trades - a.trades || b.realizedPnlUsd - a.realizedPnlUsd);
  }

  async market(token) {
    const info = await runGmgn(['token','info','--chain',config.chain,'--address',token]);
    return {
      symbol: firstString(info, ['symbol','token_symbol','name']) || token.slice(0, 6),
      price: firstNumber(info, ['price','price_usd','priceUsd','usd_price']),
      liquidity: firstNumber(info, ['liquidity','liquidity_usd','liquidityUsd'])
    };
  }

  async open(wallet, token, signalId, signalAt = null) {
    if (this.positions.size >= config.maxOpenPositions) return null;
    if (this.isWalletSuspended(wallet)) { console.log('[COPY WALLET SUSPENDED]', wallet, JSON.stringify(this.walletPerformance(wallet))); return null; }
    if ((Number(this.account.cashBalanceUsd) || 0) < config.paperTradeUsd) {
      console.log('[PAPER BUY BLOCKED - INSUFFICIENT CASH]', JSON.stringify({ cashBalanceUsd:this.account.cashBalanceUsd, requiredUsd:config.paperTradeUsd }));
      return null;
    }
    const key = `${wallet}:${token}`;
    if (this.positions.has(key)) return null;
    const m = await this.market(token);
    if (!Number.isFinite(m.price) || m.price <= 0) return null;
    const p = {
      wallet, token, symbol: m.symbol, signalId, signalAt,
      mode: 'paper', amountUsd: config.paperTradeUsd,
      entryPrice: m.price, entryLiquidity: m.liquidity,
      lastPrice: m.price, lastLiquidity: m.liquidity,
      unrealizedPnlPct: 0, unrealizedPnlUsd: 0,
      leaderSellSignals: 0, firstLeaderSellAt: null, lastLeaderSellAt: null,
      openedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString()
    };
    this.account.cashBalanceUsd = Math.max(0, Number(this.account.cashBalanceUsd) - config.paperTradeUsd);
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
    const pnlUsd = p.amountUsd * pnlPct / 100;
    const closed = { ...p, exitPrice, exitLiquidity: market.liquidity, pnlPct, pnlUsd, reason, closedAt: new Date().toISOString() };
    this.positions.delete(key);
    this.closed.push(closed);
    this.account.cashBalanceUsd = Math.max(0, Number(this.account.cashBalanceUsd) + Number(p.amountUsd) + pnlUsd);
    this.save();
    console.log('[PAPER SELL]', JSON.stringify(closed));
    return closed;
  }

  async leaderSold(wallet, token, signalId, signalAt = null) {
    const key = `${wallet}:${token}`;
    const p = this.positions.get(key);
    if (!p) return;
    const m = await this.market(token);
    if (!Number.isFinite(m.price)) return;
    const nowMs = signalAt ? new Date(signalAt).getTime() : Date.now();
    const openedMs = new Date(p.openedAt).getTime();
    if (Number.isFinite(nowMs) && Number.isFinite(openedMs) && nowMs < openedMs - 5000) return;
    const lastSellMs = p.lastLeaderSellAt ? new Date(p.lastLeaderSellAt).getTime() : null;
    const withinWindow = Number.isFinite(lastSellMs) && (nowMs - lastSellMs) <= config.leaderSellConfirmWindowSec * 1000;
    p.leaderSellSignals = withinWindow ? (Number(p.leaderSellSignals) || 0) + 1 : 1;
    p.firstLeaderSellAt = withinWindow && p.firstLeaderSellAt ? p.firstLeaderSellAt : new Date(nowMs).toISOString();
    p.lastLeaderSellAt = new Date(nowMs).toISOString();
    p.lastLeaderSellSignalId = signalId || null;
    p.lastLeaderSellPrice = m.price;
    const pnlPct = ((m.price / p.entryPrice) - 1) * 100;
    const liqDropPct = Number.isFinite(p.entryLiquidity) && p.entryLiquidity > 0 && Number.isFinite(m.liquidity) ? (1 - m.liquidity / p.entryLiquidity) * 100 : 0;
    const confirmedDump = p.leaderSellSignals >= config.leaderSellConfirmCount || pnlPct <= config.leaderDumpPnlPct || liqDropPct >= config.leaderDumpLiquidityDropPct;
    if (confirmedDump) return this.close(key, 'leader_dump', m);
    p.lastPrice = m.price; p.lastLiquidity = m.liquidity; p.unrealizedPnlPct = pnlPct; p.unrealizedPnlUsd = p.amountUsd * pnlPct / 100; p.lastCheckedAt = new Date().toISOString();
    this.save();
    console.log('[LEADER PARTIAL SELL]', JSON.stringify({ wallet, token, signalId, pnlPct, liqDropPct, leaderSellSignals: p.leaderSellSignals }));
  }

  async evaluate() {
    let changed = false;
    for (const [key, p] of [...this.positions.entries()]) {
      try {
        const m = await this.market(p.token);
        if (!Number.isFinite(m.price)) continue;
        const pnlPct = ((m.price / p.entryPrice) - 1) * 100;
        p.lastPrice = m.price; p.lastLiquidity = m.liquidity; p.unrealizedPnlPct = pnlPct; p.unrealizedPnlUsd = p.amountUsd * pnlPct / 100; p.lastCheckedAt = new Date().toISOString(); changed = true;
        if (pnlPct >= config.takeProfitPct) await this.close(key, 'take_profit', m);
        else if (pnlPct <= -config.stopLossPct) await this.close(key, 'stop_loss', m);
        else if (Number.isFinite(p.entryLiquidity) && Number.isFinite(m.liquidity) && m.liquidity <= p.entryLiquidity * (1 - config.liquidityExitDropPct / 100)) await this.close(key, 'liquidity_drop', m);
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
    const committedCapitalUsd = openPositions.reduce((sum,t)=>sum+(Number(t.amountUsd)||0),0);
    const cashBalanceUsd = Number(this.account.cashBalanceUsd) || 0;
    const equityUsd = cashBalanceUsd + committedCapitalUsd + unrealizedPnlUsd;
    return {
      mode: 'paper', paperTradeUsd: config.paperTradeUsd, startingBalanceUsd: this.account.startingBalanceUsd,
      cashBalanceUsd, committedCapitalUsd, equityUsd, accountInitializedAt: this.account.initializedAt,
      openPositions, closedTrades, walletPerformance: this.allWalletPerformance(),
      metrics: { openPositions: openPositions.length, closedTrades: this.closed.length, wins, losses, winRate: this.closed.length ? wins / this.closed.length * 100 : null, realizedPnlUsd, unrealizedPnlUsd, cashBalanceUsd, committedCapitalUsd, equityUsd }
    };
  }
}

module.exports = PaperEngine;
