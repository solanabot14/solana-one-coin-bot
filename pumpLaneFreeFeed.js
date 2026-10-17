'use strict';

// Free Pump Lane market data: PumpPortal's free create stream plus Helius' standard
// Solana WebSocket/RPC methods. No transaction API, wallet, or signing is used.
const PUMP_COIN_API = 'https://frontend-api-v3.pump.fun/coins-v2/';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';
const HELIUS_WS = 'wss://mainnet.helius-rpc.com/';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const PUBLIC_WS = 'wss://api.mainnet-beta.solana.com';

function decodeCurveAccount(encoded) {
  if (typeof encoded !== 'string') return null;
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 49) return null;
  const virtualTokenReserves = Number(data.readBigUInt64LE(8));
  const virtualSolReserves = Number(data.readBigUInt64LE(16));
  const realTokenReserves = Number(data.readBigUInt64LE(24));
  const realSolReserves = Number(data.readBigUInt64LE(32));
  const tokenTotalSupply = Number(data.readBigUInt64LE(40));
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    graduated: data[48] === 1,
    bondingProgress: Math.max(0, Math.min(100, (virtualSolReserves / 1e9 - 30) / 85 * 100)),
    marketCapSol: virtualTokenReserves > 0 ? virtualSolReserves / virtualTokenReserves * 1e6 : NaN,
    priceSol: virtualTokenReserves > 0 ? virtualSolReserves / virtualTokenReserves * 1e-3 : NaN
  };
}

function parseTradeTransaction(tx, signature, expectedMint) {
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const trader = keys.find(k => typeof k === 'object' && k.signer)?.pubkey ||
    (typeof keys[0] === 'string' ? keys[0] : keys.find(k => typeof k === 'object')?.pubkey);
  if (!trader) return null;
  const before = new Map(), after = new Map();
  const amountOf = row => {
    const raw = row.uiTokenAmount?.amount;
    const decimals = Number(row.uiTokenAmount?.decimals || 0);
    return raw != null ? Number(raw) / (10 ** decimals) : Number(row.uiTokenAmount?.uiAmount || 0);
  };
  for (const row of tx.meta?.preTokenBalances || []) {
    if (row.owner === trader) before.set(row.mint, (before.get(row.mint) || 0) + amountOf(row));
  }
  for (const row of tx.meta?.postTokenBalances || []) {
    if (row.owner !== trader) continue;
    after.set(row.mint, (after.get(row.mint) || 0) + amountOf(row));
  }
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    if (expectedMint && mint !== expectedMint) continue;
    const delta = (after.get(mint) || 0) - (before.get(mint) || 0);
    if (!Number.isFinite(delta) || Math.abs(delta) <= 0) continue;
    return { mint, trader, type: delta > 0 ? 'buy' : 'sell', tokenAmount: Math.abs(delta), signature };
  }
  return null;
}

function createPumpLaneFreeFeed({ apiKey = process.env.HELIUS_API_KEY, onTrade = () => {}, onCurve = () => {}, onStatus = () => {}, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  let ws = null, running = false, sequence = 0, reconnectTimer = null, error = null;
  let providerIndex = apiKey ? 0 : 1;
  const watched = new Map();
  const requestMap = new Map();
  const pendingRequests = new Map();
  const seenSignatures = new Set();
  const txQueue = [];
  let txBusy = 0;

  const endpoints = [
    { name: 'Helius free RPC', rpc: `${HELIUS_RPC}?api-key=${encodeURIComponent(apiKey || '')}`, ws: `${HELIUS_WS}?api-key=${encodeURIComponent(apiKey || '')}` },
    { name: 'Solana public RPC', rpc: PUBLIC_RPC, ws: PUBLIC_WS }
  ];
  const rpc = async (method, params) => {
    let lastError;
    for (const index of [providerIndex, 1 - providerIndex]) {
      try {
        const response = await fetchImpl(endpoints[index].rpc, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
          signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`${endpoints[index].name} HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.error) throw new Error(payload.error.message || `${endpoints[index].name} RPC error`);
        providerIndex = index;
        return payload.result;
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error('No free Solana RPC endpoint available');
  };
  function sendSubscription(mint, pubkey, kind) {
    if (!ws || ws.readyState !== 1) { pendingRequests.set(`${kind}:${mint}`, { mint, pubkey, kind }); return; }
    const id = ++sequence;
    requestMap.set(id, { mint, kind });
    const method = kind === 'curve' ? 'accountSubscribe' : 'logsSubscribe';
    const params = kind === 'curve'
      ? [pubkey, { encoding: 'base64', commitment: 'processed' }]
      : [{ mentions: [pubkey] }, { commitment: 'confirmed' }];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }
  async function addMint(mint, seed = {}) {
    if (watched.has(mint)) return watched.get(mint);
    const c = {
      mint, tokenAddress: mint, symbol: seed.symbol || 'UNKNOWN', createdAt: Number(seed.createdAt) || Date.now(),
      creator: seed.creator || null, creationSignature: seed.creationSignature || null,
      creationSlot: Number(seed.creationSlot) || null, subscriptions: {},
      buyCount: 0, sellCount: 0, uniqueTraders: new Set(), creatorBuyTokens: Number(seed.creatorBuyTokens) || 0, creatorSellTokens: 0,
      graduated: false, nsfw: !!seed.nsfw, lastPriceUsd: 0
    };
    watched.set(mint, c);
    sendSubscription(mint, mint, 'trades');
    try {
      // PumpPortal's free creation event includes bondingCurveKey. Use it directly
      // so a token does not depend on Pump.fun's slower indexing API.
      let curveAddress = seed.bondingCurveKey || seed.bonding_curve || null;
      if (!curveAddress) {
        let response, coin;
        for (let attempt = 0; attempt < 6; attempt++) {
          response = await fetchImpl(`${PUMP_COIN_API}${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(10000) });
          if (response.ok) {
            coin = await response.json();
            if (coin?.bonding_curve || coin?.bondingCurveKey) break;
          } else if (![404, 429, 502, 503].includes(response.status) || attempt === 5) {
            throw new Error(`Pump coin API HTTP ${response.status}`);
          }
          // Newly created coins may take several seconds to appear in Pump.fun's
          // index. Keep the token watched and retry instead of dropping it.
          if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
        c.symbol = coin?.symbol || c.symbol;
        c.creator = coin?.creator || c.creator;
        c.nsfw = c.nsfw || !!coin?.nsfw;
        c.graduated = !!(coin?.complete || coin?.is_banned);
        curveAddress = coin?.bonding_curve || coin?.bondingCurveKey || null;
        if (!curveAddress) throw new Error('Pump coin index has not published the bonding curve yet');
      }
      sendSubscription(mint, curveAddress, 'curve');
    } catch (e) {
      error = `Free coin lookup (${mint.slice(0, 6)}…): ${e.message}`;
      onStatus({ error, watched: watched.size });
    }
    return c;
  }
  function removeMint(mint) {
    const c = watched.get(mint);
    if (!c) return;
    if (ws?.readyState === 1) {
      if (c.subscriptions?.curve != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'accountUnsubscribe', params: [c.subscriptions.curve] }));
      if (c.subscriptions?.trades != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'logsUnsubscribe', params: [c.subscriptions.trades] }));
    }
    watched.delete(mint);
  }
  function drainPending() {
    for (const item of pendingRequests.values()) sendSubscription(item.mint, item.pubkey, item.kind);
    pendingRequests.clear();
  }
  async function queueTransaction(mint, signature, slot) {
    if (seenSignatures.has(signature)) return;
    const candidate = watched.get(mint);
    if (!candidate || signature === candidate.creationSignature || (slot != null && candidate.creationSlot != null && Number(slot) === candidate.creationSlot)) return;
    seenSignatures.add(signature);
    if (seenSignatures.size > 12000) seenSignatures.clear();
    txQueue.push({ mint, signature });
    drainTransactions();
  }
  async function drainTransactions() {
    while (running && txBusy < 2 && txQueue.length) {
      const item = txQueue.shift(); txBusy++;
      void (async () => {
        try {
          let tx = null;
          for (let attempt = 0; attempt < 3 && !tx; attempt++) {
            tx = await rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
            if (!tx && attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
          }
          const trade = parseTradeTransaction(tx, item.signature, item.mint);
          const c = watched.get(item.mint);
          if (!trade || !c || trade.mint !== item.mint) return;
          c[trade.type === 'buy' ? 'buyCount' : 'sellCount']++;
          c.uniqueTraders.add(trade.trader);
          if (c.creator && trade.trader === c.creator) c[trade.type === 'buy' ? 'creatorBuyTokens' : 'creatorSellTokens'] += trade.tokenAmount;
          onTrade({ candidate: c, trade });
        } catch (e) { error = `Free trade lookup: ${e.message}`; onStatus({ error, watched: watched.size }); }
        finally { txBusy--; drainTransactions(); }
      })();
    }
  }
  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id != null && requestMap.has(msg.id)) {
      const sub = requestMap.get(msg.id); requestMap.delete(msg.id);
      if (msg.error) { error = `Helius ${sub.kind} subscription failed: ${msg.error.message || 'unknown error'}`; onStatus({ error, watched: watched.size }); }
      else if (watched.get(sub.mint)) watched.get(sub.mint).subscriptions[sub.kind] = msg.result;
      return;
    }
    if (msg.method === 'accountNotification') {
      const id = msg.params?.subscription;
      const mint = [...watched.values()].find(c => c.subscriptions?.curve === id);
      const encoded = msg.params?.result?.value?.data?.[0];
      const curve = decodeCurveAccount(encoded);
      if (mint && curve) { Object.assign(mint, curve); mint.lastPriceUsd = curve.priceSol * Number(process.env.SOL_USD_PRICE || 150); onCurve(mint); }
    } else if (msg.method === 'logsNotification') {
      const id = msg.params?.subscription;
      const c = [...watched.values()].find(x => x.subscriptions?.trades === id);
      const value = msg.params?.result?.value;
      if (c && value?.err == null && value.signature) void queueTransaction(c.mint, value.signature, msg.params?.result?.context?.slot);
    }
  }
  function connect() {
    if (!running) return;
    try {
      ws = new WebSocketImpl(endpoints[providerIndex].ws);
      ws.addEventListener('open', () => { if (!running) return ws.close(); error = null; drainPending(); onStatus({ connected: true, watched: watched.size }); });
      ws.addEventListener('message', e => handleMessage(e.data));
      ws.addEventListener('error', event => {
        // Browser-style WebSocket error events intentionally hide transport
        // details; Node runtimes may expose a useful message.
        const detail = event?.message || event?.error?.message;
        error = detail ? `${endpoints[providerIndex].name} WebSocket error: ${detail}` : `${endpoints[providerIndex].name} WebSocket error`;
        onStatus({ error, watched: watched.size });
      });
      ws.addEventListener('close', event => {
        if (!running) return;
        if (event?.code && event.code !== 1000) {
          error = `${endpoints[providerIndex].name} WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`;
          onStatus({ error, watched: watched.size });
        }
        // A free public Solana endpoint is the no-cost fallback if Helius rejects
        // or drops the standard WebSocket connection.
        if (providerIndex === 0 && event?.code !== 1000) providerIndex = 1;
        ws = null;
        reconnectTimer = setTimeout(connect, 5000);
      });
    } catch (e) { error = e.message; onStatus({ error, watched: watched.size }); reconnectTimer = setTimeout(connect, 5000); }
  }
  function start() { if (running) return status(); running = true; connect(); return status(); }
  function stop() { running = false; clearTimeout(reconnectTimer); reconnectTimer = null; const old = ws; ws = null; if (old) old.close(); return status(); }
  function status() { return { running, connected: !!ws && ws.readyState === 1, error, watched: watched.size, queuedTransactions: txQueue.length, provider: `${endpoints[providerIndex].name} + Pump.fun public coin data`, live: false }; }
  return { start, stop, status, addMint, removeMint, getCandidate: mint => watched.get(mint), watched };
}

module.exports = { createPumpLaneFreeFeed, decodeCurveAccount, parseTradeTransaction };
