'use strict';

const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','trader_address','trader','maker','owner_address','owner'];

function looksLikeSolanaAddress(v) {
  return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function extractWallets(payload) {
  const found = new Set();
  for (const row of flatten(payload)) {
    for (const key of WALLET_KEYS) {
      if (looksLikeSolanaAddress(row[key])) found.add(row[key]);
    }
  }
  return [...found];
}

function normalizeWinRate(n) {
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

function scoreWallet({ win7, win30, pnl30, trades30 }) {
  const w7 = Math.max(0, Math.min(100, normalizeWinRate(win7)));
  const w30 = Math.max(0, Math.min(100, normalizeWinRate(win30)));
  const consistency = Math.max(0, 100 - Math.abs(w7 - w30) * 2);
  const tradeEvidence = Math.min(100, Math.max(0, (trades30 || 0) * 3));
  const profitScore = !Number.isFinite(pnl30) ? 0 : Math.min(100, Math.max(0, 50 + Math.sign(pnl30) * Math.log10(1 + Math.abs(pnl30)) * 12));
  return Math.round((w30 * 0.30 + w7 * 0.15 + consistency * 0.15 + tradeEvidence * 0.15 + profitScore * 0.25) * 10) / 10;
}

async function analyzeWallet(wallet) {
  const [stats, p7, p30] = await Promise.all([
    runGmgn(['portfolio','stats','--chain',config.chain,'--wallet',wallet]),
    runGmgn(['portfolio','profits','--chain',config.chain,'--wallet',wallet,'--period','7d']),
    runGmgn(['portfolio','profits','--chain',config.chain,'--wallet',wallet,'--period','30d'])
  ]);

  const win7 = firstNumber(p7, ['winrate','win_rate','winRate']);
  const win30 = firstNumber(p30, ['winrate','win_rate','winRate']);
  const pnl30 = firstNumber(p30, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
  const trades30 = firstNumber(p30, ['trade_count','tradeCount','token_num','tokenNum','total_trades','totalTrades']) ??
                   firstNumber(stats, ['trade_count','tradeCount','token_num','tokenNum','total_trades','totalTrades']);

  return {
    wallet,
    win7: normalizeWinRate(win7),
    win30: normalizeWinRate(win30),
    pnl30,
    trades30,
    score: scoreWallet({ win7, win30, pnl30, trades30 })
  };
}

async function discoverWallets() {
  const feed = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
  const candidates = extractWallets(feed).slice(0, 25);
  const scored = [];

  for (const wallet of candidates) {
    try {
      const item = await analyzeWallet(wallet);
      if ((item.trades30 || 0) >= config.minTrades30d && item.win30 >= config.minWinRate30d) scored.push(item);
    } catch (err) {
      console.error('[wallet-finder] skip', wallet, err.message);
    }
  }

  return scored.sort((a,b) => b.score - a.score).slice(0, config.maxWallets);
}

if (require.main === module) {
  discoverWallets()
    .then(rows => console.log(JSON.stringify({ mode: 'paper', wallets: rows }, null, 2)))
    .catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { discoverWallets, analyzeWallet, extractWallets, scoreWallet };
