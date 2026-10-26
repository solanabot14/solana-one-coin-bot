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
  function getSizing() {
    const step = state.nextSizingStep === 1 ? 1 : 0;
    const percent = step === 0 ? 10 : 12.5;
    return { step, percent, amountUsd: state.cashUsd * percent / 100 };
  }
  // Live-only sizing follows the agreed $2 base cycle; paper sizing is separate.
  // Proportional equivalent of $5.00 -> $5.50 -> $5.63, reset after a loss.
  function getLiveSizing() {
    const cycle = [2, 2.2, 2.25];
    const step = Number.isInteger(state.liveSizingStep) && state.liveSizingStep >= 0 && state.liveSizingStep < cycle.length
      ? state.liveSizingStep : 0;
    return { step, amountUsd: cycle[step] };
  }
  function buy(candidate, amountUsd) {
    if (state.position) return { success: false, error: "Gemini already has an open position" };
    const price = Number(candidate.priceUsd);
    const sizing = getSizing();
    const size = Math.min(Number(amountUsd ?? sizing.amountUsd), state.cashUsd);
    if (!(price > 0) || !(size > 0) || !candidate.tokenAddress) return { success: false, error: "Invalid paper buy" };
    const next = structuredClone(state);
    const mode = candidate.liveExecution?.executionMode === "LIVE" ? "LIVE" : "PAPER";
    const pos = {
      id: randomUUID(), tokenAddress: candidate.tokenAddress, pairAddress: candidate.pairAddress || null,
      symbol: candidate.symbol || "Unknown", name: candidate.name || candidate.symbol || "Unknown",
      entryPrice: price, quantity: size / price, originalQuantity: size / price, originalCostUsd: size,
      amountInvestedUsd: size, entryTime: new Date().toISOString(), highestPrice: price,
      tp1Done: false, tp2Done: false, remainingPercent: 100, strategy: "Gemini Paper v3: sell 95% at +15% / trail final 5% by 8% / SL12 / 10–12.5% cash",
      sizingPercent: sizing.percent,
      entryDetails: candidate.geminiDetails || {}, liveExecution: candidate.liveExecution || null, mode,
      liveSizingStep: candidate.liveExecution ? getLiveSizing().step : null
    };
    next.cashUsd -= size; next.position = pos;
    next.nextSizingStep = sizing.step === 0 ? 1 : 0;
    next.history.unshift({ type: "BUY", ...structuredClone(pos), time: pos.entryTime, amountUsd: size, mode });
    commit(next);
    console.log("[BUY TRIGGERED] Gemini " + mode, pos.symbol, size.toFixed(2), "USD");
    return { success: true, position: structuredClone(pos) };
  }
  function sell(priceUsd, percentOriginal, reason, execution = null) {
    const p = state.position;
    const price = Number(priceUsd);
    if (!p || !(price > 0) || !(percentOriginal > 0)) return { success: false, error: "No valid open position" };
    const qty = Math.min(p.quantity, p.originalQuantity * percentOriginal / 100);
    if (!(qty > 0)) return { success: false, error: "No remaining quantity" };
    const actualUsdc = Number(execution?.actualOutputAmount) / 1e6;
    const value = Number.isFinite(actualUsdc) && actualUsdc >= 0 ? actualUsdc : qty * price;
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
      reason, time: new Date().toISOString(), mode: execution ? "LIVE" : "PAPER", execution
    };
    next.history.unshift(trade);
    if (execution && p.liveExecution) {
      // Only advance after a net profitable, confirmed live close. A loss
      // returns the next trade to the $5 base size.
      next.liveSizingStep = trade.pnlUsd > 0 ? (getLiveSizing().step + 1) % 3 : 0;
    }
    if (reason === "TP1 +50%" || reason === "TP +15% SELL 95%") next.position.tp1Done = true;
    if (reason === "TP2 +100%") next.position.tp2Done = true;
    if (next.position) next.position.remainingPercent = Math.max(0, next.position.quantity / next.position.originalQuantity * 100);
    if (next.position.quantity <= p.originalQuantity * 0.000001) next.position = null;
    commit(next);
    console.log("[" + (reason.startsWith("TP") ? "SELL " + reason : "SELL") + "] Gemini " + trade.mode, p.symbol, reason, "$" + value.toFixed(2));
    return { success: true, trade };
  }
  // A paper position with confirmed zero liquidity has no defensible sale
  // value. Close it at zero instead of leaving the bot permanently blocked.
  function writeOff(reason) {
    const p = state.position;
    if (!p) return { success: false, error: "No open position" };
    const basis = Number(p.amountInvestedUsd);
    const next = structuredClone(state);
    const trade = {
      type: "SELL", id: randomUUID(), positionId: p.id, tokenAddress: p.tokenAddress,
      pairAddress: p.pairAddress, symbol: p.symbol, entryPrice: p.entryPrice, exitPrice: 0,
      maxGainPercent: p.entryPrice > 0 ? (Number(p.highestPrice || p.entryPrice) / p.entryPrice - 1) * 100 : 0,
      quantity: p.quantity, amountUsd: 0, costBasisUsd: basis, pnlUsd: -basis,
      pnlPercent: -100, percentOfOriginalSold: p.originalQuantity > 0 ? p.quantity / p.originalQuantity * 100 : 100,
      reason, time: new Date().toISOString(), mode: "PAPER", writeOff: true
    };
    next.history.unshift(trade);
    next.position = null;
    commit(next);
    console.warn("[PAPER WRITE-OFF] Gemini", p.symbol, reason);
    return { success: true, trade };
  }
  function removeClosedPosition({ positionId, triggerSellId, tokenAddress, symbol, minimumRealizedPnlUsd = 0 }) {
    if (!positionId || !triggerSellId || !tokenAddress || !symbol) return { success: false, reason: "invalid correction target" };
    if (state.position?.id === positionId) return { success: false, reason: "position is still open" };
    const trigger = state.history.find(row => row.type === "SELL" && row.id === triggerSellId && row.positionId === positionId && row.tokenAddress === tokenAddress && row.symbol === symbol);
    const buy = state.history.find(row => row.type === "BUY" && row.id === positionId && row.tokenAddress === tokenAddress && row.symbol === symbol);
    if (!trigger || !buy) return { success: false, reason: "target records not found" };
    const rows = state.history.filter(row => row.positionId === positionId || (row.type === "BUY" && row.id === positionId));
    const sells = rows.filter(row => row.type === "SELL");
    if (!sells.length || sells.some(row => !Number.isFinite(Number(row.pnlUsd)))) return { success: false, reason: "incomplete trade history" };
    const realizedPnlUsd = sells.reduce((total, row) => total + Number(row.pnlUsd), 0);
    if (!Number.isFinite(realizedPnlUsd) || realizedPnlUsd < minimumRealizedPnlUsd || state.cashUsd < realizedPnlUsd) return { success: false, reason: "correction amount failed validation" };
    const next = structuredClone(state);
    next.cashUsd = Number((next.cashUsd - realizedPnlUsd).toFixed(12));
    next.history = next.history.filter(row => row.positionId !== positionId && !(row.type === "BUY" && row.id === positionId));
    next.ledgerCorrections = Array.isArray(next.ledgerCorrections) ? next.ledgerCorrections : [];
    next.ledgerCorrections.unshift({ type: "INVALID_PAPER_POSITION_REMOVED", positionId, symbol, tokenAddress, removedRows: rows.length, removedRealizedPnlUsd: realizedPnlUsd, time: new Date().toISOString() });
    commit(next);
    return { success: true, removedRows: rows.length, removedRealizedPnlUsd: realizedPnlUsd, cashUsd: next.cashUsd };
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
  return { getSizing, getLiveSizing, buy, sell, writeOff, removeClosedPosition, recordRejection, setScanTime, updatePosition, getState: () => structuredClone(state), file };
}
let instance;
const current = () => {
  if (!instance) {
    instance = createGeminiTrader();
    const correction = instance.removeClosedPosition({
      positionId: "01eea25e-e79a-43f5-8514-157b018e6f08",
      triggerSellId: "3d8c998e-d7e1-4059-8294-6a0a7b11b448",
      tokenAddress: "8fDi5agbC6HaqjFjMkRzzApcZEse5BR3RtfL9QsmoJxA",
      symbol: "BiuBiuBiu",
      minimumRealizedPnlUsd: 30000
    });
    if (correction.success) console.warn("[GEMINI LEDGER CORRECTION]", JSON.stringify(correction));
    // Remove only the proven invalid paper print: the Oct 25 Dig record used a
    // mismatched market quote and falsely reported $1,191.45 from a $42.62 buy.
    // The timestamp guard prevents this correction from touching any later Dig trade.
    const invalidDigSell = instance.getState().history.find(row =>
      row.type === "SELL" && row.mode === "PAPER" && row.symbol === "Dig" &&
      row.reason === "TP +15% FULL EXIT" && String(row.time || "").startsWith("2026-10-25T20:07:") &&
      Number(row.amountUsd) > 1000
    );
    if (invalidDigSell) {
      const digCorrection = instance.removeClosedPosition({
        positionId: invalidDigSell.positionId,
        triggerSellId: invalidDigSell.id,
        tokenAddress: invalidDigSell.tokenAddress,
        symbol: "Dig",
        minimumRealizedPnlUsd: 1000
      });
      if (digCorrection.success) console.warn("[GEMINI INVALID DIG PAPER TRADE REMOVED]", JSON.stringify(digCorrection));
    }
  }
  return instance;
};
module.exports = { createGeminiTrader, defaultFile, getSizing: (...a) => current().getSizing(...a), getLiveSizing: (...a) => current().getLiveSizing(...a), getState: (...a) => current().getState(...a), buy: (...a) => current().buy(...a), sell: (...a) => current().sell(...a), writeOff: (...a) => current().writeOff(...a), recordRejection: (...a) => current().recordRejection(...a), setScanTime: (...a) => current().setScanTime(...a), updatePosition: (...a) => current().updatePosition(...a) };
