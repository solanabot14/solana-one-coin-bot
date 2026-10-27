'use strict';

const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','address','trader_address','trader','maker','maker_address','owner_address','owner'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastDiagnostics = { candidates: 0, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };

function looksLikeSolanaAddress(v) {
  return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function extractWallets(payload) {
  const found = new Set();
  for (const row of flatten(payload)) {
    for (const key of WALLET_KEYS) if (looksLikeSolanaAddress(row[key])) found.add(row[key]);
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

function readTradeCount(stats) {
  const buys = firstNumber(stats, ['buy_count','buyCount','buy']);
  const sells = firstNumber(stats, ['sell_count','sellCount','sell']);
  if (Number.isFinite(buys) || Number.isFinite(sells)) return (Number(buys) || 0) + (Number(sells) || 0);
  return firstNumber(stats, ['trade_count','tradeCount','token_num','tokenNum','total_trades','totalTrades','tokens_traded']);
}

function backoffMs(message) {
  const iso = String(message || '').match(/until\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
  if (iso) return Math.max(1000, Date.parse(iso[1]) - Date.now() + 750);
  const seconds = String(message || '').match(/~(\d+)s remaining/i);
  if (seconds) return Math.max(1000, Number(seconds[1]) * 1000 + 750);
  return null;
}

async function oneWalletStats(wallet, period) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(1100);
    try {
      const payload = await runGmgn(['portfolio','stats','--chain',config.chain,'--wallet',wallet,'--period',period]);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
      if (Array.isArray(payload) && payload[0] && typeof payload[0] === 'object') return payload[0];
      return null;
    } catch (error) {
      const wait = backoffMs(error.message);
      if (attempt === 0 && wait) {
        console.error(`[wallet-finder] GMGN backoff ${Math.ceil(wait / 1000)}s before retrying ${period} stats`);
        await sleep(wait);
        continue;
      }
      console.error(`[wallet-finder] ${period} stats skip ${wallet}: ${error.message}`);
      return null;
    }
  }
  return null;
}

async function discoverWallets() {
  const feed = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
  const candidates = extractWallets(feed).slice(0, 20);
  lastDiagnostics = { candidates: candidates.length, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };
  if (!candidates.length) return [];

  const thirtyDayQualified = [];
  for (const wallet of candidates) {
    const thirty = await oneWalletStats(wallet, '30d');
    if (!thirty) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }
    lastDiagnostics.mapped30d++;

    const trades30 = readTradeCount(thirty);
    if ((trades30 || 0) < config.minTrades30d) {
      lastDiagnostics.rejectedTradeCount++;
      continue;
    }

    const win30 = normalizeWinRate(firstNumber(thirty, ['winrate','win_rate','winRate']));
    if (win30 < config.minWinRate30d) {
      lastDiagnostics.rejectedWinRate++;
      continue;
    }

    thirtyDayQualified.push({
      wallet,
      win30,
      trades30,
      pnl30: firstNumber(thirty, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit'])
    });
  }

  const scored = [];
  for (const base of thirtyDayQualified) {
    const seven = await oneWalletStats(base.wallet, '7d');
    if (!seven) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }
    lastDiagnostics.mapped7d++;
    const win7 = normalizeWinRate(firstNumber(seven, ['winrate','win_rate','winRate']));
    scored.push({
      wallet: base.wallet,
      win7,
      win30: base.win30,
      pnl30: base.pnl30,
      trades30: base.trades30,
      score: scoreWallet({ win7, win30: base.win30, pnl30: base.pnl30, trades30: base.trades30 })
    });
  }

  const approved = scored.sort((a,b) => b.score - a.score).slice(0, config.maxWallets);
  lastDiagnostics.approved = approved.length;
  return approved;
}

function getLastDiagnostics() {
  return { ...lastDiagnostics };
}

if (require.main === module) {
  discoverWallets().then(rows => console.log(JSON.stringify({ mode: 'paper', wallets: rows, diagnostics: getLastDiagnostics() }, null, 2))).catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { discoverWallets, extractWallets, scoreWallet, getLastDiagnostics };
