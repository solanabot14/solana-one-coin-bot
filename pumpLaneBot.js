'use strict';
const trader = require('./pumpLaneTrader');
const { evaluatePumpCandidate } = require('./pumpLaneFilter');
let running = false, error = null, socket = null, reconnect = null;
const watched = new Map();
const solValue = raw => Number(raw) >= 1000 ? Number(raw) / 1e9 : Number(raw);
function getStatus() { return { running, error, watched: watched.size, live: false, mode: 'PAPER' }; }
function connect() {
  if (!running) return;
  try {
    const ws = new WebSocket(process.env.PUMP_PORTAL_WS || 'wss://pumpportal.fun/api/data');
    socket = ws;
    ws.addEventListener('open', () => { if (!running || socket !== ws) return ws.close(); error = null; ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (watched.size) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...watched.keys()] }));
    });
    ws.addEventListener('message', event => {
      if (!running || socket !== ws) return;
      try {
        const t = JSON.parse(String(event.data));
        if (!t.mint) return;
        if (t.txType === 'create') {
          if (watched.has(t.mint)) return;
          if (watched.size >= 80) {
            const position = trader.getState().position;
            const oldest = [...watched.keys()].find(m => m !== position?.tokenAddress);
            watched.delete(oldest);
            ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [oldest] }));
          }
          const creator = t.traderPublicKey || t.creator;
          watched.set(t.mint, { mint: t.mint, symbol: t.symbol, createdAt: Date.now(), creator, creationSignature: t.signature, creationSlot: t.slot, buyCount: 0, sellCount: 0, uniqueTraders: new Set(), creatorBuyTokens: Number(t.tokenAmount) || 0, creatorSellTokens: 0, virtualSolReserves: t.vSolInBondingCurve, virtualTokenReserves: t.vTokensInBondingCurve, marketCapSol: t.marketCapSol, graduated: !!(t.graduated || t.complete), nsfw: !!t.nsfw });
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [t.mint] }));
          return; // Creation transaction is never an entry.
        }
        const c = watched.get(t.mint);
        if (!c) return;
        if (t.graduated || t.complete || t.txType === 'migrate') c.graduated = true;
        if (t.nsfw) c.nsfw = true;
        if (t.txType !== 'buy' && t.txType !== 'sell') return;
        if ((t.signature && t.signature === c.creationSignature) || (t.slot != null && t.slot === c.creationSlot)) return;
        if (t.vSolInBondingCurve != null) c.virtualSolReserves = t.vSolInBondingCurve;
        if (t.vTokensInBondingCurve != null) c.virtualTokenReserves = t.vTokensInBondingCurve;
        if (t.marketCapSol != null) c.marketCapSol = t.marketCapSol;
        c[t.txType === 'buy' ? 'buyCount' : 'sellCount']++;
        if (t.traderPublicKey) c.uniqueTraders.add(t.traderPublicKey);
        if (c.creator && t.traderPublicKey === c.creator) c[t.txType === 'buy' ? 'creatorBuyTokens' : 'creatorSellTokens'] += Number(t.tokenAmount) || 0;
        const solUsd = Number(process.env.SOL_USD_PRICE || 150);
        const price = Number(t.solAmount) > 0 && Number(t.tokenAmount) > 0 ? Number(t.solAmount) / Number(t.tokenAmount) * solUsd : solValue(c.virtualSolReserves) / Number(c.virtualTokenReserves) * solUsd;
        trader.touchScan();
        const p = trader.getState().position;
        if (p?.tokenAddress === t.mint) { trader.decideExit(price); return; }
        if (p) return;
        const result = evaluatePumpCandidate(c);
        if (!result.accepted) { trader.recordRejection(c, result.reason); return; }
        if (Number.isFinite(price) && price > 0) trader.buy({ ...c, priceUsd: price });
      } catch (e) { error = e.message; console.error('[Pump Lane PAPER]', error); }
    });
    ws.addEventListener('error', event => { if (socket === ws) error = event.message || 'WebSocket error'; });
    ws.addEventListener('close', () => { if (socket !== ws) return; socket = null; if (running) reconnect = setTimeout(connect, 5000); });
  } catch (e) { error = e.message; if (running) reconnect = setTimeout(connect, 5000); }
}
function start() {
  if (running) return getStatus();
  const saved = trader.getState(); // Validate durable paper state before booting the feed.
  if (saved.position && !watched.has(saved.position.tokenAddress)) {
    watched.set(saved.position.tokenAddress, { mint: saved.position.tokenAddress, symbol: saved.position.symbol, createdAt: saved.position.entryAt, buyCount: 0, sellCount: 0, uniqueTraders: new Set(), creatorBuyTokens: 0, creatorSellTokens: 0 });
  }
  running = true; error = null;
  console.log('[Pump Lane] PAPER only');
  connect(); return getStatus();
}
function stop() { running = false; clearTimeout(reconnect); reconnect = null; const old = socket; socket = null; if (old) old.close(); return getStatus(); }
module.exports = { start, stop, getStatus };
