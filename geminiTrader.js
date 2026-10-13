const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function defaultFile() {
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "gemini-paper-state.json");
}
function createGeminiTrader(file = defaultFile(), io = fs) {
  let state = { startingBalanceUsd: Number(process.env.GEMINI_STARTING_BALANCE_USD) || 200, cashUsd: Number(process.env.GEMINI_STARTING_BALANCE_USD) || 200, position: null, history: [], rejections: [], lastScanAt: null };
  if (io.existsSync(file)) {
    const saved = JSON.parse(io.readFileSync(file, "utf8"));
    if (!saved || !Number.isFinite(saved.cashUsd) || !Array.isArray(saved.history) || !Array.isArray(saved.rejections))
      throw new Error("Invalid Gemini paper state; refusing to reset.");
    state = saved;
  }
  function commit(next) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      io.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: "wx", flush: true });
      io.renameSync(tmp, file);
    } finally { if (io.existsSync(tmp)) io.unlinkSync(tmp); }
    state = next;
  }
  function buy(candidate, amountUsd) {
    if (state.position) return { success: false, error: "Gemini already has an open position" };
    const price = Number(candidate.priceUsd);
    const size = Math.min(Number(amountUsd), state.cashUsd);
    if (!(price > 0) || !(size > 0) || !candidate.tokenAddress) return { success: false, error: "Invalid paper buy" };
    const next = structuredClone(state);
    const pos = {
      id: randomUUID(), tokenAddress: candidate.tokenAddress, pairAddress: candidate.pairAddress || null,
      symbol: candidate.symbol || "Unknown", name: candidate.name || candidate.symbol || "Unknown",
      entryPrice: price, quantity: size / price, originalQuantity: size / price, originalCostUsd: size,
      amountInvestedUsd: size, entryTime: new Date().toISOString(), highestPrice: price,
      tp1Done: false, tp2Done: false, remainingPercent: 100, strategy: "Gemini Paper v1",
      entryDetails: candidate.geminiDetails || {}
    };
    next.cashUsd -= size; next.position = pos;
    next.history.unshift({ type: "BUY", ...structuredClone(pos), time: pos.entryTime, amountUsd: size, mode: "PAPER" });
    commit(next);
    console.log("[BUY TRIGGERED] Gemini PAPER", pos.symbol, size.toFixed(2), "USD");
    return { success: true, position: structuredClone(pos) };
  }
  function sell(priceUsd, percentOriginal, reason) {
    const p = state.position;
    const price = Number(priceUsd);
    if (!p || !(price > 0) || !(percentOriginal > 0)) return { success: false, error: "No valid open position" };
    const qty = Math.min(p.quantity, p.originalQuantity * percentOriginal / 100);
    if (!(qty > 0)) return { success: false, error: "No remaining quantity" };
    const value = qty * price;
    const basis = p.originalCostUsd * (qty / p.originalQuantity);
    const next = structuredClone(state);
    next.cashUsd += value;
    next.position.quantity = Math.max(0, next.position.quantity - qty);
    next.position.amountInvestedUsd = Math.max(0, next.position.amountInvestedUsd - basis);
    const trade = {
      type: "SELL", id: randomUUID(), positionId: p.id, tokenAddress: p.tokenAddress,
      pairAddress: p.pairAddress, symbol: p.symbol, entryPrice: p.entryPrice, exitPrice: price,
      maxGainPercent: p.entryPrice > 0 ? (Number(p.highestPrice || p.entryPrice) / p.entryPrice - 1) * 100 : 0,
      quantity: qty, amountUsd: value, costBasisUsd: basis, pnlUsd: value - basis,
      pnlPercent: (price / p.entryPrice - 1) * 100, percentOfOriginalSold: qty / p.originalQuantity * 100,
      reason, time: new Date().toISOString(), mode: "PAPER"
    };
    next.history.unshift(trade);
    if (reason === "TP1 +50%") next.position.tp1Done = true;
    if (reason === "TP2 +100%") next.position.tp2Done = true;
    if (next.position) next.position.remainingPercent = Math.max(0, next.position.quantity / next.position.originalQuantity * 100);
    if (next.position.quantity <= p.originalQuantity * 0.000001) next.position = null;
    commit(next);
    console.log("[" + (reason.startsWith("TP") ? "SELL " + reason : "SELL") + "] Gemini PAPER", p.symbol, reason, "$" + value.toFixed(2));
    return { success: true, trade };
  }
  function updatePosition(patch) {
    if (!state.position || state.position.id !== patch?.id) return false;
    const next = structuredClone(state);
    next.position = { ...next.position, ...patch };
    commit(next);
    return true;
  }
  function recordRejection(candidate, reason, details = {}) {
    const next = structuredClone(state);
    next.rejections.unshift({ time: new Date().toISOString(), symbol: candidate.symbol || "Unknown", tokenAddress: candidate.tokenAddress || null, reason, details });
    next.rejections = next.rejections.slice(0, 200);
    next.lastScanAt = new Date().toISOString();
    commit(next);
    console.log("[REJECTED: " + reason + "] Gemini", candidate.symbol || candidate.tokenAddress || "unknown");
  }
  function setScanTime() { const next = structuredClone(state); next.lastScanAt = new Date().toISOString(); commit(next); }
  return { buy, sell, recordRejection, setScanTime, updatePosition, getState: () => structuredClone(state), file };
}
let instance;
const current = () => instance ||= createGeminiTrader();
module.exports = { createGeminiTrader, defaultFile, getState: (...a) => current().getState(...a), buy: (...a) => current().buy(...a), sell: (...a) => current().sell(...a), recordRejection: (...a) => current().recordRejection(...a), setScanTime: (...a) => current().setScanTime(...a), updatePosition: (...a) => current().updatePosition(...a) };
