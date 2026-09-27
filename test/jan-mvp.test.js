const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJanMvpTrader } = require("../janMvpTrader");

function setup(t, config = { slotCount: 2, startingSlotValue: 2, targets: [10,50,100,150] }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jan-mvp-"));
	t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
	const file = path.join(dir, "janMvpData.json");
	return { file, trader:createJanMvpTrader({ dataFile:file, config }) };
}

function coin(symbol="TEST", price=1) {
	return {
		symbol, name:symbol, tokenAddress:"token-" + symbol, pairAddress:"pair-" + symbol,
		priceUsd:price, signal:"STRONG BUY", score:12,
		priceChange5m:1, priceChange1h:5, priceChange24h:10,
		buys5m:60, sells5m:40, liquidityUsd:150000, volume24h:500000
	};
}

test("Jan MVP uses a completely separate persistent slot account", t => {
	const { file, trader } = setup(t);
	assert.equal(trader.getState().slots[0].cashBalance, 2);
	assert.equal(trader.getState().slots[1].cashBalance, 2);
	assert.equal(trader.buy(1, coin("A")).success, true);
	assert.equal(trader.getState().slots[0].cashBalance, 0);
	assert.equal(trader.getState().slots[0].position.originalAmountInvested, 2);
	assert.equal(trader.getState().slots[1].cashBalance, 2);
	assert.ok(fs.existsSync(file));

	const restarted = createJanMvpTrader({ dataFile:file, config:{ slotCount:99, startingSlotValue:99, targets:[999] } });
	assert.equal(restarted.getState().slots.length, 2);
	assert.equal(restarted.getState().slots[0].position.symbol, "A");
});

test("each slot compounds its entire realized balance independently", t => {
	const { trader } = setup(t);
	trader.buy(1, coin("A"));
	trader.sell(1, 2, 100, { reason:"TEST WIN" });
	assert.equal(trader.getState().slots[0].cashBalance, 4);
	assert.equal(trader.getState().slots[1].cashBalance, 2);

	trader.buy(1, coin("B"));
	assert.equal(trader.getState().slots[0].position.originalAmountInvested, 4);
	trader.sell(1, 1.5, 100, { reason:"TEST WIN" });
	assert.equal(trader.getState().slots[0].cashBalance, 6);
	assert.equal(trader.getState().slots[1].cashBalance, 2);
});

test("partial exits remain inside the same slot and a ten-dollar close funds two child slots", t => {
	const { trader } = setup(t, { slotCount:1, startingSlotValue:10, targets:[50,100,150] });
	trader.buy(1, coin("A"));
	const id = trader.getState().slots[0].position.id;

	const tp1 = trader.sell(1, 1.15, 15, {
		expectedPosition:id, takeProfit:"firstTakeProfitDone", reason:"TAKE PROFIT 1"
	});
	assert.equal(tp1.success, true);
	assert.ok(trader.getState().slots[0].cashBalance > 0);
	assert.ok(trader.getState().slots[0].position);

	const final = trader.sell(1, 1.20, 100, { expectedPosition:id, reason:"TRAILING STOP" });
	assert.equal(final.success, true);
	assert.equal(trader.getState().slots[0].position, null);
	assert.ok(trader.getState().slots[0].cashBalance > 6);
	assert.equal(trader.getState().slots.length, 3);
	assert.equal(trader.getState().slots[0].splitDone, true);
	assert.equal(trader.getState().slots[1].parentSlotId, 1);
	assert.equal(trader.getState().slots[2].parentSlotId, 1);
	assert.equal(trader.getState().slots[1].cashBalance, 2);
	assert.equal(trader.getState().slots[2].cashBalance, 2);
	assert.equal(trader.getState().slots[0].completedTrades, 1);
});

test("ten-dollar milestone changes the parent and children to the post-split one-hundred target", t => {
	const { trader } = setup(t);
	trader.buy(1, coin("A"));
	const first = trader.sell(1, 5, 100, { reason:"BIG WIN" });
	assert.deepEqual(first.newlyReached, [10]);
	assert.deepEqual(trader.getState().slots[0].milestonesReached, [10]);
	assert.deepEqual(trader.getState().slots[1].milestonesReached, []);
	assert.equal(trader.getState().slots.length, 4);
	const dashboard = trader.getDashboardState();
	assert.equal(dashboard.startingCapital, 4);
	assert.equal(dashboard.slots.find(slot => slot.id === 1).currentTarget, 100);
	assert.equal(dashboard.slots.find(slot => slot.id === 2).currentTarget, 10);
	assert.equal(dashboard.slots.find(slot => slot.parentSlotId === 1).currentTarget, 100);
});

test("executions stay in Jan MVP history only", t => {
	const { trader } = setup(t);
	trader.buy(2, coin("B"));
	trader.sell(2, 0.9, 100, { reason:"HARD STOP" });
	const state = trader.getDashboardState();
	assert.equal(state.executions.length, 2);
	assert.equal(state.executions[0].type, "SELL");
	assert.equal(state.executions[1].type, "BUY");
	assert.equal(state.tradesReplayed, 1);
});
