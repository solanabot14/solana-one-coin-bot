const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  recentTokenStats,
  exceptionalRunnerReentry,
  diversityDecision
} = require("../bot");

const NOW = Date.parse("2026-09-26T20:00:00Z");

function buy(positionId, tokenAddress, entryTime, entryPrice = 1, quantity = 10) {
  return {
    type: "BUY",
    positionId,
    tokenAddress,
    symbol: tokenAddress,
    entryTime,
    entryPrice,
    highestPrice: entryPrice,
    quantity
  };
}

function sell(positionId, tokenAddress, entryTime, {
  pnl,
  highestPrice,
  exitTime = "2026-09-26T19:00:00Z"
}) {
  return {
    type: "SELL",
    positionId,
    tokenAddress,
    symbol: tokenAddress,
    entryTime,
    exitTime,
    entryPrice: 1,
    highestPrice,
    quantitySold: 10,
    percentSold: 100,
    pnl
  };
}

function strongCoin(overrides = {}) {
  return {
    tokenAddress: "token",
    signal: "STRONG BUY",
    score: 10,
    priceChange5m: 1.2,
    priceChange1h: 8,
    buys5m: 65,
    sells5m: 35,
    ...overrides
  };
}

test("new token receives highest diversity priority", () => {
  assert.deepEqual(
    diversityDecision(strongCoin(), undefined),
    { eligible: true, priority: 0, reason: "NEW TOKEN" }
  );
});

test("normal winner rests for 24 hours instead of immediate repeat", () => {
  const entryTime = "2026-09-26T18:00:00Z";
  const history = [
    buy("p1", "winner", entryTime),
    sell("p1", "winner", entryTime, { pnl: 2, highestPrice: 1.20 })
  ];
  const stats = recentTokenStats(history, NOW).get("winner");
  assert.equal(stats.entries, 1);
  assert.equal(stats.winningCompletions, 1);
  assert.ok(stats.maxGainPercent < 30);
  assert.deepEqual(
    diversityDecision(strongCoin({ tokenAddress:"winner" }), stats),
    { eligible:false, priority:99, reason:"NORMAL WINNER REST 24H" }
  );
});

test("losing token can receive one second chance when it becomes STRONG BUY again", () => {
  const firstEntry = "2026-09-26T16:00:00Z";
  const history = [
    buy("p1", "loser", firstEntry),
    sell("p1", "loser", firstEntry, {
      pnl:-1,
      highestPrice:1.03,
      exitTime:"2026-09-26T17:00:00Z"
    })
  ];
  const stats = recentTokenStats(history, NOW).get("loser");
  assert.equal(stats.losingCompletions, 1);
  assert.deepEqual(
    diversityDecision(strongCoin({ tokenAddress:"loser" }), stats),
    { eligible:true, priority:1, reason:"LOSS SECOND CHANCE" }
  );

  const secondEntry = "2026-09-26T17:30:00Z";
  const secondHistory = [
    ...history,
    buy("p2", "loser", secondEntry),
    sell("p2", "loser", secondEntry, {
      pnl:-0.5,
      highestPrice:1.02,
      exitTime:"2026-09-26T18:30:00Z"
    })
  ];
  const twice = recentTokenStats(secondHistory, NOW).get("loser");
  assert.equal(twice.entries, 2);
  assert.equal(diversityDecision(strongCoin({ tokenAddress:"loser" }), twice).eligible, false);
});

test("30 percent runner may reenter only on exceptional confirmation", () => {
  const entryTime = "2026-09-26T16:00:00Z";
  const history = [
    buy("p1", "runner", entryTime),
    sell("p1", "runner", entryTime, {
      pnl:3,
      highestPrice:1.45,
      exitTime:"2026-09-26T17:00:00Z"
    })
  ];
  const stats = recentTokenStats(history, NOW).get("runner");
  assert.ok(stats.maxGainPercent >= 30);

  const exceptional = strongCoin({ tokenAddress:"runner" });
  assert.equal(exceptionalRunnerReentry(exceptional), true);
  assert.deepEqual(
    diversityDecision(exceptional, stats),
    { eligible:true, priority:2, reason:"RUNNER REENTRY" }
  );

  const weak = strongCoin({
    tokenAddress:"runner",
    score:8,
    buys5m:56,
    sells5m:44
  });
  assert.equal(exceptionalRunnerReentry(weak), false);
  assert.equal(diversityDecision(weak, stats).eligible, false);
});

test("activity older than 24 hours does not penalize a token", () => {
  const oldEntry = "2026-09-25T10:00:00Z";
  const history = [
    buy("old", "old-token", oldEntry),
    sell("old", "old-token", oldEntry, {
      pnl:5,
      highestPrice:1.20,
      exitTime:"2026-09-25T11:00:00Z"
    })
  ];
  assert.equal(recentTokenStats(history, NOW).has("old-token"), false);
});


test("a recent winning exit still rests even when the entry was more than 24 hours ago", () => {
  const longEntry = "2026-09-25T10:00:00Z";
  const history = [
    buy("long", "long-winner", longEntry),
    sell("long", "long-winner", longEntry, {
      pnl:4,
      highestPrice:1.25,
      exitTime:"2026-09-26T19:30:00Z"
    })
  ];
  const stats = recentTokenStats(history, NOW).get("long-winner");
  assert.ok(stats);
  assert.equal(stats.winningCompletions, 1);
  assert.equal(
    diversityDecision(strongCoin({ tokenAddress:"long-winner" }), stats).reason,
    "NORMAL WINNER REST 24H"
  );
});
