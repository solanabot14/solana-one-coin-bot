"use strict";

async function getGeminiPositionMark(position, marketData, now = Date.now(), fallbackMarketData = null) {
  if (!position) return null;

  let quote = null;
  if (typeof marketData === "function") {
    try {
      quote = await marketData(position.tokenAddress, {
        pairAddress: position.pairAddress || undefined,
        allowAlternatePairQuote: true
      });
    } catch (_) {}
  }

  let priceUsd = Number(quote?.priceUsd);
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
    try {
      quote = typeof fallbackMarketData === "function"
        ? await fallbackMarketData(position.tokenAddress)
        : null;
    } catch (_) {
      quote = null;
    }
    priceUsd = Number(quote?.priceUsd);
  }
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return null;

  const quantity = Number(position.quantity) || 0;
  const currentValueUsd = quantity * priceUsd;
  const investedUsd = Number(position.amountInvestedUsd ?? position.originalCostUsd) || 0;
  const pnl = currentValueUsd - investedUsd;

  return {
    priceUsd,
    currentValueUsd,
    pnl,
    pnlPercent: investedUsd > 0 ? pnl / investedUsd * 100 : 0,
    holdTimeMs: Math.max(0, now - Date.parse(position.entryTime)),
    pairAddress: quote.pairAddress || position.pairAddress || null,
    quoteProvider: quote.quoteProvider || "DexScreener",
    quoteWarning: quote.quoteWarning || null
  };
}

module.exports = { getGeminiPositionMark };
