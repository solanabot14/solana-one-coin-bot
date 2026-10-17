'use strict';
const { createHash } = require('node:crypto');

// Free Pump Lane market data: PumpPortal's free create stream plus Helius' standard
// Solana WebSocket/RPC methods. No transaction API, wallet, or signing is used.
const PUMP_COIN_API = 'https://frontend-api-v3.pump.fun/coins-v2/';
const HELIUS_WS = 'wss://mainnet.helius-rpc.com/';
const PUBLIC_WS = 'wss://api.mainnet.solana.com';
const TRADE_EVENT_DISCRIMINATOR = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

function encodeBase58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`), result = '';
  while (value > 0n) { const remainder = Number(value % 58n); result = alphabet[remainder] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result || '1';
}

// Pump.fun's official TradeEvent Borsh layout: discriminator, mint, SOL amount,
// token amount, is_buy, user, timestamp, then reserve fields.
function parsePumpTradeLogs(logs, expectedMint, signature) {
  for (const line of logs || []) {
    const match = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!match) continue;
    const data = Buffer.from(match[1], 'base64');
    if (data.length < 113 || !data.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) continue;
    const mint = encodeBase58(data.subarray(8, 40));
    if (expectedMint && mint !== expectedMint) continue;
    const rawTokens = Number(data.readBigUInt64LE(48));
    const trader = encodeBase58(data.subarray(57, 89));
    return {
      mint, trader, type: data[56] === 1 ? 'buy' : 'sell',
      tokenAmount: rawTokens / 1e6, solAmount: Number(data.readBigUInt64LE(40)) / 1e9,
      virtualSolReserves: Number(data.readBigUInt64LE(97)),
      virtualTokenReserves: Number(data.readBigUInt64LE(105)),
      signature
    };
  }
  return null;
}

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
  let wsProviderIndex = apiKey ? 0 : 1;
  const watched = new Map();
  const requestMap = new Map();
  const pendingRequests = new Map();
  const endpoints = [
    { name: 'Helius free RPC', ws: `${HELIUS_WS}?api-key=${encodeURIComponent(apiKey || '')}` },
    { name: 'Solana public RPC', ws: PUBLIC_WS }
  ];
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
  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id != null && requestMap.has(msg.id)) {
      const sub = requestMap.get(msg.id); requestMap.delete(msg.id);
      if (msg.error) { error = `${endpoints[wsProviderIndex].name} ${sub.kind} subscription failed: ${msg.error.message || 'unknown error'}`; onStatus({ error, watched: watched.size }); }
      else if (watched.get(sub.mint)) watched.get(sub.mint).subscriptions[sub.kind] = msg.result;
      else if (ws?.readyState === 1) {
        const unsubscribe = sub.kind === 'curve' ? 'accountUnsubscribe' : 'logsUnsubscribe';
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: unsubscribe, params: [msg.result] }));
      }
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
      if (!c || value?.err != null || !value?.signature) return;
      const trade = parsePumpTradeLogs(value.logs, c.mint, value.signature);
      if (!trade) return;
      c[trade.type === 'buy' ? 'buyCount' : 'sellCount']++;
      c.uniqueTraders.add(trade.trader);
      if (c.creator && trade.trader === c.creator) {
        c[trade.type === 'buy' ? 'creatorBuyTokens' : 'creatorSellTokens'] += trade.tokenAmount;
      }
      if (trade.virtualSolReserves > 0 && trade.virtualTokenReserves > 0) {
        c.virtualSolReserves = trade.virtualSolReserves;
        c.virtualTokenReserves = trade.virtualTokenReserves;
        c.bondingProgress = Math.max(0, Math.min(100, (trade.virtualSolReserves / 1e9 - 30) / 85 * 100));
        c.marketCapSol = trade.virtualSolReserves / trade.virtualTokenReserves * 1e6;
        c.priceSol = trade.virtualSolReserves / trade.virtualTokenReserves * 1e-3;
        c.lastPriceUsd = c.priceSol * Number(process.env.SOL_USD_PRICE || 150);
      }
      onTrade({ candidate: c, trade });
    }
  }
  function connect() {
    if (!running) return;
    try {
      ws = new WebSocketImpl(endpoints[wsProviderIndex].ws);
      ws.addEventListener('open', () => { if (!running) return ws.close(); error = null; drainPending(); onStatus({ connected: true, provider: endpoints[wsProviderIndex].name, watched: watched.size }); });
      ws.addEventListener('message', e => handleMessage(e.data));
      ws.addEventListener('error', event => {
        // Browser-style WebSocket error events intentionally hide transport
        // details; Node runtimes may expose a useful message.
        const detail = event?.message || event?.error?.message;
        error = detail ? `${endpoints[wsProviderIndex].name} WebSocket error: ${detail}` : `${endpoints[wsProviderIndex].name} WebSocket error`;
        onStatus({ error, watched: watched.size });
      });
      ws.addEventListener('close', event => {
        if (!running) return;
        if (event?.code && event.code !== 1000) {
          error = `${endpoints[wsProviderIndex].name} WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`;
          onStatus({ error, watched: watched.size });
        }
        // A free public Solana endpoint is the no-cost fallback if Helius rejects
        // or drops the standard WebSocket connection.
        if (wsProviderIndex === 0 && event?.code !== 1000) wsProviderIndex = 1;
        ws = null;
        reconnectTimer = setTimeout(connect, 5000);
      });
    } catch (e) { error = e.message; onStatus({ error, watched: watched.size }); reconnectTimer = setTimeout(connect, 5000); }
  }
  function start() { if (running) return status(); running = true; connect(); return status(); }
  function stop() { running = false; clearTimeout(reconnectTimer); reconnectTimer = null; const old = ws; ws = null; if (old) old.close(); return status(); }
  function status() { return { running, connected: !!ws && ws.readyState === 1, error, watched: watched.size, queuedTransactions: 0, provider: `${endpoints[wsProviderIndex].name} + Pump.fun public coin data`, live: false }; }
  return { start, stop, status, addMint, removeMint, getCandidate: mint => watched.get(mint), watched };
}

module.exports = { createPumpLaneFreeFeed, decodeCurveAccount, parsePumpTradeLogs, parseTradeTransaction };
