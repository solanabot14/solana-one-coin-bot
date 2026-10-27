'use strict';

const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','address','trader_address','trader','maker','maker_address','owner_address','owner'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastDiagnostics = { candidates: 0, profitsMapped: 0, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };

function looksLikeSolanaAddress(v) {
  return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function rowWallet(row) {
  for (const key of WALLET_KEYS) if (looksLikeSolanaAddress(row && row[key])) return row[key];
  return null;
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

function profitsMap(payload, candidates) {
  const rows = payload && Array.isArray(payload.list) ? payload.list : [];
  const map = new Map();
  rows.forEach((row, i) => {
    const wallet = rowWallet(row) || candidates[i];
    if (wallet && candidates.includes(wallet)) map.set(wallet, row);
  });
  return map;
}

async function oneWalletStats(wallet, period) {
  await sleep(1000);
  try {
    const payload = await runGmgn(['portfolio','stats','--chain',config.chain,'--wallet',wallet,'--period',period]);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
    if (Array.isArray(payload) && payload[0] && typeof payload[0] === 'object') return payload[0];
    return null;
  } catch (error) {
    console.error(`[wallet-finder] ${period} stats skip ${wallet}: ${error.message}`);
    return null;
  }
}

async function discoverWallets() {
  const feed = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
  const candidates = extractWallets(feed).slice(0, 20);
  lastDiagnostics = { candidates: candidates.length, profitsMapped: 0, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };
  if (!candidates.length) return [];

  // GMGN documents portfolio profits as a true batch endpoint with one list row per wallet.
  const walletArgs = candidates.flatMap(wallet => ['--wallet', wallet]);
  await sleep(1200);
  const profitsPayload = await runGmgn(['portfolio','profits','--chain',config.chain,...walletArgs,'--period','30d']);
  const profits = profitsMap(profitsPayload, candidates);
  lastDiagnostics.profitsMapped = profits.size;

  // First prefilter only on the existing minimum trade-history rule. No safety thresholds are loosened.
  const tradeQualified = [];
  for (const wallet of candidates) {
    const row = profits.get(wallet);
    if (!row) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }
    const trades30 = readTradeCount(row);
    if ((trades30 || 0) < config.minTrades30d) {
      lastDiagnostics.rejectedTradeCount++;
      continue;
    }
    tradeQualified.push({
      wallet,
      trades30,
      pnl30: firstNumber(row, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit'])
    });
  }

  const scored = [];
  for (const base of tradeQualified) {
    const thirty = await oneWalletStats(base.wallet, '30d');
    if (!thirty) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }
    lastDiagnostics.mapped30d++;
    const win30 = normalizeWinRate(firstNumber(thirty, ['winrate','win_rate','winRate']));
    if (win30 < config.minWinRate30d) {
      lastDiagnostics.rejectedWinRate++;
      continue;
    }

    const seven = await oneWalletStats(base.wallet, '7d');
    if (!seven) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }
    lastDiagnostics.mapped7d++;
    const win7 = normalizeWinRate(firstNumber(seven, ['winrate','win_rate','winRate']));
    const pnl30 = Number.isFinite(base.pnl30) ? base.pnl30 : firstNumber(thirty, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
    scored.push({
      wallet: base.wallet,
      win7,
      win30,
      pnl30,
      trades30: base.trades30,
      score: scoreWallet({ win7, win30, pnl30, trades30: base.trades30 })
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
