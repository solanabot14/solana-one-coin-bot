'use strict';
const trader = require('./pumpLaneTrader');
const { evaluatePumpCandidate } = require('./pumpLaneFilter');
const { createPumpLaneFreeFeed } = require('./pumpLaneFreeFeed');

let running = false, error = null, portalSocket = null, reconnect = null, portalError = null;
let newTokens = 0, tradeEvents = 0, acceptedCandidates = 0;
const rejectionCounts = Object.create(null);
const MAX_WATCH_AGE_MS = 25 * 60000;
const WATCHLIST_LIMIT = 400;
let recheckTimer = null;
let freeFeed;

function pruneWatched(now = Date.now()) {
  const saved = trader.getState();
  const openMint = saved.position?.tokenAddress;
  const boughtMints = new Set(saved.boughtMints || []);
  for (const [mint, candidate] of freeFeed.watched) {
    if (mint !== openMint && (now - candidate.createdAt > MAX_WATCH_AGE_MS || boughtMints.has(mint))) {
      freeFeed.removeMint(mint);
    }
  }
  if (freeFeed.watched.size > WATCHLIST_LIMIT) {
    const oldestFirst = [...freeFeed.watched.values()]
      .filter(candidate => candidate.mint !== openMint)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of oldestFirst) {
      if (freeFeed.watched.size <= WATCHLIST_LIMIT) break;
      freeFeed.removeMint(candidate.mint);
    }
  }
}

function recheckWatched() {
  if (!running) return;
  try {
    const now = Date.now();
    pruneWatched(now);
    for (const candidate of [...freeFeed.watched.values()]) {
      if (now - candidate.createdAt >= 60000) tryCandidate(candidate);
    }
  } catch (e) { error = e.message; console.error('[Pump Lane recheck]', error); }
}

function tryCandidate(c) {
  if (!running || !c) return;
  pruneWatched();
  if (!freeFeed.getCandidate(c.mint)) return;
  trader.touchScan();
  const pos = trader.getState().position;
  const quoteFresh = Number.isFinite(c.lastQuoteAt) && Date.now() - c.lastQuoteAt <= 120000;
  if (pos?.tokenAddress === c.mint && c.lastPriceUsd > 0 && quoteFresh) {
    trader.decideExit(c.lastPriceUsd, Date.now(), c.lastQuoteAt);
    pruneWatched();
    return;
  }
  if (pos) return;
  const result = evaluatePumpCandidate({ ...c, tokenAddress: c.mint, ageMinutes: (Date.now() - c.createdAt) / 60000 });
  if (!result.accepted) {
    rejectionCounts[result.reason] = (rejectionCounts[result.reason] || 0) + 1;
    trader.recordRejection(c, result.reason);
    return;
  }
  if (Number.isFinite(c.lastPriceUsd) && c.lastPriceUsd > 0 && quoteFresh) {
    const bought = trader.buy({ ...c, tokenAddress: c.mint, priceUsd: c.lastPriceUsd });
    if (bought.success) { acceptedCandidates++; console.log('[Pump Lane] PAPER entry', c.symbol, c.mint); }
    else if (bought.error !== 'Already open / previously bought') error = bought.error;
  }
}

freeFeed = createPumpLaneFreeFeed({
  priorityMint: () => trader.getState().position?.tokenAddress,
  onTrade: ({ candidate }) => { tradeEvents++; tryCandidate(candidate); },
  onCurve: candidate => tryCandidate(candidate),
  onStatus: status => {
    if (status.warning) console.warn('[Pump Lane token warning]', status.warning);
    else if (status.error) console.error('[Pump Lane free feed]', status.error);
    else if (status.connected) console.log('[Pump Lane] Connected to', status.provider);
  }
});

function getStatus() {
  const feed = freeFeed.status();
  return {
    running, error: error || feed.error || portalError, watched: feed.watched, live: false, mode: 'PAPER',
    provider: feed.provider, feedConnected: feed.connected, newTokens, tradeEvents,
    acceptedCandidates, warnings: feed.warnings || [], statusMessage: feed.warnings?.length ? `${feed.warnings.length} token lookup/subscription warning(s); account balances remain recorded` : null, queuedSubscriptions: feed.queuedSubscriptions || 0, rejectionCounts: { ...rejectionCounts }, queuedTransactions: feed.queuedTransactions
  };
}

function connectPortal() {
  if (!running) return;
  try {
    const ws = new WebSocket(process.env.PUMP_PORTAL_WS || 'wss://pumpportal.fun/api/data');
    portalSocket = ws;
    ws.addEventListener('open', () => {
      if (!running || portalSocket !== ws) return ws.close();
      portalError = null;
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
        pruneWatched();
        const added = freeFeed.addMint(token.mint, {
          symbol: token.symbol,
          createdAt: Date.now(),
          creator: token.traderPublicKey || token.creator,
          creatorBuyTokens: Number(token.tokenAmount) || 0,
          creationSignature: token.signature,
          creationSlot: token.slot,
          bondingCurveKey: token.bondingCurveKey,
          nsfw: !!token.nsfw
        });
        pruneWatched();
        void added.then(tryCandidate).catch(e => { error = e.message; console.error('[Pump Lane free token lookup]', error); });
      } catch (e) { error = e.message; console.error('[Pump Lane token feed]', error); }
    });
    ws.addEventListener('error', () => { if (portalSocket === ws) { portalError = 'PumpPortal free token-feed WebSocket error'; console.error('[Pump Lane]', portalError); } });
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
  recheckTimer = setInterval(recheckWatched, 20000);
  recheckTimer.unref?.();
  return getStatus();
}

function stop() {
  running = false;
  clearTimeout(reconnect);
  reconnect = null;
  clearInterval(recheckTimer);
  recheckTimer = null;
  const old = portalSocket;
  portalSocket = null;
  if (old) old.close();
  freeFeed.stop();
  return getStatus();
}

module.exports = { start, stop, getStatus };
