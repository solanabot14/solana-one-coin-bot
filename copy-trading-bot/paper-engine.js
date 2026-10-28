'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { runGmgn, firstNumber, firstString } = require('./gmgn');

const stateFile = process.env.COPY_STATE_FILE || path.join(__dirname, 'paper-state.json');

const configuredMaxTokenPriceUsd = Number(process.env.COPY_MAX_TOKEN_PRICE_USD);
const maxTokenPriceUsd = Number.isFinite(configuredMaxTokenPriceUsd) && configuredMaxTokenPriceUsd > 0 ? configuredMaxTokenPriceUsd : 100;

class PaperEngine {
  constructor({ marketFetcher } = {}) {
    this.marketFetcher = marketFetcher || (token => runGmgn(['token','info','--chain',config.chain,'--address',token]));
    this.activityDiagnostics = { rejected: 0, unavailable: 0 };
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
      if (s.account && Number.isFinite(Number(s.account.cashBalanceUsd))) this.account = s.account;
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
    this.applyRequestedPaperCorrection();
  }

  applyRequestedPaperCorrection() {
    const migration = 'paper_40_remove_meimei_20261027_v1';
    if (this.account[migration]) return;
    const id = '3qysVGGB9vudL9De5qK5z8NkvhSsYWTUGY5W5SnB37SvN4dATZQoubrn3Bh1BNAZmQ33PebomyNfis6kuDmCBoNF';
    const matches = this.closed.filter(t => t.signalId === id && t.token === '5kq7MTXRSCeFVFWKhWg12RMhToHEzc8xkSPD9z2vcLXz');
    if (matches.length !== 1) { console.error('[PAPER CORRECTION NOT APPLIED] Expected one MEIMEI record, found ' + matches.length); return; }
    const trade = matches[0];
    const oldStart = Number(this.account.startingBalanceUsd);
    const oldCash = Number(this.account.cashBalanceUsd);
    if (!Number.isFinite(oldStart) || !Number.isFinite(oldCash) || !Number.isFinite(Number(trade.pnlUsd)))
      { console.error('[PAPER CORRECTION NOT APPLIED] Invalid account values'); return; }
    const startMs = Date.parse(this.account.initializedAt);
    const closedMs = Date.parse(trade.closedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(closedMs)) { console.error('[PAPER CORRECTION NOT APPLIED] Invalid dates'); return; }
    const newCash = oldCash + (40 - oldStart) - (closedMs >= startMs ? Number(trade.pnlUsd) : 0);
    if (newCash < 0) { console.error('[PAPER CORRECTION NOT APPLIED] Open commitments exceed adjusted cash'); return; }
    try { fs.copyFileSync(stateFile, stateFile + '.before-paper-correction-20261027'); }
    catch (error) { console.error('[PAPER CORRECTION NOT APPLIED] Backup failed', error.message); return; }
    this.closed = this.closed.filter(t => t !== trade);
    this.account.startingBalanceUsd = 40;
    this.account.cashBalanceUsd = newCash;
    this.account[migration] = { at: new Date().toISOString(), removedSignalId: id, removedPnlUsd: Number(trade.pnlUsd), priorStartingBalanceUsd: oldStart };
    this.save();
    console.log('[PAPER CORRECTION]', JSON.stringify(this.account[migration]));
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ account: this.account, positions: [...this.positions.values()], closed: this.closed.slice(-500) }, null, 2));
    } catch (error) { console.error('[state save]', error.message); }
  }

  hasPosition(wallet, token) { return this.positions.has(`${wallet}:${token}`); }
  hasTokenPosition(token) { return [...this.positions.values()].some(p => p.token === token); }
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
    const info = await this.marketFetcher(token);
    const volume5mUsd = firstNumber(info, ['volume_5m_usd','volume5mUsd','volume_5m','volume5m','volume_5m_usd_value','vol_5m_usd']);
    const swaps5m = firstNumber(info, ['swaps_5m','swaps5m','swap_count_5m','swapCount5m','trade_count_5m','tradeCount5m','tx_count_5m','txCount5m','trades_5m','trades5m']);
    return {
      symbol: firstString(info, ['symbol','token_symbol','name']) || token.slice(0, 6),
      price: firstNumber(info, ['price','price_usd','priceUsd','usd_price']),
      liquidity: firstNumber(info, ['liquidity','liquidity_usd','liquidityUsd']),
      activity5m: Number.isFinite(volume5mUsd) && Number.isFinite(swaps5m) ? { volumeUsd: volume5mUsd, swaps: swaps5m } : null
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
    if (this.hasTokenPosition(token)) {
      const existing = [...this.positions.values()].filter(p => p.token === token).map(p => p.wallet);
      console.log('[PAPER BUY BLOCKED - TOKEN ALREADY OPEN]', JSON.stringify({ token, requestedWallet: wallet, existingWallets: existing }));
      return null;
    }
    const m = await this.market(token);
    if (!Number.isFinite(m.price) || m.price <= 0) return null;
    if (!m.activity5m) {
      this.activityDiagnostics.unavailable++;
      console.log('[PAPER BUY BLOCKED - ACTIVITY DATA UNAVAILABLE]', JSON.stringify({ token, wallet }));
      return null;
    }
    if (m.activity5m.volumeUsd < config.minActivityVolume5mUsd || m.activity5m.swaps < config.minActivitySwaps5m) {
      this.activityDiagnostics.rejected++;
      console.log('[PAPER BUY BLOCKED - INSUFFICIENT RECENT ACTIVITY]', JSON.stringify({ token, wallet, activity5m: m.activity5m, minimumVolumeUsd: config.minActivityVolume5mUsd, minimumSwaps: config.minActivitySwaps5m }));
      return null;
    }
    if (m.price > maxTokenPriceUsd) {
      console.log('[PAPER BUY BLOCKED - TOKEN PRICE ABOVE LIMIT]', JSON.stringify({ token, wallet, priceUsd: m.price, maxTokenPriceUsd }));
      return null;
    }
    const p = {
      wallet, token, symbol: m.symbol, signalId, signalAt, mode: 'paper', amountUsd: config.paperTradeUsd,
      entryPrice: m.price, entryLiquidity: m.liquidity, lastPrice: m.price, lastLiquidity: m.liquidity,
      recentVolume5mUsd: m.activity5m.volumeUsd, recentSwaps5m: m.activity5m.swaps,
      lastActivityAt: new Date().toISOString(), inactiveSinceAt: null,
      unrealizedPnlPct: -3.7, unrealizedPnlUsd: -config.paperTradeUsd * 0.037, leaderSellSignals: 0, firstLeaderSellAt: null, lastLeaderSellAt: null,
      estimatedRoundTripCostPct: 3.7,
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
    const grossPnlPct = ((exitPrice / p.entryPrice) - 1) * 100;
    const estimatedCostPct = Number(p.estimatedRoundTripCostPct) || 0;
    const pnlPct = grossPnlPct - estimatedCostPct;
    const pnlUsd = p.amountUsd * pnlPct / 100;
    const closed = { ...p, exitPrice, exitLiquidity: market.liquidity, grossPnlPct, estimatedCostPct, pnlPct, pnlUsd, reason, closedAt: new Date().toISOString() };
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
    if (!p) return true;
    const nowMs = signalAt ? new Date(signalAt).getTime() : Date.now();
    const openedMs = new Date(p.openedAt).getTime();
    if (Number.isFinite(nowMs) && Number.isFinite(openedMs) && nowMs < openedMs - 5000) return true;
    const m = await this.market(token);
    if (!Number.isFinite(m.price) || m.price <= 0) {
      console.log('[LEADER SELL EXIT RETRY]', JSON.stringify({ wallet, token, signalId, reason: 'valid_exit_price_unavailable' }));
      return false;
    }
    return Boolean(await this.close(key, 'followed_wallet_sold', m));
  }

  async evaluate() {
    const manualWallet = process.env.COPY_MANUAL_CLOSE_WALLET;
    const manualToken = process.env.COPY_MANUAL_CLOSE_TOKEN;
    if (manualWallet && manualToken) {
      const manualKey = `${manualWallet}:${manualToken}`;
      const manualPosition = this.positions.get(manualKey);
      if (manualPosition) {
        try {
          const manualMarket = await this.market(manualToken);
          if (Number.isFinite(manualMarket.price)) {
            await this.close(manualKey, 'manual_close', manualMarket);
            console.log('[MANUAL CLOSE EXECUTED]', JSON.stringify({ wallet: manualWallet, token: manualToken }));
          }
        } catch (e) { console.error('[manual close]', manualToken, e.message); }
      }
    }

    let changed = false;
    for (const [key, p] of [...this.positions.entries()]) {
      try {
        const m = await this.market(p.token);
        if (!Number.isFinite(m.price)) continue;
        const pnlPct = ((m.price / p.entryPrice) - 1) * 100;
        const checkedAt = new Date().toISOString();
        p.lastPrice = m.price; p.lastLiquidity = m.liquidity; p.unrealizedPnlPct = pnlPct - (Number(p.estimatedRoundTripCostPct) || 0); p.unrealizedPnlUsd = p.amountUsd * p.unrealizedPnlPct / 100; p.lastCheckedAt = checkedAt; changed = true;
        if (m.activity5m) {
          p.recentVolume5mUsd = m.activity5m.volumeUsd;
          p.recentSwaps5m = m.activity5m.swaps;
          if (m.activity5m.swaps > 0 || m.activity5m.volumeUsd > 0) p.lastActivityAt = checkedAt;
        }
      } catch (e) { console.error('[evaluate]', p.token, e.message); }
    }
    if (changed) this.save();
  }

  snapshot() {
    const openPositions = [...this.positions.values()];
    const closedTrades = this.closed.slice(-100).reverse();
    const accountStartMs = new Date(this.account.initializedAt).getTime();
    const accountClosed = this.closed.filter(t => Number.isFinite(accountStartMs) && new Date(t.closedAt).getTime() >= accountStartMs);
    const realizedPnlUsd = accountClosed.reduce((sum, t) => sum + (Number(t.pnlUsd) || 0), 0);
    const wins = accountClosed.filter(t => Number(t.pnlUsd) > 0).length;
    const losses = accountClosed.filter(t => Number(t.pnlUsd) < 0).length;
    const unrealizedPnlUsd = openPositions.reduce((sum, t) => sum + (Number(t.unrealizedPnlUsd) || 0), 0);
    const committedCapitalUsd = openPositions.reduce((sum,t)=>sum+(Number(t.amountUsd)||0),0);
    const cashBalanceUsd = Number(this.account.cashBalanceUsd) || 0;
    const equityUsd = cashBalanceUsd + committedCapitalUsd + unrealizedPnlUsd;
    return {
      mode: 'paper', paperTradeUsd: config.paperTradeUsd, startingBalanceUsd: this.account.startingBalanceUsd,
      cashBalanceUsd, committedCapitalUsd, equityUsd, accountInitializedAt: this.account.initializedAt,
      activityDiagnostics: { ...this.activityDiagnostics },
      openPositions, closedTrades, walletPerformance: this.allWalletPerformance(),
      metrics: {
        openPositions: openPositions.length, closedTrades: accountClosed.length, wins, losses,
        winRate: accountClosed.length ? wins / accountClosed.length * 100 : null,
        realizedPnlUsd, unrealizedPnlUsd, cashBalanceUsd, committedCapitalUsd, equityUsd
      }
    };
  }
}

module.exports = PaperEngine;
