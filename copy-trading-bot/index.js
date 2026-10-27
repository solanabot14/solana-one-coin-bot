'use strict';

const config = require('./config');
const { runGmgn, flatten } = require('./gmgn');
const { discoverWallets } = require('./wallet-finder');
const PaperEngine = require('./paper-engine');

const engine = new PaperEngine();
let approved = new Set();
const seen = new Set();

const walletKeys = ['wallet_address','wallet','trader_address','trader','maker','owner_address','owner'];
const tokenKeys = ['token_address','token','mint','token_mint','address'];
const idKeys = ['signature','tx_hash','txHash','transaction_hash','transactionHash','id'];
const sideKeys = ['side','action','type','event_type'];

const isSolAddress = v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

function getString(row, keys) {
  for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k];
  return null;
}

function parseEvents(payload, forcedSide) {
  const out = [];
  for (const row of flatten(payload)) {
    const wallet = getString(row, walletKeys);
    const token = getString(row, tokenKeys);
    if (!isSolAddress(wallet) || !isSolAddress(token) || wallet === token) continue;
    const side = (forcedSide || getString(row, sideKeys) || '').toLowerCase();
    const id = getString(row, idKeys) || `${wallet}:${token}:${side}:${row.timestamp || row.time || ''}`;
    out.push({ wallet, token, side, id });
  }
  return out;
}

async function refreshWallets() {
  const wallets = await discoverWallets();
  approved = new Set(wallets.map(w => w.wallet));
  console.log('[WALLETS]', JSON.stringify(wallets));
}

async function pollSignals() {
  const [buys, sells] = await Promise.all([
    runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]),
    runGmgn(['track','smartmoney','--chain',config.chain,'--side','sell','--limit',String(config.smartMoneyLimit)])
  ]);

  for (const e of parseEvents(buys, 'buy')) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (approved.has(e.wallet)) await engine.open(e.wallet, e.token, e.id);
  }

  for (const e of parseEvents(sells, 'sell')) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (approved.has(e.wallet)) await engine.leaderSold(e.wallet, e.token);
  }

  if (seen.size > 5000) {
    const keep = [...seen].slice(-2500);
    seen.clear();
    keep.forEach(x => seen.add(x));
  }

  await engine.evaluate();
}

async function main() {
  if (config.mode !== 'paper') throw new Error('Copy Trading Bot is locked to paper mode.');
  console.log(`[COPY TRADING BOT] PAPER ONLY | $${config.paperTradeUsd} simulated positions`);
  await refreshWallets();
  setInterval(() => refreshWallets().catch(e => console.error('[wallet refresh]', e.message)), config.walletRefreshMs).unref();

  while (true) {
    try { await pollSignals(); }
    catch (e) { console.error('[poll]', e.message); }
    await new Promise(r => setTimeout(r, config.pollMs));
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
