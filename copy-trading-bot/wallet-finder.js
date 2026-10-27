'use strict';

const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','address','trader_address','trader','maker','maker_address','owner_address','owner'];
const METRIC_KEYS = new Set([
  'winrate','win_rate','winRate','realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit',
  'buy','sell','buy_count','buyCount','sell_count','sellCount','trade_count','tradeCount','token_num','tokenNum',
  'total_trades','totalTrades','tokens_traded','pnl_stat'
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastDiagnostics = { candidates: 0, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };

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

function hasMetrics(row) {
  return !!(row && typeof row === 'object' && Object.keys(row).some(key => METRIC_KEYS.has(key)));
}

function collectMetricRows(payload) {
  const out = [];
  const seen = new Set();
  const walk = value => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (hasMetrics(value) && !seen.has(value)) {
      out.push(value);
      seen.add(value);
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(payload);
  return out;
}

function statsMap(payload, candidates) {
  const map = new Map();

  // GMGN documents batch portfolio stats as a bare array with one top-level row per wallet.
  // Preserve that top-level ordering before inspecting nested pnl_stat/common objects.
  if (Array.isArray(payload)) {
    payload.forEach((row, i) => {
      if (!row || typeof row !== 'object' || !hasMetrics(row)) return;
      const wallet = rowWallet(row) || candidates[i];
      if (wallet && candidates.includes(wallet) && !map.has(wallet)) map.set(wallet, row);
    });
    if (map.size) return map;
  }

  // Defensive support for wrappers that contain a batch array.
  for (const key of ['list','data','rows','wallets']) {
    const rows = payload && Array.isArray(payload[key]) ? payload[key] : null;
    if (!rows) continue;
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || !hasMetrics(row)) return;
      const wallet = rowWallet(row) || candidates[i];
      if (wallet && candidates.includes(wallet) && !map.has(wallet)) map.set(wallet, row);
    });
    if (map.size) return map;
  }

  // Explicit wallet-keyed records are safe to map regardless of nesting.
  for (const row of collectMetricRows(payload)) {
    const wallet = rowWallet(row);
    if (wallet && candidates.includes(wallet) && !map.has(wallet)) map.set(wallet, row);
  }

  const walkKeyed = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (looksLikeSolanaAddress(key) && candidates.includes(key) && child && typeof child === 'object' && !map.has(key)) {
        map.set(key, child);
      }
      if (child && typeof child === 'object') walkKeyed(child);
    }
  };
  walkKeyed(payload);

  return map;
}

function readTradeCount(stats) {
  const buys = firstNumber(stats, ['buy_count','buyCount','buy']);
  const sells = firstNumber(stats, ['sell_count','sellCount','sell']);
  if (Number.isFinite(buys) || Number.isFinite(sells)) return (Number(buys) || 0) + (Number(sells) || 0);
  return firstNumber(stats, ['trade_count','tradeCount','token_num','tokenNum','total_trades','totalTrades','tokens_traded']);
}

async function discoverWallets() {
  const feed = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
  const candidates = extractWallets(feed).slice(0, 20);
  lastDiagnostics = { candidates: candidates.length, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, approved: 0 };
  if (!candidates.length) return [];

  const walletArgs = candidates.flatMap(wallet => ['--wallet', wallet]);
  await sleep(2500);
  const stats7Payload = await runGmgn(['portfolio','stats','--chain',config.chain,...walletArgs,'--period','7d']);
  await sleep(2500);
  const stats30Payload = await runGmgn(['portfolio','stats','--chain',config.chain,...walletArgs,'--period','30d']);

  const s7 = statsMap(stats7Payload, candidates);
  const s30 = statsMap(stats30Payload, candidates);
  lastDiagnostics.mapped7d = s7.size;
  lastDiagnostics.mapped30d = s30.size;
  const scored = [];

  for (const wallet of candidates) {
    const seven = s7.get(wallet);
    const thirty = s30.get(wallet);
    if (!seven || !thirty) {
      lastDiagnostics.rejectedMissingStats++;
      continue;
    }

    const win7 = normalizeWinRate(firstNumber(seven, ['winrate','win_rate','winRate']));
    const win30 = normalizeWinRate(firstNumber(thirty, ['winrate','win_rate','winRate']));
    const pnl30 = firstNumber(thirty, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
    const trades30 = readTradeCount(thirty);
    const item = { wallet, win7, win30, pnl30, trades30, score: scoreWallet({ win7, win30, pnl30, trades30 }) };

    if ((trades30 || 0) < config.minTrades30d) {
      lastDiagnostics.rejectedTradeCount++;
      continue;
    }
    if (win30 < config.minWinRate30d) {
      lastDiagnostics.rejectedWinRate++;
      continue;
    }
    scored.push(item);
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
