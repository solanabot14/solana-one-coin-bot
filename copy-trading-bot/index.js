'use strict';

const http = require('node:http');
const config = require('./config');
const { runGmgn, flatten } = require('./gmgn');
const { discoverWallets, getLastDiagnostics } = require('./wallet-finder');
const PaperEngine = require('./paper-engine');

const engine = new PaperEngine();
let approved = new Set();
const seen = new Set();
let signalsPrimed = false;
let riskRunning = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runtime = {
  startedAt: new Date().toISOString(), wallets: [], walletDiagnostics: getLastDiagnostics(), lastWalletRefreshAt: null,
  lastPollAt: null, lastRiskCheckAt: null, lastError: null, lastSignalCount: 0, source: 'GMGN Smart Money',
  signalsPrimedAt: null, staleBuysRejected: 0, unknownAgeBuysRejected: 0, suspendedBuySignals: 0
};

const walletKeys = ['wallet_address','wallet','trader_address','trader','maker','maker_address','owner_address','owner'];
const tokenKeys = ['token_address','token','mint','token_mint','base_address','address'];
const idKeys = ['signature','tx_hash','txHash','transaction_hash','transactionHash','id'];
const sideKeys = ['side','action','type','event_type'];
const timeKeys = ['timestamp','time','created_at','createdAt','block_time','blockTime','tx_time','txTime'];
const isSolAddress = v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

function getString(row, keys) { for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k]; return null; }
function eventTime(row) {
  for (const k of timeKeys) {
    const v = row && row[k];
    if (v == null || v === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString();
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return null;
}
function parseEvents(payload, forcedSide) {
  const out = [];
  const localSeen = new Set();
  for (const row of flatten(payload)) {
    const wallet = getString(row, walletKeys), token = getString(row, tokenKeys);
    if (!isSolAddress(wallet) || !isSolAddress(token) || wallet === token) continue;
    const side = (forcedSide || getString(row, sideKeys) || '').toLowerCase();
    const at = eventTime(row);
    const id = getString(row, idKeys) || `${wallet}:${token}:${side}:${at || ''}`;
    if (localSeen.has(id)) continue;
    localSeen.add(id);
    out.push({ wallet, token, side, id, at });
  }
  return out;
}
function freshBuy(e) {
  if (!e.at) return false;
  const ageSec = (Date.now() - new Date(e.at).getTime()) / 1000;
  return Number.isFinite(ageSec) && ageSec >= -15 && ageSec <= config.maxSignalAgeSec;
}

async function refreshWallets() {
  try {
    const discovered = await discoverWallets();
    const suspended = discovered.filter(w => engine.isWalletSuspended(w.wallet));
    const wallets = discovered.filter(w => !engine.isWalletSuspended(w.wallet));
    runtime.wallets = wallets;
    runtime.walletDiagnostics = { ...getLastDiagnostics(), approved: wallets.length, suspendedByCopyResults: suspended.length };
    runtime.lastWalletRefreshAt = new Date().toISOString();
    runtime.lastError = null;
    approved = new Set(wallets.map(w => w.wallet));
    console.log('[WALLET DIAGNOSTICS]', JSON.stringify(runtime.walletDiagnostics));
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
    const buys = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','buy','--limit',String(config.smartMoneyLimit)]);
    await sleep(2500);
    const sells = await runGmgn(['track','smartmoney','--chain',config.chain,'--side','sell','--limit',String(config.smartMoneyLimit)]);
    const buyEvents = parseEvents(buys, 'buy'), sellEvents = parseEvents(sells, 'sell');
    runtime.lastSignalCount = buyEvents.length + sellEvents.length;
    runtime.lastPollAt = new Date().toISOString();

    if (!signalsPrimed) {
      [...buyEvents, ...sellEvents].forEach(e => seen.add(e.id));
      signalsPrimed = true;
      runtime.signalsPrimedAt = new Date().toISOString();
      console.log('[SIGNALS PRIMED]', JSON.stringify({ buys: buyEvents.length, sells: sellEvents.length }));
      runtime.lastError = null;
      return;
    }

    for (const e of buyEvents) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!approved.has(e.wallet)) continue;
      if (!e.at) { runtime.unknownAgeBuysRejected++; console.log('[STALE BUY REJECTED]', JSON.stringify({ reason:'unknown_age', wallet:e.wallet, token:e.token, id:e.id })); continue; }
      if (!freshBuy(e)) { runtime.staleBuysRejected++; console.log('[STALE BUY REJECTED]', JSON.stringify({ reason:'too_old', wallet:e.wallet, token:e.token, id:e.id, at:e.at })); continue; }
      if (engine.isWalletSuspended(e.wallet)) { runtime.suspendedBuySignals++; continue; }
      await engine.open(e.wallet, e.token, e.id, e.at);
    }

    for (const e of sellEvents) {
      if (seen.has(e.id)) continue;
      if (!engine.hasPosition(e.wallet, e.token)) { seen.add(e.id); continue; }
      const p = engine.getPosition(e.wallet, e.token);
      if (e.at && p && new Date(e.at).getTime() < new Date(p.openedAt).getTime() - 5000) { seen.add(e.id); continue; }
      if (await engine.leaderSold(e.wallet, e.token, e.id, e.at)) seen.add(e.id);
    }

    if (seen.size > 5000) {
      const keep = [...seen].slice(-2500);
      seen.clear();
      keep.forEach(x => seen.add(x));
    }
    runtime.lastError = null;
  } catch (error) {
    runtime.lastError = `Signal poll: ${error.message}`;
    console.error('[poll]', error.message);
  }
}

async function riskCheck() {
  if (riskRunning) return;
  riskRunning = true;
  try {
    await engine.evaluate();
    runtime.lastRiskCheckAt = new Date().toISOString();
  } catch (error) {
    console.error('[risk check]', error.message);
  } finally {
    riskRunning = false;
  }
}

function statusPayload() {
  return {
    name:'Copy Trading Bot', running:true, mode:'paper', source:runtime.source,
    apiMode:process.env.GMGN_API_KEY?'personal_key':'public_demo_key', startedAt:runtime.startedAt,
    lastWalletRefreshAt:runtime.lastWalletRefreshAt, lastPollAt:runtime.lastPollAt, lastRiskCheckAt:runtime.lastRiskCheckAt,
    lastError:runtime.lastError, lastSignalCount:runtime.lastSignalCount, signalsPrimedAt:runtime.signalsPrimedAt,
    staleBuysRejected:runtime.staleBuysRejected, unknownAgeBuysRejected:runtime.unknownAgeBuysRejected, suspendedBuySignals:runtime.suspendedBuySignals,
    walletDiagnostics:runtime.walletDiagnostics,
    config:{
      paperTradeUsd:config.paperTradeUsd,maxOpenPositions:config.maxOpenPositions,pollMs:config.pollMs,riskCheckMs:config.riskCheckMs,
      maxWallets:config.maxWallets,minTrades30d:config.minTrades30d,minWinRate30d:config.minWinRate30d,maxSignalAgeSec:config.maxSignalAgeSec,
      minActivityVolume5mUsd:config.minActivityVolume5mUsd,minActivitySwaps5m:config.minActivitySwaps5m,inactivityExitSec:config.inactivityExitSec,maxHoldingSec:config.maxHoldingSec
    },
    wallets:runtime.wallets,paper:engine.snapshot()
  };
}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}

function dashboardPage(){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Copy Trading Bot</title><style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e7edf7;background:#07101b}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07101b,#0b1420);min-height:100vh}.wrap{max-width:1600px;margin:auto;padding:24px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.14em;color:#7f93ae;font-weight:800}.title{font-size:30px;margin:5px 0 0}.badge{border:1px solid #1dba77;color:#7cf0bb;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.panel{background:#0e1927;border:1px solid #1b2a3e;border-radius:14px}.card{padding:16px}.card span{display:block;color:#8192aa;font-size:11px;letter-spacing:.08em;font-weight:800}.card strong{display:block;font-size:22px;margin-top:7px}.panel{margin-top:14px;padding:18px;overflow:auto}.panel h2{font-size:14px;letter-spacing:.08em;margin:0 0 4px}.sub{color:#8192aa;font-size:12px;margin-bottom:14px}.notice{margin-top:14px;padding:11px 13px;border:1px solid #374866;border-radius:10px;color:#b9c6d8;background:#111e2d}.error{border-color:#7f3e48;color:#ffadb7}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:right;border-bottom:1px solid #1b2a3e;padding:10px 8px;white-space:nowrap}th{color:#71839b;font-size:10px;letter-spacing:.07em}th:first-child,td:first-child{text-align:left}.pos{color:#68e0a8}.neg{color:#ff7f90}.wallet,.tokenaddr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.back,.link{color:#8fc5ff;text-decoration:none}.link:hover{text-decoration:underline}.status{color:#7cf0bb}.muted{color:#8192aa}.small{font-size:11px}.pill{display:inline-block;border:1px solid #31435c;border-radius:999px;padding:3px 7px;color:#b9c6d8;background:#101d2c}.pill.bad{border-color:#7f3e48;color:#ffadb7}.trade-links{display:flex;gap:8px;justify-content:flex-end}.trade-links a{display:inline-block;padding:4px 7px;border:1px solid #31435c;border-radius:7px;color:#8fc5ff;text-decoration:none}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.wrap{padding:14px}.title{font-size:23px}}
</style></head><body><main class="wrap"><div class="top"><div><div class="eyebrow">ONE COIN OPERATIONS</div><h1 class="title">Copy Trading Bot</h1><a class="back" href="https://solana-one-coin-bot-production.up.railway.app/">← Main dashboard</a></div><span class="badge">PAPER ONLY · $5</span></div><div id="app"><div class="notice">Loading Copy Trading Bot…</div></div></main><script>
const money=v=>v==null||!Number.isFinite(Number(v))?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(Number(v));
const pct=v=>v==null||!Number.isFinite(Number(v))?'—':(Number(v)>=0?'+':'')+Number(v).toFixed(2)+'%';
const dt=v=>!v?'—':new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(v));
const age=v=>{if(!v)return'—';const s=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/1000));if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'};
const short=v=>v?String(v).slice(0,5)+'…'+String(v).slice(-4):'—';
const esc=v=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[s]));
const coinUrl=t=>'https://dexscreener.com/solana/'+encodeURIComponent(t||'');const walletUrl=w=>'https://solscan.io/account/'+encodeURIComponent(w||'');const tokenUrl=t=>'https://solscan.io/token/'+encodeURIComponent(t||'');
const links=(t,w)=>'<div class="trade-links"><a target="_blank" rel="noopener noreferrer" href="'+coinUrl(t)+'">Chart</a><a target="_blank" rel="noopener noreferrer" href="'+tokenUrl(t)+'">Token</a><a target="_blank" rel="noopener noreferrer" href="'+walletUrl(w)+'">Leader</a></div>';
async function load(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('Status '+r.status);const d=await r.json(),m=d.paper.metrics,c=d.config,x=d.walletDiagnostics||{};
const perf=new Map((d.paper.walletPerformance||[]).map(w=>[w.wallet,w]));
const walletRows=(d.wallets||[]).map(w=>{const p=perf.get(w.wallet)||{};return '<tr><td class="wallet"><a class="link" target="_blank" href="'+walletUrl(w.wallet)+'">'+esc(short(w.wallet))+'</a></td><td>'+Number(w.score||0).toFixed(1)+'</td><td>'+pct(w.win7)+'</td><td>'+pct(w.win30)+'</td><td>'+money(w.pnl30)+'</td><td>'+esc(w.trades30??'—')+'</td><td>'+pct(p.winRate)+'</td><td>'+money(p.realizedPnlUsd)+'</td><td><span class="pill '+(p.suspended?'bad':'')+'">'+(p.suspended?'SUSPENDED':'ACTIVE')+'</span></td></tr>'}).join('');
const perfRows=(d.paper.walletPerformance||[]).map(p=>'<tr><td class="wallet"><a class="link" target="_blank" href="'+walletUrl(p.wallet)+'">'+esc(short(p.wallet))+'</a></td><td>'+esc(p.trades)+'</td><td>'+esc(p.wins)+'</td><td>'+esc(p.losses)+'</td><td>'+pct(p.winRate)+'</td><td class="'+(Number(p.realizedPnlUsd)>=0?'pos':'neg')+'">'+money(p.realizedPnlUsd)+'</td><td>'+esc(p.consecutiveLosses)+'</td><td><span class="pill '+(p.suspended?'bad':'')+'">'+(p.suspended?'SUSPENDED':'ACTIVE')+'</span></td></tr>').join('');
const open=(d.paper.openPositions||[]).map(p=>'<tr><td><a class="link" target="_blank" href="'+coinUrl(p.token)+'">'+esc(p.symbol||short(p.token))+'</a><div class="small muted">'+esc(short(p.token))+'</div></td><td class="wallet"><a class="link" target="_blank" href="'+walletUrl(p.wallet)+'">'+esc(short(p.wallet))+'</a></td><td>'+money(p.amountUsd)+'</td><td>'+money(p.entryPrice)+'</td><td>'+money(p.lastPrice)+'</td><td class="'+(Number(p.unrealizedPnlUsd)>=0?'pos':'neg')+'">'+money(p.unrealizedPnlUsd)+'</td><td class="'+(Number(p.unrealizedPnlPct)>=0?'pos':'neg')+'">'+pct(p.unrealizedPnlPct)+'</td><td>'+money(p.recentVolume5mUsd)+' / '+esc(p.recentSwaps5m??'—')+'</td><td>'+(p.inactiveSinceAt?'<span class="pill bad">INACTIVE '+age(p.inactiveSinceAt)+'</span>':'<span class="pill">FOLLOW SELL / 10M IDLE / '+esc(Math.round(c.maxHoldingSec/60))+'M MAX</span>')+'</td><td>'+dt(p.openedAt)+'<div class="small muted">'+age(p.openedAt)+'</div></td><td>'+dt(p.lastCheckedAt)+'</td><td>'+links(p.token,p.wallet)+'</td></tr>').join('');
const closed=(d.paper.closedTrades||[]).map(t=>'<tr><td>'+dt(t.closedAt)+'</td><td><a class="link" target="_blank" href="'+coinUrl(t.token)+'">'+esc(t.symbol||short(t.token))+'</a></td><td class="wallet"><a class="link" target="_blank" href="'+walletUrl(t.wallet)+'">'+esc(short(t.wallet))+'</a></td><td>'+money(t.amountUsd)+'</td><td>'+money(t.entryPrice)+'</td><td>'+money(t.exitPrice)+'</td><td class="'+(Number(t.pnlUsd)>=0?'pos':'neg')+'">'+money(t.pnlUsd)+'</td><td class="'+(Number(t.pnlPct)>=0?'pos':'neg')+'">'+pct(t.pnlPct)+'</td><td><span class="pill">'+esc(t.reason)+'</span></td><td>'+links(t.token,t.wallet)+'</td></tr>').join('');
document.getElementById('app').innerHTML='<div class="grid"><div class="card"><span>STATUS</span><strong class="status">RUNNING · PAPER</strong></div><div class="card"><span>APPROVED WALLETS</span><strong>'+esc((d.wallets||[]).length)+'</strong></div><div class="card"><span>OPEN POSITIONS</span><strong>'+esc(m.openPositions)+'</strong></div><div class="card"><span>REALIZED P&L</span><strong class="'+(Number(m.realizedPnlUsd)>=0?'pos':'neg')+'">'+money(m.realizedPnlUsd)+'</strong></div><div class="card"><span>WIN RATE</span><strong>'+pct(m.winRate)+'</strong></div><div class="card"><span>STALE BUYS BLOCKED</span><strong>'+esc((d.staleBuysRejected||0)+(d.unknownAgeBuysRejected||0))+'</strong></div><div class="card"><span>ACTIVITY REJECTS</span><strong>'+esc((d.paper.activityDiagnostics||{}).rejected||0)+' / '+esc((d.paper.activityDiagnostics||{}).unavailable||0)+' missing</strong></div><div class="card"><span>LAST RISK CHECK</span><strong style="font-size:14px">'+dt(d.lastRiskCheckAt)+'</strong></div></div>'+(d.lastError?'<div class="notice error">'+esc(d.lastError)+'</div>':'<div class="notice"><b>Follow wallet strategy</b>: positions exit on its first detected sell, after '+esc(Math.round(c.inactivityExitSec/60))+' consecutive minutes with zero volume and zero swaps, or after '+esc(Math.round(c.maxHoldingSec/60))+' minutes regardless of activity. A valid price is required to close. Risk checks run every '+esc(Math.round(c.riskCheckMs/1000))+'s.</div>')+'<div class="notice">Wallet qualification: '+esc(x.candidates??0)+' candidates · '+esc(x.mapped30d??0)+' 30d stats · '+esc(x.rejectedWinRate??0)+' failed win rate · '+esc(x.approved??0)+' approved. Signals primed: '+dt(d.signalsPrimedAt)+'.</div><section class="panel"><h2>APPROVED SMART-MONEY WALLETS</h2><div class="sub">Historical GMGN quality plus our actual copied performance.</div><table><thead><tr><th>WALLET</th><th>SCORE</th><th>7D WIN</th><th>30D WIN</th><th>30D P&L</th><th>TRADES</th><th>COPY WIN</th><th>COPY P&L</th><th>COPY STATUS</th></tr></thead><tbody>'+(walletRows||'<tr><td colspan="9" class="muted">Waiting for qualifying wallets.</td></tr>')+'</tbody></table></section><section class="panel"><h2>COPY PERFORMANCE BY WALLET</h2><div class="sub">Our paper results, independent of the leader wallet historical stats.</div><table><thead><tr><th>WALLET</th><th>COPY TRADES</th><th>WINS</th><th>LOSSES</th><th>COPY WIN</th><th>COPY P&L</th><th>LOSS STREAK</th><th>STATUS</th></tr></thead><tbody>'+(perfRows||'<tr><td colspan="8" class="muted">No copied-wallet history yet.</td></tr>')+'</tbody></table></section><section class="panel"><h2>OPEN COPY POSITIONS</h2><table><thead><tr><th>TOKEN</th><th>LEADER</th><th>SIZE</th><th>ENTRY</th><th>LAST</th><th>P&L $</th><th>RETURN</th><th>5M VOLUME / SWAPS</th><th>EXIT STRATEGY</th><th>OPENED</th><th>LAST CHECK</th><th>LINKS</th></tr></thead><tbody>'+(open||'<tr><td colspan="12" class="muted">No open paper positions.</td></tr>')+'</tbody></table></section><section class="panel"><h2>CLOSED COPY TRADES</h2><table><thead><tr><th>CLOSED</th><th>TOKEN</th><th>LEADER</th><th>SIZE</th><th>ENTRY</th><th>EXIT</th><th>P&L $</th><th>RETURN</th><th>EXIT REASON</th><th>LINKS</th></tr></thead><tbody>'+(closed||'<tr><td colspan="10" class="muted">No closed paper positions yet.</td></tr>')+'</tbody></table></section>';}catch(e){document.getElementById('app').innerHTML='<div class="notice error">'+esc(e.message)+'</div>';}}load();setInterval(load,15000);
</script></body></html>`;}

function startHttpServer(){const port=Number(process.env.PORT||3000);const server=http.createServer((req,res)=>{const route=new URL(req.url,'http://localhost').pathname;if(route==='/healthz')return json(res,{ok:true,name:'Copy Trading Bot',mode:'paper'});if(route==='/api/status')return json(res,statusPayload());if(route==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(dashboardPage());}return json(res,{error:'Not found'},404);});server.listen(port,'0.0.0.0',()=>console.log(`[COPY TRADING BOT] dashboard listening on ${port}`));}

async function main(){
  if(config.mode!=='paper')throw new Error('Copy Trading Bot is locked to paper mode.');
  console.log(`[COPY TRADING BOT] PAPER ONLY | $${config.paperTradeUsd} simulated positions`);
  startHttpServer();
  await refreshWallets();
  await sleep(3000);
  setInterval(()=>refreshWallets(),config.walletRefreshMs).unref();
  setInterval(()=>riskCheck(),config.riskCheckMs).unref();
  await riskCheck();
  while(true){await pollSignals();await sleep(config.pollMs);}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
