'use strict';

const config = require('./config');
const { runGmgn, flatten, firstNumber } = require('./gmgn');

const WALLET_KEYS = ['wallet_address','wallet','address','trader_address','trader','maker','maker_address','owner_address','owner'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function statsMap(payload, candidates) {
  const rows = Array.isArray(payload) ? payload : flatten(payload).filter(row => row && typeof row === 'object');
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const wallet = rowWallet(rows[i]) || candidates[i];
    if (wallet) map.set(wallet, rows[i]);
  }
  return map;
}

async function discoverWallets() {
  const feed = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
  const candidates = extractWallets(feed).slice(0, 20);
  if (!candidates.length) return [];

  const walletArgs = candidates.flatMap(wallet => ['--wallet', wallet]);
  await sleep(2500);
  const stats7Payload = await runGmgn(['portfolio','stats','--chain',config.chain,...walletArgs,'--period','7d']);
  await sleep(2500);
  const stats30Payload = await runGmgn(['portfolio','stats','--chain',config.chain,...walletArgs,'--period','30d']);

  const s7 = statsMap(stats7Payload, candidates);
  const s30 = statsMap(stats30Payload, candidates);
  const scored = [];

  for (const wallet of candidates) {
    const seven = s7.get(wallet) || {};
    const thirty = s30.get(wallet) || {};
    const win7 = normalizeWinRate(firstNumber(seven, ['winrate','win_rate','winRate']));
    const win30 = normalizeWinRate(firstNumber(thirty, ['winrate','win_rate','winRate']));
    const pnl30 = firstNumber(thirty, ['realized_profit','realizedProfit','total_profit','totalProfit','pnl','profit']);
    const buys = firstNumber(thirty, ['buy_count','buyCount']) || 0;
    const sells = firstNumber(thirty, ['sell_count','sellCount']) || 0;
    const trades30 = buys + sells || firstNumber(thirty, ['trade_count','tradeCount','token_num','tokenNum','total_trades','totalTrades','tokens_traded']);
    const item = { wallet, win7, win30, pnl30, trades30, score: scoreWallet({ win7, win30, pnl30, trades30 }) };
    if ((trades30 || 0) >= config.minTrades30d && win30 >= config.minWinRate30d) scored.push(item);
  }

  return scored.sort((a,b) => b.score - a.score).slice(0, config.maxWallets);
}

if (require.main === module) {
  discoverWallets().then(rows => console.log(JSON.stringify({ mode: 'paper', wallets: rows }, null, 2))).catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { discoverWallets, extractWallets, scoreWallet };
