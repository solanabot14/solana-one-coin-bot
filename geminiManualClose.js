async function closeGeminiPosition({ trader, getQuote, lastKnownPrice, log = console.log }) {
  const p = trader.getState().position;
  if (!p) return { success: false, closed: [], message: "No open Gemini position." };

  let price = 0;
  let priceSource = "fresh";
  try {
    const quote = await getQuote(p.tokenAddress, { pairAddress: p.pairAddress || undefined });
    const fresh = Number(quote && quote.priceUsd);
    if (fresh > 0 && Number.isFinite(fresh)) price = fresh;
  } catch (_) {}

  if (!(price > 0)) {
    const last = Number(typeof lastKnownPrice === "function" ? lastKnownPrice(p.id) : 0);
    if (last > 0 && Number.isFinite(last)) {
      price = last;
      priceSource = "last-known";
      log("[INFO] Gemini MANUAL CLOSE using last known price", { symbol: p.symbol, price });
    }
  }
  if (!(price > 0)) {
    return { success: false, closed: [], message: "No fresh or last known price; position left open." };
  }

  // The monitor may have exited the position while the quote was in flight.
  const current = trader.getState().position;
  if (!current || current.id !== p.id) {
    return { success: false, closed: [], message: "Position changed; not closed." };
  }

  const result = trader.sell(price, 100, "MANUAL CLOSE");
  if (!result || !result.success) {
    const error = (result && result.error) || "Sell failed.";
    return { success: false, closed: [], error, message: error };
  }
  const trade = result.trade;
  return {
    success: true,
    closed: [{
      symbol: p.symbol, positionId: p.id, exitPrice: trade.exitPrice,
      pnlUsd: trade.pnlUsd, pnlPercent: trade.pnlPercent, priceSource
    }],
    message: "Closed Gemini position " + p.symbol + " (MANUAL CLOSE)."
  };
}

module.exports = { closeGeminiPosition };
