const { test } = require("node:test");
const assert = require("node:assert/strict");
const { repairKnownJtoBadQuote } = require("../paperTrader");

const TOKEN = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const PAIR = "G2FiE1yn9N9ZJx5e1E2LxxMnHvb1H3hCuHLPfKJ98smA";

test("repairs only the known JTO bad-quote incident and reverses fictitious cash", () => {
	const buy = {
		type:"BUY", positionId:"p1", symbol:"JTO", tokenAddress:TOKEN, pairAddress:PAIR,
		entryPrice:0.6347, quantity:18, amountInvested:11.424, entryTime:"2026-09-27T04:00:00.000Z"
	};
	const tp1 = {
		type:"SELL", positionId:"p1", symbol:"JTO", tokenAddress:TOKEN, pairAddress:PAIR,
		exitPrice:3042, saleValue:8213.4, reason:"TAKE PROFIT 1"
	};
	const tp2 = {
		type:"SELL", positionId:"p1", symbol:"JTO", tokenAddress:TOKEN, pairAddress:PAIR,
		exitPrice:3042, saleValue:16383.18, reason:"TAKE PROFIT 2"
	};
	const state = {
		startingBalance:100, cashBalance:24700, history:[buy,tp1,tp2], repairs:[],
		position:{
			id:"p1", symbol:"JTO", tokenAddress:TOKEN, pairAddress:PAIR, entryPrice:0.6347,
			quantity:9, amountInvested:5.712, entryTime:"2026-09-27T04:00:00.000Z",
			highestPrice:3042, firstTakeProfitDone:true, secondTakeProfitDone:true
		}
	};

	const result = repairKnownJtoBadQuote(state);
	assert.equal(result.changed, true);
	assert.equal(result.data.history.length, 1);
	assert.equal(result.data.position.quantity, 18);
	assert.equal(result.data.position.amountInvested, 11.424);
	assert.equal(result.data.position.firstTakeProfitDone, false);
	assert.equal(result.data.position.secondTakeProfitDone, false);
	assert.equal(result.data.position.highestPrice, 0.6347);
	assert.ok(Math.abs(result.data.cashBalance - (24700 - 8213.4 - 16383.18)) < 1e-9);
	assert.equal(result.data.repairs.length, 1);

	const second = repairKnownJtoBadQuote(result.data);
	assert.equal(second.changed, false);
});

test("does not touch another JTO position or a legitimate large runner", () => {
	const state = {
		startingBalance:100, cashBalance:90, history:[], repairs:[],
		position:{
			id:"other", symbol:"JTO", tokenAddress:TOKEN, pairAddress:PAIR, entryPrice:1.25,
			quantity:8, amountInvested:10, entryTime:"2026-09-27T05:00:00.000Z",
			highestPrice:5000, firstTakeProfitDone:true, secondTakeProfitDone:true
		}
	};
	const result = repairKnownJtoBadQuote(state);
	assert.equal(result.changed, false);
	assert.deepEqual(result.data, state);
});
