"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getTokenData } = require("./dexscreener");

const WALLET = "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9";
const STARTING_BALANCE = 200;
const TRADE_SIZE = 5;
const MAX_POSITIONS = 40;
const POOL_FEE_RATE = 0.003;
const NETWORK_FEE_USD = 0.01;
const MAX_PROCESSED_SIGNATURES = 2500;
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "So11111111111111111111111111111111111111112"
]);

const dataDir = process.env.WALLET_COPY_DATA_DIR || (fs.existsSync("/data") ? "/data" : __dirname);
const statePath = path.join(dataDir, "wallet-copy-decu-state.json");
let state = readState();
let marketData = getTokenData;
let running = false;
let setupError = null;
let setupPromise = null;
let eventQueue = Promise.resolve();
let pollTimer = null;
let polling = false;
let feedMode = "waiting";
let webhookWarning = null;
let lastPollAt = null;
let lastPollError = null;
const POLL_INTERVAL_MS = 30000;

function freshState() {
  return {
    schemaVersion: 1,
    startingBalance: STARTING_BALANCE,
    cashBalance: STARTING_BALANCE,
    positions: [],
    history: [],
    sourceBalances: {},
    processedSignatures: [],
    stats: { received: 0, swaps: 0, buys: 0, sells: 0, skipped: 0 },
    lastEventAt: null,
    lastSignature: null,
    pollCursor: null,
    pollStartedAt: null,
    skipReasons: {},
    webhookId: null,
    webhookSecret: crypto.randomBytes(32).toString("hex"),
    startedAt: new Date().toISOString()
  };
}
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return Object.assign(freshState(), parsed, {
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      sourceBalances: parsed.sourceBalances && typeof parsed.sourceBalances === "object" ? parsed.sourceBalances : {},
      processedSignatures: Array.isArray(parsed.processedSignatures) ? parsed.processedSignatures : []
    });
  } catch (_) { return freshState(); }
}
function saveState() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = statePath + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, statePath);
}
function round(value) { return Math.round((Number(value) + Number.EPSILON) * 1e12) / 1e12; }
function amountOf(transfer) {
  const value = Number(transfer && (transfer.tokenAmount ?? transfer.amount ?? transfer.uiAmount));
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function swapDeltas(tx, wallet = WALLET) {
  if (!tx || tx.transactionError || tx.meta && tx.meta.err) return [];
  const type = String(tx.type || tx.transactionType || "").toUpperCase();
  if (type && type !== "SWAP") return [];
  const tokenTransfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  const deltas = new Map();
  for (const transfer of tokenTransfers) {
    const mint = transfer.mint || transfer.tokenMint || transfer.tokenAddress;
    if (!mint || STABLE_MINTS.has(mint)) continue;
    const amount = amountOf(transfer);
    if (!amount) continue;
    const from = transfer.fromUserAccount || transfer.from || "";
    const to = transfer.toUserAccount || transfer.to || "";
    if (from === wallet) deltas.set(mint, (deltas.get(mint) || 0) - amount);
    if (to === wallet) deltas.set(mint, (deltas.get(mint) || 0) + amount);
  }
  return [...deltas.entries()]
    .filter(([, delta]) => Math.abs(delta) > 1e-12)
    .map(([mint, delta]) => ({ mint, delta }));
}
function getSignature(tx) {
  return tx.signature || tx.transactionSignature || tx.txSignature || "";
}
function getEventTime(tx) {
  const seconds = Number(tx.timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}
function portfolio() {
  return {
    startingBalance: Number(state.startingBalance) || STARTING_BALANCE,
    cashBalance: Number(state.cashBalance) || 0,
    positions: state.positions.filter(p => Number(p.quantity) > 0),
    history: state.history.slice(-1500),
    maxOpenPositions: MAX_POSITIONS
  };
}
function status() {
  return {
    running,
    mode: "paper",
    wallet: WALLET,
    startingBalance: state.startingBalance,
    tradeSizeUsd: TRADE_SIZE,
    maxOpenPositions: MAX_POSITIONS,
    openPositions: state.positions.filter(p => Number(p.quantity) > 0).length,
    receivedSignals: state.stats.received,
    copiedBuys: state.stats.buys,
    copiedSells: state.stats.sells,
    skippedSignals: state.stats.skipped,
    webhookConfigured: feedMode === "webhook",
    feedMode,
    feedConnected: feedMode === "webhook" || (feedMode === "polling" && !!lastPollAt && !lastPollError),
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
    lastPollAt,
    webhookWarning,
    skipReasons: state.skipReasons || {},
    lastSkip: state.lastSkip || null,
    lastEventAt: state.lastEventAt,
    lastSignature: state.lastSignature,
    error: setupError
  };
}
function skip(reason, mint = null) {
  state.stats.skipped++;
  state.skipReasons ||= {};
  state.skipReasons[reason] = (state.skipReasons[reason] || 0) + 1;
  state.lastSkip = { reason, mint, at: new Date().toISOString() };
}
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authenticateWebhook(req) {
  return timingSafeEqual(req.headers.authorization || "", state.webhookSecret);
}
function webhookUrl() {
  if (process.env.WALLET_COPY_WEBHOOK_URL) return process.env.WALLET_COPY_WEBHOOK_URL;
  return "https://solana-one-coin-bot-production.up.railway.app/api/wallet-copy/webhook";
}
async function setupHelius() {
  saveState();
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not configured.");
  const url = "https://api.helius.xyz/v0/webhooks?api-key=" + encodeURIComponent(apiKey);
  const listResponse = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!listResponse.ok) throw new Error("Helius webhook lookup failed (" + listResponse.status + ").");
  const list = await listResponse.json();
  const existing = (Array.isArray(list) ? list : []).find(item =>
    item.webhookURL === webhookUrl() &&
    Array.isArray(item.accountAddresses) && item.accountAddresses.includes(WALLET)
  );
  if (existing) {
    state.webhookId = existing.webhookID || existing.webhookId || state.webhookId;
    saveState();
    return;
  }
  const createResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      webhookURL: webhookUrl(),
      transactionTypes: ["SWAP"],
      accountAddresses: [WALLET],
      webhookType: "enhanced",
      authHeader: state.webhookSecret
    })
  });
  if (!createResponse.ok) {
    const detail = await createResponse.text().catch(() => "");
    throw new Error("Helius webhook create failed (" + createResponse.status + ")" + (detail ? "." : "."));
  }
  const created = await createResponse.json();
  state.webhookId = created.webhookID || created.webhookId || created.id || null;
  saveState();
}
function lookupPosition(mint) { return state.positions.find(p => p.tokenAddress === mint && Number(p.quantity) > 0); }
function entryCostModel(data) {
  return {
    assumedPoolFeePercentPerSwap: 0.30,
    estimatedSolanaNetworkFeeUsdPerSwap: NETWORK_FEE_USD,
    estimatedPriorityFeeUsdPerSwap: 0,
    entryLiquidityUsd: Number(data.liquidityUsd) || null
  };
}
async function copyBuy(tx, mint, sourceAmount, eventTime, signature) {
  const existing = lookupPosition(mint);
  if (state.cashBalance + 1e-9 < TRADE_SIZE || (!existing && state.positions.filter(p => Number(p.quantity) > 0).length >= MAX_POSITIONS)) {
    skip("cash_or_position_limit", mint);
    return;
  }
  const quote = await marketData(mint);
  const price = Number(quote && quote.priceUsd);
  const liquidity = Number(quote && quote.liquidityUsd);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(liquidity) || liquidity <= 0) {
    skip("missing_price_or_liquidity", mint);
    return;
  }
  const impactRate = TRADE_SIZE / (liquidity / 2 + TRADE_SIZE);
  const fee = TRADE_SIZE * POOL_FEE_RATE;
  const slippage = TRADE_SIZE * impactRate;
  const tokenBudget = Math.max(0, TRADE_SIZE - NETWORK_FEE_USD - fee - slippage);
  const quantity = tokenBudget / price;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    skip("invalid_quantity", mint);
    return;
  }
  const id = signature + ":" + mint;
  const position = existing || {
    id, positionId: id, tokenAddress: mint,
    symbol: quote.symbol || mint.slice(0, 6), name: quote.name || quote.symbol || mint,
    pairAddress: quote.pairAddress || null, strategyVersion: "DECU-WALLET-FOLLOW-PAPER",
    entryTime: eventTime, entryPrice: price, quantity: 0, originalQuantity: 0,
    amountInvested: 0, entryLiquidityUsd: liquidity,
    entrySignal: "Observed wallet swap " + signature,
    entryReasons: ["Paper copy at webhook arrival quote"],
    highestPrice: price, remainingEntryCosts: { feesUsd: 0, slippageUsd: 0 },
    experimentEntry: { estimatedCostModel: entryCostModel(quote) }
  };
  const oldQuantity = Number(position.quantity) || 0;
  const nextQuantity = oldQuantity + quantity;
  position.entryPrice = (Number(position.entryPrice) * oldQuantity + price * quantity) / nextQuantity;
  position.quantity = round(nextQuantity);
  position.originalQuantity = round((Number(position.originalQuantity) || 0) + quantity);
  position.amountInvested = round((Number(position.amountInvested) || 0) + TRADE_SIZE);
  position.highestPrice = Math.max(Number(position.highestPrice) || 0, price);
  position.remainingEntryCosts = {
    feesUsd: round((Number(position.remainingEntryCosts && position.remainingEntryCosts.feesUsd) || 0) + fee + NETWORK_FEE_USD),
    slippageUsd: round((Number(position.remainingEntryCosts && position.remainingEntryCosts.slippageUsd) || 0) + slippage)
  };
  if (!existing) state.positions.push(position);
  state.cashBalance = round(state.cashBalance - TRADE_SIZE);
  state.history.push({
    type: "BUY", id, positionId: position.positionId, tokenAddress: mint,
    symbol: position.symbol, name: position.name, pairAddress: position.pairAddress,
    strategyVersion: position.strategyVersion, entryTime: position.entryTime,
    signalTime: eventTime, entryPrice: price, quantity, amountInvested: TRADE_SIZE,
    entryLiquidityUsd: liquidity, highestPrice: price, reason: "Observed wallet swap",
    sourceSignature: signature
  });
  state.stats.buys++;
}
async function copySell(mint, sourceSold, eventTime, signature) {
  const priorSource = Number(state.sourceBalances[mint]) || 0;
  if (priorSource <= 0 || sourceSold <= 0) {
    skip("sell_before_observed_buy", mint);
    return;
  }
  const fraction = Math.min(1, sourceSold / priorSource);
  const position = lookupPosition(mint);
  if (!position) {
    state.sourceBalances[mint] = Math.max(0, priorSource - sourceSold);
    skip("sell_without_paper_position", mint); return;
  }
  const soldQuantity = Math.min(Number(position.quantity), Number(position.quantity) * fraction);
  if (soldQuantity <= 0) return;
  const quote = await marketData(mint);
  const price = Number(quote && quote.priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    skip("missing_sell_price", mint);
    return;
  }
  state.sourceBalances[mint] = Math.max(0, priorSource - sourceSold);
  const liquidity = Number(quote.liquidityUsd) || 0;
  const grossValue = soldQuantity * price;
  const impactRate = liquidity > 0 ? grossValue / (liquidity / 2 + grossValue) : 0;
  const poolFee = grossValue * POOL_FEE_RATE;
  const slippage = grossValue * impactRate;
  const netValue = Math.max(0, grossValue - poolFee - slippage - NETWORK_FEE_USD);
  const costBasis = Number(position.amountInvested) * (soldQuantity / Number(position.originalQuantity));
  const pnl = netValue - costBasis;
  const complete = soldQuantity >= Number(position.quantity) * (1 - 1e-10);
  position.quantity = round(Number(position.quantity) - soldQuantity);
  state.cashBalance = round(state.cashBalance + netValue);
  state.history.push({
    type: "SELL", id: position.id + ":sell:" + signature, positionId: position.positionId,
    tokenAddress: mint, symbol: position.symbol, name: position.name, pairAddress: position.pairAddress,
    strategyVersion: position.strategyVersion, entryTime: position.entryTime, exitTime: eventTime,
    entryPrice: position.entryPrice, exitPrice: price, quantitySold: soldQuantity,
    percentSold: complete ? 100 : soldQuantity / Number(position.originalQuantity) * 100,
    saleValue: netValue, pnl, amountInvested: costBasis, entryLiquidityUsd: position.entryLiquidityUsd,
    highestPrice: Math.max(Number(position.highestPrice) || 0, price), reason: "Wallet partial exit",
    sourceSignature: signature, grossPnl: grossValue - costBasis,
    estimatedFeesUsd: poolFee + NETWORK_FEE_USD, estimatedSlippageUsd: slippage
  });
  state.stats.sells++;
  if (complete) state.positions = state.positions.filter(p => p !== position);
}
async function processTransaction(tx) {
  const signature = getSignature(tx);
  if (!signature || state.processedSignatures.includes(signature)) return false;
  state.stats.received++;
  const deltas = swapDeltas(tx);
  if (!deltas.length) {
    skip("no_wallet_swap_token_legs");
    remember(signature, tx);
    return true;
  }
  state.stats.swaps++;
  const eventTime = getEventTime(tx);
  // Apply outgoing legs against source inventory first, then register incoming legs.
  for (const leg of deltas.filter(x => x.delta < 0)) {
    await copySell(leg.mint, Math.abs(leg.delta), eventTime, signature);
  }
  for (const leg of deltas.filter(x => x.delta > 0)) {
    const previous = Number(state.sourceBalances[leg.mint]) || 0;
    await copyBuy(tx, leg.mint, leg.delta, eventTime, signature);
    state.sourceBalances[leg.mint] = previous + leg.delta;
  }
  remember(signature, tx);
  return true;
}
function remember(signature, tx) {
  state.processedSignatures.push(signature);
  if (state.processedSignatures.length > MAX_PROCESSED_SIGNATURES) {
    state.processedSignatures = state.processedSignatures.slice(-MAX_PROCESSED_SIGNATURES);
  }
  state.lastEventAt = getEventTime(tx);
  state.lastSignature = signature;
  saveState();
}
function handleWebhookPayload(payload) {
  const transactions = Array.isArray(payload) ? payload : [payload];
  eventQueue = eventQueue.then(async () => {
    for (const tx of transactions) {
      try { await processTransaction(tx); }
      catch (error) { setupError = "Signal processing error: " + error.message; }
      finally { saveState(); }
    }
  });
  return eventQueue;
}
function startBot() {
  if (running) return;
  running = true;
  setupError = null;
  setupPromise = setupHelius().then(() => {
    if (running) feedMode = "webhook";
  }).catch(error => {
    webhookWarning = error.message;
    console.warn("Decu webhook unavailable; starting history polling:", error.message);
    if (running) return startPolling();
  });
  return setupPromise;
}
async function startPolling() {
  feedMode = "polling";
  state.pollStartedAt ||= new Date().toISOString();
  saveState();
  await pollOnce();
  if (!running) return;
  pollTimer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  pollTimer.unref();
}
async function pollOnce() {
  if (polling || !running) return;
  polling = true;
  try {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) throw new Error("HELIUS_API_KEY is not configured.");
    // Cursor paging requests only new activity, avoiding repeated history downloads.
    for (let page = 0; page < 5 && running; page++) {
      const url = new URL("https://api-mainnet.helius-rpc.com/v0/addresses/" + WALLET + "/transactions");
      url.searchParams.set("api-key", apiKey);
      url.searchParams.set("limit", "100");
      url.searchParams.set("token-accounts", "balanceChanged");
      url.searchParams.set("commitment", "confirmed");
      url.searchParams.set("sort-order", "asc");
      if (state.pollCursor) url.searchParams.set("after-signature", state.pollCursor);
      else url.searchParams.set("gte-time", String(Math.floor(new Date(state.pollStartedAt).getTime() / 1000)));
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Helius wallet polling failed (" + response.status + ").");
      const transactions = await response.json();
      if (!Array.isArray(transactions)) throw new Error("Helius wallet polling returned an invalid history response.");
      if (!running) return;
      const ordered = transactions;
      // Keep webhook and polling deliveries serialized and deduplicate by signature.
      await handleWebhookPayload(ordered.filter(tx => String(tx.type || "").toUpperCase() === "SWAP"));
      if (ordered.length) state.pollCursor = getSignature(ordered[ordered.length - 1]);
      saveState();
      if (transactions.length < 100) break;
    }
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    setupError = null;
  } catch (error) {
    lastPollError = error.message;
    setupError = error.message;
    console.error("Decu wallet polling:", error.message);
  } finally { polling = false; }
}
function stopBot() {
  running = false;
  clearInterval(pollTimer);
  pollTimer = null;
  feedMode = "stopped";
}
function getPortfolio() { return portfolio(); }
function getStatus() { return status(); }

module.exports = {
  WALLET, STARTING_BALANCE, TRADE_SIZE, MAX_POSITIONS,
  startBot, stopBot, getPortfolio, getStatus, authenticateWebhook, handleWebhookPayload,
  swapDeltas, processTransaction, pollOnce, setMarketData: fn => { marketData = fn; }
};
