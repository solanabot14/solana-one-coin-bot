const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJanMvpTrader, getConfig, defaultDataFile } = require("../janMvpTrader");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-methodology-"));
  const trader = createJanMvpTrader({
    dataFile: path.join(dir, "swarmMethodologyData.json"),
    config: getConfig({ SWARM_STARTING_CAPITAL: "10", SWARM_GENESIS_COUNT: "5" })
  });
  return { dir, trader, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function coin(priceUsd) {
  return { tokenAddress: "exact-mint-address", symbol: "TEST", priceUsd };
}

test("starts $10 as five independent $2 Genesis roots and a 25-child pyramid", () => {
  const f = fixture();
  try {
    const dashboard = f.trader.getDashboardState();
    assert.equal(dashboard.startingCapital, 10);
    assert.deepEqual(dashboard.slots.map(s => [s.swarmId, s.localX, s.cashBalance]), [
      ["G1", 2, 2], ["G2", 2, 2], ["G3", 2, 2], ["G4", 2, 2], ["G5", 2, 2]
    ]);
    assert.equal(dashboard.pyramidMultipliers.length, 25);
    assert.equal(dashboard.pyramidMultipliers.reduce((sum, n) => sum + n, 0), 55);
    assert.equal(defaultDataFile().endsWith("swarmMethodologyData.json"), true);
  } finally { f.close(); }
});

test("allocates realized profits 50/25/25, creates children in pyramid order, and inherits local X", () => {
  const f = fixture();
  try {
    assert.equal(f.trader.buy(1, coin(1)).success, true);
    const result = f.trader.sell(1, 51, 100, { reason: "TEST_WIN" });
    assert.equal(result.success, true);
    assert.equal(result.childrenCreated.length, 7);

    const state = f.trader.getState();
    const parent = state.slots.find(s => s.swarmId === "G1");
    const firstChild = state.slots.find(s => s.swarmId === "G1.1");
    const secondRowChild = state.slots.find(s => s.swarmId === "G1.2");
    const twoXChild = state.slots.find(s => s.swarmId === "G1.3");
    assert.deepEqual([state.realizedProfit, state.reinvestedProfit, state.pocketedProfit, state.reproductionAllocated], [100, 50, 25, 25]);
    assert.deepEqual(parent.children.slice(0, 3), ["G1.1", "G1.2", "G1.3"]);
    assert.deepEqual([firstChild.localX, firstChild.formationRow, firstChild.formationMultiplier], [2, 1, 1]);
    assert.deepEqual([secondRowChild.localX, secondRowChild.formationRow, secondRowChild.formationMultiplier], [2, 2, 1]);
    assert.deepEqual([twoXChild.localX, twoXChild.formationRow, twoXChild.formationMultiplier], [4, 2, 2]);
    assert.equal(f.trader.getDashboardState().slots.find(s => s.id === twoXChild.id).nextChild.cost, 4);
    assert.ok(state.genealogy.every(item => item.parentCapitalAfter >= item.parentCapitalBefore * 0.75 - 1e-9));
  } finally { f.close(); }
});

test("keeps attacking and growing when the next child is not affordable", () => {
  const f = fixture();
  try {
    f.trader.buy(1, coin(1));
    f.trader.sell(1, 3, 100);
    let state = f.trader.getDashboardState();
    const parent = state.slots.find(s => s.id === 1);
    assert.equal(parent.reproductionEligible, false);
    assert.equal(parent.growthStatus, "GROWING_TOWARD_NEXT_CHILD");
    assert.equal(state.childrenCreated, 0);
    assert.equal(parent.cashBalance, 4);

    f.trader.buy(1, coin(1));
    f.trader.sell(1, 3, 100);
    state = f.trader.getDashboardState();
    assert.equal(state.childrenCreated, 1);
    assert.equal(state.slots.find(s => s.swarmId === "G1.1").localX, 2);
  } finally { f.close(); }
});
