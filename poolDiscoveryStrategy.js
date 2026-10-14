const DEFAULTS = Object.freeze({
  minimumLiquidityUsd: 20000,
  minimumVolume24hUsd: 25000,
  minimumVolume5mUsd: 1500,
  minimumTransactions5m: 12,
  minimumBuyRatio5m: 0.55,
  minimumPriceChange5m: 0.25,
  maximumPriceChange5m: 8,
  minimumPriceChange1h: -10,
  maximumPriceChange1h: 40,
  maximumPriceChange24h: 250
});

function analyzePoolCandidate(data) {
  const liquidity = Number(data?.liquidityUsd);
  const volume24h = Number(data?.volume24h);
  const volume5m = Number(data?.volume5m);
  const buys5m = Number(data?.buys5m);
  const sells5m = Number(data?.sells5m);
  const transactions5m = buys5m + sells5m;
  const buyRatio5m = transactions5m > 0 ? buys5m / transactions5m : 0;
  const change5m = Number(data?.priceChange5m);
  const change1h = Number(data?.priceChange1h);
  const change24h = Number(data?.priceChange24h);
  const hasChange1h = data?.priceChange1h !== null && data?.priceChange1h !== undefined && Number.isFinite(change1h);
  const hasChange24h = data?.priceChange24h !== null && data?.priceChange24h !== undefined && Number.isFinite(change24h);

  const checks = [
    ["liquidity", Number.isFinite(liquidity) && liquidity >= DEFAULTS.minimumLiquidityUsd],
    ["24h volume", Number.isFinite(volume24h) && volume24h >= DEFAULTS.minimumVolume24hUsd],
    ["5m volume", Number.isFinite(volume5m) && volume5m >= DEFAULTS.minimumVolume5mUsd],
    ["5m transactions", Number.isFinite(transactions5m) && transactions5m >= DEFAULTS.minimumTransactions5m],
    ["5m buy ratio", buyRatio5m >= DEFAULTS.minimumBuyRatio5m],
    ["5m momentum", Number.isFinite(change5m) && change5m >= DEFAULTS.minimumPriceChange5m && change5m <= DEFAULTS.maximumPriceChange5m],
    ["1h trend", !hasChange1h || (change1h >= DEFAULTS.minimumPriceChange1h && change1h <= DEFAULTS.maximumPriceChange1h)],
    ["24h anti-chase", !hasChange24h || change24h <= DEFAULTS.maximumPriceChange24h]
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  const score = Math.min(14, Math.round((passed / checks.length) * 14));
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const signal = failed.length === 0 ? "BUY" : "AVOID";
  const reasons = failed.length
    ? failed.map(name => "Watcher gate failed: " + name)
    : [
      "Paper Launch Watcher activity and momentum gates passed",
      "5m momentum " + change5m.toFixed(2) + "%; 1h trend " + change1h.toFixed(2) + "%"
    ];
  return { score, signal, reasons, failedGates: failed };
}

module.exports = { DEFAULTS, analyzePoolCandidate };

