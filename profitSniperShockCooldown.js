const DEFAULTS = Object.freeze({
  cooldownMs: 5 * 60 * 1000,
  priceDropPercent: 12,
  liquidityDropPercent: 20,
  maxObservationGapMs: 75 * 1000
});

function createShockCooldown(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const pools = new Map();

  function keyFor(coin) {
    return `${String(coin?.tokenAddress || "")}:${String(coin?.pairAddress || "")}`;
  }

  function observe(coin, now = Date.now()) {
    const key = keyFor(coin);
    const price = Number(coin?.priceUsd);
    const liquidity = Number(coin?.liquidityUsd);
    if (!key || key === ":" || !(price > 0))
      return { active: false, reason: null, cooldownUntil: null, priceDropPercent: null, liquidityDropPercent: null };

    const previous = pools.get(key);
    const recent = previous && now > previous.lastAt && now - previous.lastAt <= config.maxObservationGapMs;
    const priceDropPercent = recent && previous.price > 0
      ? Math.max(0, (previous.price - price) / previous.price * 100) : 0;
    const liquidityDropPercent = recent && previous.liquidity > 0 && liquidity > 0
      ? Math.max(0, (previous.liquidity - liquidity) / previous.liquidity * 100) : 0;
    const reasons = [];
    if (priceDropPercent >= config.priceDropPercent) reasons.push("rapid_price_drop");
    if (liquidityDropPercent >= config.liquidityDropPercent) reasons.push("rapid_liquidity_drop");

    let cooldownUntil = previous?.cooldownUntil || 0;
    if (reasons.length) cooldownUntil = Math.max(cooldownUntil, now + config.cooldownMs);
    pools.set(key, {
      lastAt: now,
      price,
      liquidity: liquidity > 0 ? liquidity : previous?.liquidity || null,
      cooldownUntil,
      reason: reasons.length ? reasons.join(",") : previous?.reason || null
    });

    for (const [poolKey, state] of pools) {
      if (now - state.lastAt > config.cooldownMs + config.maxObservationGapMs && state.cooldownUntil <= now)
        pools.delete(poolKey);
    }

    const active = cooldownUntil > now;
    return {
      active,
      reason: active ? (reasons.join(",") || previous?.reason || "rapid_drop_cooldown") : null,
      cooldownUntil: active ? cooldownUntil : null,
      remainingMs: active ? cooldownUntil - now : 0,
      priceDropPercent,
      liquidityDropPercent
    };
  }

  function getStatus(now = Date.now()) {
    const activePools = [...pools.entries()]
      .filter(([, state]) => state.cooldownUntil > now)
      .map(([key, state]) => ({
        tokenAddress: key.split(":")[0],
        pairAddress: key.slice(key.indexOf(":") + 1),
        cooldownUntil: new Date(state.cooldownUntil).toISOString(),
        reason: state.reason
      }));
    return { ...config, activePools: activePools.length, pools: activePools };
  }

  return { observe, getStatus };
}

module.exports = { DEFAULTS, createShockCooldown };
