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
const MAX_NEW_PER_REFRESH = Number(process.env.COPY_WALLET_POOL_MAX_NEW_PER_REFRESH || 2);
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

async function discoverWallets({ excludedWallets = [] } = {}) {
  const excluded = new Set(excludedWallets);
  const [smartMoneyResult, kolResult] = await Promise.allSettled([
    runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]),
    runGmgn(['track','kol','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)])
  ]);
  if (smartMoneyResult.status === 'rejected') console.error('[wallet-finder] smartmoney feed failed:', smartMoneyResult.reason?.message || smartMoneyResult.reason);
  if (kolResult.status === 'rejected') console.error('[wallet-finder] KOL feed failed:', kolResult.reason?.message || kolResult.reason);
  if (smartMoneyResult.status === 'rejected' && kolResult.status === 'rejected') {
    throw new Error('Both GMGN wallet feeds failed');
  }

  const previousState = loadPoolState();
  const smartMoneyWallets = smartMoneyResult.status === 'fulfilled' ? extractWallets(smartMoneyResult.value) : [];
  const kolWallets = kolResult.status === 'fulfilled' ? extractWallets(kolResult.value) : [];
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
  for (const wallet of candidates) {
    const thirty = await oneWalletStats(wallet, '30d');
    if (!thirty) {
      lastDiagnostics.rejectedMissingStats++;
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

  const scored = [];
  for (const base of thirtyDayQualified) {
    const seven = await oneWalletStats(base.wallet, '7d');
    if (!seven) {
      lastDiagnostics.rejectedMissingStats++;
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
