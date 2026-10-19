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
  if (!(age >= 1 && age <= 25)) return reject('Age outside 1–25 minutes');
  if (!(progress >= 15 && progress <= 90)) return reject('Progress outside 15–90%');
  if (Number.isFinite(c.marketCapSol) && !(c.marketCapSol >= 6 && c.marketCapSol <= 150)) return reject('Market cap outside 6–150 SOL');
  const traders = Number(c.distinctTraders ?? (c.uniqueTraders instanceof Set ? c.uniqueTraders.size : c.uniqueTraders));
  const buys = Number(c.buyCount ?? 0), sells = Number(c.sellCount ?? 0);
  if (!(buys >= 6 || traders >= 4)) return reject('Insufficient traders / buys');
  const ratio = buys / (buys + sells);
  if (!(sells > 0 ? ratio >= 0.52 && ratio <= 0.90 : sells === 0 && buys >= 6)) return reject('Buy ratio outside 0.52–0.90 / insufficient buys with no sells');
  if (Number(c.creatorBuyTokens) > 0 && !(Number(c.creatorSellTokens || 0) / Number(c.creatorBuyTokens) <= 0.5)) return reject('Creator sold over 50%');
  if (typeof c.symbol !== 'string' || c.symbol.length < 1 || c.symbol.length > 16) return reject('Invalid symbol length');
  if (c.graduated || c.nsfw) return reject('Graduated / NSFW');
  return { accepted: true, reason: '15–90% curve', progress, buyRatio: ratio };
}
module.exports = { evaluatePumpCandidate, progressFromVirtualSol };
