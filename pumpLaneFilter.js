'use strict';
function progressFromVirtualSol(raw) {
  let sol = Number(raw);
  if (!Number.isFinite(sol)) return NaN;
  if (sol >= 1000) sol /= 1e9;
  return Math.max(0, Math.min(100, (sol - 30) / 85 * 100));
}
function evaluatePumpCandidate(c, now = Date.now()) {
  const reject = reason => ({ accepted: false, reason });
  if (c.txType === 'create' || c.firstBlock === true) return reject('Create / first-block buy');
  const age = c.ageMinutes ?? (now - Number(c.createdAt)) / 60000;
  const progress = c.bondingProgress ?? progressFromVirtualSol(c.virtualSolReserves);
  if (!(age >= 3 && age <= 20)) return reject('Age outside 3–20 minutes');
  if (!(progress >= 55 && progress <= 82)) return reject('Progress outside 55–82%');
  if (c.marketCapSol != null && !(Number(c.marketCapSol) >= 18 && Number(c.marketCapSol) <= 75)) return reject('Market cap outside 18–75 SOL');
  const traders = c.uniqueTraders instanceof Set ? c.uniqueTraders.size : Number(c.distinctTraders ?? c.uniqueTraders);
  const buys = Number(c.buyCount), sells = Number(c.sellCount);
  if (!(traders >= 12 && buys >= 18)) return reject('Insufficient traders / buys');
  const ratio = buys / (buys + sells);
  if (!(ratio >= 0.58 && ratio <= 0.86)) return reject('Buy ratio outside 0.58–0.86');
  if (Number(c.creatorBuyTokens) > 0 && !(Number(c.creatorSellTokens || 0) / Number(c.creatorBuyTokens) <= 0.4)) return reject('Creator sold over 40%');
  if (typeof c.symbol !== 'string' || c.symbol.length < 2 || c.symbol.length > 12) return reject('Invalid symbol length');
  if (c.graduated || c.nsfw) return reject('Graduated / NSFW');
  return { accepted: true, reason: 'Final stretch', progress, buyRatio: ratio };
}
module.exports = { evaluatePumpCandidate, progressFromVirtualSol };
