'use strict';
const trader = require('./pumpLaneTrader');
const { evaluatePumpCandidate } = require('./pumpLaneFilter');
const { createPumpLaneFreeFeed } = require('./pumpLaneFreeFeed');

let running = false, error = null, portalSocket = null, reconnect = null;
let newTokens = 0, tradeEvents = 0, acceptedCandidates = 0;
const rejectionCounts = Object.create(null);
const MAX_WATCHED = 80;
let freeFeed;

function tryCandidate(c) {
  if (!running || !c) return;
  trader.touchScan();
  const pos = trader.getState().position;
  if (pos?.tokenAddress === c.mint && c.lastPriceUsd > 0) {
    trader.decideExit(c.lastPriceUsd);
    return;
  }
  if (pos) return;
  const result = evaluatePumpCandidate({ ...c, tokenAddress: c.mint, ageMinutes: (Date.now() - c.createdAt) / 60000 });
  if (!result.accepted) {
    rejectionCounts[result.reason] = (rejectionCounts[result.reason] || 0) + 1;
    trader.recordRejection(c, result.reason);
    return;
  }
  if (Number.isFinite(c.lastPriceUsd) && c.lastPriceUsd > 0) {
    const bought = trader.buy({ ...c, tokenAddress: c.mint, priceUsd: c.lastPriceUsd });
    if (bought.success) { acceptedCandidates++; console.log('[Pump Lane] PAPER entry', c.symbol, c.mint); }
    else if (bought.error !== 'Already open / previously bought') error = bought.error;
  }
}

freeFeed = createPumpLaneFreeFeed({
  onTrade: ({ candidate }) => { tradeEvents++; tryCandidate(candidate); },
  onCurve: candidate => tryCandidate(candidate),
  onStatus: status => { if (status.error) { error = status.error; console.error('[Pump Lane free feed]', error); } else if (status.connected) error = null; }
});

function getStatus() {
  const feed = freeFeed.status();
  return {
    running, error: error || feed.error, watched: feed.watched, live: false, mode: 'PAPER',
    provider: feed.provider, feedConnected: feed.connected, newTokens, tradeEvents,
    acceptedCandidates, rejectionCounts: { ...rejectionCounts }, queuedTransactions: feed.queuedTransactions
  };
}

function connectPortal() {
  if (!running) return;
  try {
    const ws = new WebSocket(process.env.PUMP_PORTAL_WS || 'wss://pumpportal.fun/api/data');
    portalSocket = ws;
    ws.addEventListener('open', () => {
      if (!running || portalSocket !== ws) return ws.close();
      ws.send(JSON.stringify({ method: 'subscribeNewToken' })); // PumpPortal's free creation feed only.
      console.log('[Pump Lane] Connected to free new-token feed');
    });
    ws.addEventListener('message', event => {
      if (!running || portalSocket !== ws) return;
      try {
        const token = JSON.parse(String(event.data));
        if (token.txType !== 'create' || !token.mint) return;
        newTokens++;
        if (freeFeed.getCandidate(token.mint)) return;
        if (freeFeed.watched.size >= MAX_WATCHED) {
          const position = trader.getState().position;
          const oldest = [...freeFeed.watched.keys()].find(mint => mint !== position?.tokenAddress);
          if (oldest) freeFeed.removeMint(oldest);
        }
        void freeFeed.addMint(token.mint, {
          symbol: token.symbol,
          createdAt: Date.now(),
          creator: token.traderPublicKey || token.creator,
          creatorBuyTokens: Number(token.tokenAmount) || 0,
          creationSignature: token.signature,
          creationSlot: token.slot,
          nsfw: !!token.nsfw
        }).then(tryCandidate).catch(e => { error = e.message; console.error('[Pump Lane free token lookup]', error); });
      } catch (e) { error = e.message; console.error('[Pump Lane token feed]', error); }
    });
    ws.addEventListener('error', () => { if (portalSocket === ws) { error = 'PumpPortal free token-feed WebSocket error'; console.error('[Pump Lane]', error); } });
    ws.addEventListener('close', () => {
      if (portalSocket !== ws) return;
      portalSocket = null;
      if (running) reconnect = setTimeout(connectPortal, 5000);
    });
  } catch (e) { error = e.message; console.error('[Pump Lane token feed]', error); reconnect = setTimeout(connectPortal, 5000); }
}

function start() {
  if (running) return getStatus();
  const saved = trader.getState(); // Validate durable paper state before opening external feeds.
  if (saved.position) void freeFeed.addMint(saved.position.tokenAddress, {
    symbol: saved.position.symbol,
    createdAt: saved.position.entryAt,
    creator: null
  });
  running = true;
  error = null;
  console.log('[Pump Lane] PAPER only · no paid trade feed · no signing');
  freeFeed.start();
  connectPortal();
  return getStatus();
}

function stop() {
  running = false;
  clearTimeout(reconnect);
  reconnect = null;
  const old = portalSocket;
  portalSocket = null;
  if (old) old.close();
  freeFeed.stop();
  return getStatus();
}

module.exports = { start, stop, getStatus };
