'use strict';

const http = require('node:http');
const config = require('./config');
const { runGmgn, flatten } = require('./gmgn');
const { discoverWallets } = require('./wallet-finder');
const PaperEngine = require('./paper-engine');

const engine = new PaperEngine();
let approved = new Set();
const seen = new Set();
const runtime = {
  startedAt: new Date().toISOString(),
  wallets: [],
  lastWalletRefreshAt: null,
  lastPollAt: null,
  lastError: null,
  lastSignalCount: 0,
  source: 'GMGN Smart Money'
};

const walletKeys = ['wallet_address','wallet','trader_address','trader','maker','maker_address','owner_address','owner'];
const tokenKeys = ['token_address','token','mint','token_mint','base_address','address'];
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
  try {
    const wallets = await discoverWallets();
    runtime.wallets = wallets;
    runtime.lastWalletRefreshAt = new Date().toISOString();
    runtime.lastError = null;
    approved = new Set(wallets.map(w => w.wallet));
    console.log('[WALLETS]', JSON.stringify(wallets));
    return wallets;
  } catch (error) {
    runtime.lastError = `Wallet discovery: ${error.message}`;
    console.error('[wallet refresh]', error.message);
    return runtime.wallets;
  }
}

async function pollSignals() {
  try {
    const [buys, sells] = await Promise.all([
      runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]),
      runGmgn(['track','smartmoney','--chain',config.chain,'--side','sell','--limit',String(config.smartMoneyLimit)])
    ]);

    const buyEvents = parseEvents(buys, 'buy');
    const sellEvents = parseEvents(sells, 'sell');
    runtime.lastSignalCount = buyEvents.length + sellEvents.length;
    runtime.lastPollAt = new Date().toISOString();

    for (const e of buyEvents) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (approved.has(e.wallet)) await engine.open(e.wallet, e.token, e.id);
    }

    for (const e of sellEvents) {
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
    runtime.lastError = null;
  } catch (error) {
    runtime.lastError = `Signal poll: ${error.message}`;
    console.error('[poll]', error.message);
  }
}

function statusPayload() {
  return {
    name: 'Copy Trading Bot',
    running: true,
    mode: 'paper',
    source: runtime.source,
    apiMode: process.env.GMGN_API_KEY ? 'personal_key' : 'public_demo_key',
    startedAt: runtime.startedAt,
    lastWalletRefreshAt: runtime.lastWalletRefreshAt,
    lastPollAt: runtime.lastPollAt,
    lastError: runtime.lastError,
    lastSignalCount: runtime.lastSignalCount,
    config: {
      paperTradeUsd: config.paperTradeUsd,
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      liquidityExitDropPct: config.liquidityExitDropPct,
      maxOpenPositions: config.maxOpenPositions,
      pollMs: config.pollMs,
      maxWallets: config.maxWallets,
      minTrades30d: config.minTrades30d,
      minWinRate30d: config.minWinRate30d
    },
    wallets: runtime.wallets,
    paper: engine.snapshot()
  };
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function dashboardPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Copy Trading Bot</title><style>
  :root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e7edf7;background:#07101b}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07101b,#0b1420);min-height:100vh}.wrap{max-width:1400px;margin:auto;padding:24px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.14em;color:#7f93ae;font-weight:800}.title{font-size:30px;margin:5px 0 0}.badge{border:1px solid #1dba77;color:#7cf0bb;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.panel{background:#0e1927;border:1px solid #1b2a3e;border-radius:14px}.card{padding:16px}.card span{display:block;color:#8192aa;font-size:11px;letter-spacing:.08em;font-weight:800}.card strong{display:block;font-size:22px;margin-top:7px}.panel{margin-top:14px;padding:18px;overflow:auto}.panel h2{font-size:14px;letter-spacing:.08em;margin:0 0 4px}.sub{color:#8192aa;font-size:12px;margin-bottom:14px}.notice{margin-top:14px;padding:11px 13px;border:1px solid #374866;border-radius:10px;color:#b9c6d8;background:#111e2d}.error{border-color:#7f3e48;color:#ffadb7}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:right;border-bottom:1px solid #1b2a3e;padding:10px 8px;white-space:nowrap}th{color:#71839b;font-size:10px;letter-spacing:.07em}th:first-child,td:first-child{text-align:left}.pos{color:#68e0a8}.neg{color:#ff7f90}.wallet{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.back{color:#a8bdd8;text-decoration:none;font-size:13px}.status{color:#7cf0bb}.muted{color:#8192aa}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}.wrap{padding:14px}.title{font-size:23px}}
  </style></head><body><main class="wrap"><div class="top"><div><div class="eyebrow">ONE COIN OPERATIONS</div><h1 class="title">Copy Trading Bot</h1><a class="back" href="https://solana-one-coin-bot-production.up.railway.app/">← Main dashboard</a></div><span class="badge">PAPER ONLY · $5</span></div><div id="app"><div class="notice">Loading Copy Trading Bot…</div></div></main><script>
  const money=v=>v==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(Number(v));
  const pct=v=>v==null?'—':(Number(v)>=0?'+':'')+Number(v).toFixed(2)+'%';
  const dt=v=>!v?'—':new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v));
  const short=v=>v?String(v).slice(0,5)+'…'+String(v).slice(-4):'—';
  const esc=v=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  async function load(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('Status '+r.status);const d=await r.json(),m=d.paper.metrics,c=d.config;
  const walletRows=(d.wallets||[]).map(w=>'<tr><td class="wallet" title="'+esc(w.wallet)+'">'+esc(short(w.wallet))+'</td><td>'+Number(w.score||0).toFixed(1)+'</td><td>'+pct(w.win7)+'</td><td>'+pct(w.win30)+'</td><td>'+money(w.pnl30)+'</td><td>'+esc(w.trades30??'—')+'</td></tr>').join('');
  const open=(d.paper.openPositions||[]).map(p=>'<tr><td>'+esc(p.symbol||short(p.token))+'</td><td class="wallet">'+esc(short(p.wallet))+'</td><td>'+money(p.amountUsd)+'</td><td>'+money(p.entryPrice)+'</td><td>'+money(p.lastPrice)+'</td><td class="'+(Number(p.unrealizedPnlUsd)>=0?'pos':'neg')+'">'+money(p.unrealizedPnlUsd)+'</td><td>'+pct(p.unrealizedPnlPct)+'</td><td>'+dt(p.openedAt)+'</td></tr>').join('');
  const closed=(d.paper.closedTrades||[]).map(t=>'<tr><td>'+dt(t.closedAt)+'</td><td>'+esc(t.symbol||short(t.token))+'</td><td class="wallet">'+esc(short(t.wallet))+'</td><td>'+money(t.amountUsd)+'</td><td class="'+(Number(t.pnlUsd)>=0?'pos':'neg')+'">'+money(t.pnlUsd)+'</td><td>'+pct(t.pnlPct)+'</td><td>'+esc(t.reason)+'</td></tr>').join('');
  document.getElementById('app').innerHTML='<div class="grid"><div class="card"><span>STATUS</span><strong class="status">RUNNING · PAPER</strong></div><div class="card"><span>APPROVED WALLETS</span><strong>'+esc((d.wallets||[]).length)+'</strong></div><div class="card"><span>OPEN POSITIONS</span><strong>'+esc(m.openPositions)+'</strong></div><div class="card"><span>REALIZED P&L</span><strong class="'+(Number(m.realizedPnlUsd)>=0?'pos':'neg')+'">'+money(m.realizedPnlUsd)+'</strong></div><div class="card"><span>WIN RATE</span><strong>'+pct(m.winRate)+'</strong></div><div class="card"><span>CLOSED TRADES</span><strong>'+esc(m.closedTrades)+'</strong></div><div class="card"><span>UNREALIZED P&L</span><strong class="'+(Number(m.unrealizedPnlUsd)>=0?'pos':'neg')+'">'+money(m.unrealizedPnlUsd)+'</strong></div><div class="card"><span>LAST GMGN POLL</span><strong style="font-size:14px">'+dt(d.lastPollAt)+'</strong></div></div>'+
  (d.lastError?'<div class="notice error">'+esc(d.lastError)+'</div>':'<div class="notice">Wallet source: '+esc(d.source)+' · '+(d.apiMode==='public_demo_key'?'public read-only test key':'personal API key')+' · TP +'+esc(c.takeProfitPct)+'% · stop −'+esc(c.stopLossPct)+'% · liquidity emergency −'+esc(c.liquidityExitDropPct)+'% · max '+esc(c.maxOpenPositions)+' open positions.</div>')+
  '<section class="panel"><h2>APPROVED SMART-MONEY WALLETS</h2><div class="sub">Ranked by 7d/30d consistency, win rate, trade evidence and 30d realized performance</div><table><thead><tr><th>WALLET</th><th>SCORE</th><th>7D WIN</th><th>30D WIN</th><th>30D P&L</th><th>TRADES</th></tr></thead><tbody>'+(walletRows||'<tr><td colspan="6" class="muted">Waiting for qualifying wallets.</td></tr>')+'</tbody></table></section>'+
  '<section class="panel"><h2>OPEN COPY POSITIONS</h2><div class="sub">$5 simulated entries copied from approved-wallet buys</div><table><thead><tr><th>TOKEN</th><th>LEADER</th><th>SIZE</th><th>ENTRY</th><th>LAST</th><th>P&L</th><th>RETURN</th><th>OPENED (PR)</th></tr></thead><tbody>'+(open||'<tr><td colspan="8" class="muted">No open paper positions.</td></tr>')+'</tbody></table></section>'+
  '<section class="panel"><h2>CLOSED COPY TRADES</h2><div class="sub">Our exits plus leader-sell and liquidity emergency protection</div><table><thead><tr><th>CLOSED (PR)</th><th>TOKEN</th><th>LEADER</th><th>SIZE</th><th>P&L</th><th>RETURN</th><th>EXIT</th></tr></thead><tbody>'+(closed||'<tr><td colspan="7" class="muted">No closed copy trades yet.</td></tr>')+'</tbody></table></section>';
  }catch(e){document.getElementById('app').innerHTML='<div class="notice error">'+esc(e.message)+'</div>';}}
  load();setInterval(load,15000);
  </script></body></html>`;
}

function startHttpServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/healthz') return json(res, { ok: true, name: 'Copy Trading Bot', mode: 'paper' });
    if (route === '/api/status') return json(res, statusPayload());
    if (route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(dashboardPage());
    }
    return json(res, { error: 'Not found' }, 404);
  });
  server.listen(port, '0.0.0.0', () => console.log(`[COPY TRADING BOT] dashboard listening on ${port}`));
}

async function main() {
  if (config.mode !== 'paper') throw new Error('Copy Trading Bot is locked to paper mode.');
  console.log(`[COPY TRADING BOT] PAPER ONLY | $${config.paperTradeUsd} simulated positions`);
  startHttpServer();
  await refreshWallets();
  setInterval(() => refreshWallets(), config.walletRefreshMs).unref();

  while (true) {
    await pollSignals();
    await new Promise(r => setTimeout(r, config.pollMs));
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
