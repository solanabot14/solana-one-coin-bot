"use strict";

async function getGeminiPositionMark(position, marketData, now = Date.now()) {
  if (!position || typeof marketData !== "function") return null;

  const quote = await marketData(position.tokenAddress, {
    pairAddress: position.pairAddress || undefined,
    allowAlternatePairQuote: true
  });
  const priceUsd = Number(quote?.priceUsd);
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
    quoteWarning: quote.quoteWarning || null
  };
}

module.exports = { getGeminiPositionMark };
