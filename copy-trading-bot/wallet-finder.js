'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','address','trader_address','trader','maker','maker_address','owner_address','owner'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stateDir = path.dirname(process.env.COPY_STATE_FILE || path.join(__dirname, 'paper-state.json'));
const poolFile = process.env.COPY_WALLET_POOL_FILE || path.join(stateDir, 'copy-wallet-pool.json');
const POOL_RETENTION_MS = Number(process.env.COPY_WALLET_POOL_RETENTION_MS || 2 * 60 * 60 * 1000);
const MAX_NEW_PER_REFRESH = Number(process.env.COPY_WALLET_POOL_MAX_NEW_PER_REFRESH || 10);
let lastDiagnostics = { candidates: 0, smartMoneyCandidates: 0, kolCandidates: 0, universeCandidates: 0, mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0, rejectedTradeCount: 0, rejectedWinRate: 0, rejectedProfitability: 0, rejectedTradeCount7d: 0, rejectedWinRate7d: 0, rejectedProfitability7d: 0, approved: 0, retained: 0, added: 0, removed: 0 };

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

function loadPoolState() {
  try {
    const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
    return {
      candidateCursor: Number.isSafeInteger(raw.candidateCursor) && raw.candidateCursor >= 0 ? raw.candidateCursor : 0,
      wallets: Array.isArray(raw.wallets) ? raw.wallets.filter(w => looksLikeSolanaAddress(w.wallet)) : []
    };
  } catch {
    return { candidateCursor: 0, wallets: [] };
  }
}

function savePool(wallets, candidateCursor = 0) {
  try {
    fs.mkdirSync(path.dirname(poolFile), { recursive: true });
    fs.writeFileSync(poolFile, JSON.stringify({ updatedAt: new Date().toISOString(), candidateCursor, wallets }, null, 2));
  } catch (error) {
    console.error('[wallet-pool save]', error.message);
  }
}

function statsRows(payload, requestedWallets) {
  const list = payload && (payload.list || payload.data?.list || payload.data || payload.result?.list);
  const rows = Array.isArray(list) ? list : Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? [payload] : []);
  const mapped = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const wallet = row.wallet_address || row.wallet || row.address || row.trader_address || requestedWallets[i];
    if (wallet) mapped.set(wallet, row);
  }
  return mapped;
}

async function batchWalletStats(wallets, period) {
  const result = new Map();
  for (let offset = 0; offset < wallets.length; offset += 20) {
    const batch = wallets.slice(offset, offset + 20);
    const args = ['portfolio','stats','--chain',config.chain];
    for (const wallet of batch) args.push('--wallet',wallet);
    args.push('--period',period);
    try {
      const payload = await runGmgn(args);
      const mapped = statsRows(payload, batch);
      for (const wallet of batch) {
        const row = mapped.get(wallet);
        if (row) result.set(wallet, row);
        else lastDiagnostics.rejectedMissingStats++;
      }
    } catch (error) {
      console.error(`[wallet-finder] ${period} batch stats skip: ${error.message}`);
      for (const wallet of batch) lastDiagnostics.rejectedMissingStats++;
    }
  }
  return result;
}

async function discoverWallets({ excludedWallets = [] } = {}) {
  const excluded = new Set(excludedWallets);
  const feedSpecs = [
    { source: 'smartmoney', side: 'buy' },
    { source: 'smartmoney', side: 'sell' },
    { source: 'kol', side: 'buy' },
    { source: 'kol', side: 'sell' }
  ];
  const feedResults = await Promise.all(feedSpecs.map(async spec => {
    try {
      const payload = await runGmgn(['track',spec.source,'--chain',config.chain,'--side',spec.side,'--limit',String(config.smartMoneyLimit)]);
      return { ...spec, payload, error: null };
    } catch (error) {
      return { ...spec, payload: null, error };
    }
  }));
  for (const result of feedResults.filter(r => r.error)) {
    console.error(`[wallet-finder] ${result.source}/${result.side} feed failed:`, result.error.message || result.error);
  }
  if (feedResults.every(r => r.error)) throw new Error('All GMGN wallet feeds failed');

  const previousState = loadPoolState();
  const walletsFromSource = source => [...new Set(feedResults
    .filter(r => !r.error && r.source === source)
    .flatMap(r => extractWallets(r.payload)))];
  const smartMoneyWallets = walletsFromSource('smartmoney');
  const kolWallets = walletsFromSource('kol');
  const candidateUniverse = [];
  const seenUniverse = new Set();
  const maxSourceRows = Math.max(smartMoneyWallets.length, kolWallets.length);
  for (let i = 0; i < maxSourceRows; i++) {
    for (const wallet of [smartMoneyWallets[i], kolWallets[i]]) {
      if (!wallet || excluded.has(wallet) || seenUniverse.has(wallet)) continue;
      seenUniverse.add(wallet);
      candidateUniverse.push(wallet);
    }
  }

  const offset = candidateUniverse.length ? previousState.candidateCursor % candidateUniverse.length : 0;
  const activeWallets = previousState.wallets.map(w => w.wallet).filter(wallet => !excluded.has(wallet));
  const prioritized = activeWallets.slice(0, config.walletCandidatesPerScan);
  const candidateSet = new Set(prioritized);
  const rotating = [];
  const freshBudget = Math.max(0, config.walletCandidatesPerScan - prioritized.length);
  let scannedFromUniverse = 0;
  while (rotating.length < freshBudget && scannedFromUniverse < candidateUniverse.length) {
    const wallet = candidateUniverse[(offset + scannedFromUniverse) % candidateUniverse.length];
    scannedFromUniverse++;
    if (candidateSet.has(wallet)) continue;
    candidateSet.add(wallet);
    rotating.push(wallet);
  }
  const candidates = [...prioritized, ...rotating];
  const nextCandidateCursor = candidateUniverse.length ? (offset + scannedFromUniverse) % candidateUniverse.length : 0;
  lastDiagnostics = {
    candidates: candidates.length,
    smartMoneyCandidates: smartMoneyWallets.length,
    kolCandidates: kolWallets.length,
    universeCandidates: candidateUniverse.length,
    mapped7d: 0, mapped30d: 0, rejectedMissingStats: 0,
    rejectedTradeCount: 0, rejectedWinRate: 0, rejectedProfitability: 0,
    rejectedTradeCount7d: 0, rejectedWinRate7d: 0, rejectedProfitability7d: 0,
    approved: 0, retained: 0, added: 0, removed: 0
  };
  if (!candidates.length) {
    const retained = previousState.wallets
      .filter(w => !excluded.has(w.wallet) && Date.now() - Date.parse(w.lastQualifiedAt || w.addedAt || 0) <= POOL_RETENTION_MS)
      .slice(0, config.maxWallets);
    lastDiagnostics.retained = retained.length;
    lastDiagnostics.approved = retained.length;
    savePool(retained, nextCandidateCursor);
    return retained;
  }

  const thirtyDayQualified = [];
  const failedCurrentCandidates = new Set();
  const thirtyDayStats = await batchWalletStats(candidates, '30d');
  for (const wallet of candidates) {
    const thirty = thirtyDayStats.get(wallet);
    if (!thirty) {
      failedCurrentCandidates.add(wallet);
      continue;
    }
    lastDiagnostics.mapped30d++;

    const trades30 = readTradeCount(thirty);
    if ((trades30 || 0) < config.minTrades30d) {
      lastDiagnostics.rejectedTradeCount++;
      failedCurrentCandidates.add(wallet);
      continue;
    }

    const win30 = normalizeWinRate(firstNumber(thirty, ['winrate','win_rate','winRate']));
    if (win30 < config.minWinRate30d) {
      lastDiagnostics.rejectedWinRate++;
      failedCurrentCandidates.add(wallet);
      continue;
    }

    const pnl30 = firstNumber(thirty, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
    if (!Number.isFinite(pnl30) || pnl30 <= 0) {
      lastDiagnostics.rejectedProfitability++;
      failedCurrentCandidates.add(wallet);
      continue;
    }

    thirtyDayQualified.push({ wallet, win30, trades30, pnl30 });
  }

  const sevenDayStats = await batchWalletStats(thirtyDayQualified.map(row => row.wallet), '7d');
  const scored = [];
  for (const base of thirtyDayQualified) {
    const seven = sevenDayStats.get(base.wallet);
    if (!seven) {
      failedCurrentCandidates.add(base.wallet);
      continue;
    }
    lastDiagnostics.mapped7d++;
    const trades7 = readTradeCount(seven);
    if (!Number.isFinite(trades7) || trades7 < config.minTrades7d) {
      lastDiagnostics.rejectedTradeCount7d++;
      failedCurrentCandidates.add(base.wallet);
      continue;
    }
    const win7 = normalizeWinRate(firstNumber(seven, ['winrate','win_rate','winRate']));
    if (!Number.isFinite(win7) || win7 < config.minWinRate7d) {
      lastDiagnostics.rejectedWinRate7d++;
      failedCurrentCandidates.add(base.wallet);
      continue;
    }
    const pnl7 = firstNumber(seven, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
    if (!Number.isFinite(pnl7) || pnl7 <= 0) {
      lastDiagnostics.rejectedProfitability7d++;
      failedCurrentCandidates.add(base.wallet);
      continue;
    }
    scored.push({
      wallet: base.wallet,
      win7,
      win30: base.win30,
      pnl7,
      pnl30: base.pnl30,
      trades30: base.trades30,
      score: scoreWallet({ win7, win30: base.win30, pnl30: base.pnl30, trades30: base.trades30 })
    });
  }

  const now = new Date().toISOString();
  const pool = new Map();

  for (const old of previousState.wallets) {
    const lastQualifiedMs = Date.parse(old.lastQualifiedAt || old.addedAt || 0);
    const expired = !Number.isFinite(lastQualifiedMs) || Date.now() - lastQualifiedMs > POOL_RETENTION_MS;
    const explicitlyFailed = candidateSet.has(old.wallet) && failedCurrentCandidates.has(old.wallet);
    if (expired || explicitlyFailed || excluded.has(old.wallet)) {
      lastDiagnostics.removed++;
      continue;
    }
    pool.set(old.wallet, old);
    lastDiagnostics.retained++;
  }

  const scoredSorted = scored.sort((a,b) => b.score - a.score);
  for (const row of scoredSorted) {
    if (pool.has(row.wallet)) {
      const old = pool.get(row.wallet);
      pool.set(row.wallet, { ...old, ...row, lastQualifiedAt: now });
    }
  }

  let additions = 0;
  for (const row of scoredSorted) {
    if (pool.has(row.wallet)) continue;
    if (pool.size >= config.maxWallets || additions >= MAX_NEW_PER_REFRESH) break;
    pool.set(row.wallet, { ...row, addedAt: now, lastQualifiedAt: now });
    additions++;
    lastDiagnostics.added++;
  }

  const approved = [...pool.values()]
    .sort((a,b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, config.maxWallets);

  savePool(approved, nextCandidateCursor);
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
