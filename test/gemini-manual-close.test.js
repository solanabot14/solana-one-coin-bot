const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { createGeminiTrader } = require("../geminiTrader");
const { closeGeminiPosition } = require("../geminiManualClose");

const quiet = () => {};

function withTrader(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-manual-close-"));
  return Promise.resolve()
    .then(() => fn(createGeminiTrader(path.join(dir, "state.json"))))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function openPosition(trader) {
  const result = trader.buy({ tokenAddress: "Mint1", pairAddress: "Pair1", symbol: "TEST", name: "Test", priceUsd: 1 }, 10);
  assert.equal(result.success, true);
  return result.position;
}

test("manual close with no position reports it and leaves cash and history alone", () => withTrader(async trader => {
  const before = trader.getState();
  const result = await closeGeminiPosition({
    trader, getQuote: async () => ({ priceUsd: 1 }), lastKnownPrice: () => 1, log: quiet
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.closed, []);
  assert.equal(result.message, "No open Gemini position.");
  const after = trader.getState();
  assert.equal(after.cashUsd, before.cashUsd);
  assert.equal(after.history.length, before.history.length);
}));

test("manual close with a fresh quote sells 100% as MANUAL CLOSE", () => withTrader(async trader => {
  const position = openPosition(trader);
  const cashBefore = trader.getState().cashUsd;
  let args = null;
  const result = await closeGeminiPosition({
    trader, getQuote: async (...a) => { args = a; return { priceUsd: 1.1 }; }, lastKnownPrice: () => 0, log: quiet
  });
  assert.deepEqual(args, ["Mint1", { pairAddress: "Pair1" }]);
  assert.equal(result.success, true);
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].positionId, position.id);
  assert.equal(result.closed[0].priceSource, "fresh");
  assert.equal(result.closed[0].exitPrice, 1.1);
  const state = trader.getState();
  assert.equal(state.position, null);
  assert.ok(state.cashUsd > cashBefore);
  assert.equal(state.history[0].type, "SELL");
  assert.equal(state.history[0].reason, "MANUAL CLOSE");
}));

test("manual close falls back to the last known price when the quote fails", () => withTrader(async trader => {
  const position = openPosition(trader);
  const logs = [];
  const result = await closeGeminiPosition({
    trader, getQuote: async () => { throw new Error("quote down"); },
    lastKnownPrice: id => id === position.id ? 0.9 : 0, log: (...a) => logs.push(a)
  });
  assert.equal(result.success, true);
  assert.equal(result.closed[0].priceSource, "last-known");
  assert.equal(result.closed[0].exitPrice, 0.9);
  assert.equal(trader.getState().position, null);
  assert.equal(trader.getState().history[0].reason, "MANUAL CLOSE");
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /MANUAL CLOSE using last known price/);
}));

test("manual close leaves the position open when no price is available", () => withTrader(async trader => {
  const position = openPosition(trader);
  const historyLength = trader.getState().history.length;
  const result = await closeGeminiPosition({
    trader, getQuote: async () => ({}), lastKnownPrice: () => 0, log: quiet
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "No fresh or last known price; position left open.");
  assert.equal(trader.getState().position.id, position.id);
  assert.equal(trader.getState().history.length, historyLength);
}));

test("manual close does not sell when the position changed during the quote", () => withTrader(async trader => {
  openPosition(trader);
  let sells = 0;
  const wrapped = {
    getState: trader.getState,
    sell: (...a) => { sells++; return trader.sell(...a); }
  };
  const result = await closeGeminiPosition({
    trader: wrapped,
    // The monitor exits the position while the quote is in flight.
    getQuote: async () => { trader.sell(0.5, 100, "HARD STOP -8%"); return { priceUsd: 1.1 }; },
    lastKnownPrice: () => 0, log: quiet
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "Position changed; not closed.");
  assert.equal(sells, 0);
  const history = trader.getState().history;
  assert.equal(history.filter(row => row.reason === "MANUAL CLOSE").length, 0);
}));

test("manual close does not sell a different position with a new id", () => withTrader(async trader => {
  const position = openPosition(trader);
  let sells = 0;
  let calls = 0;
  const wrapped = {
    getState: () => {
      const state = trader.getState();
      if (++calls > 1) state.position = { ...state.position, id: "another-position" };
      return state;
    },
    sell: () => { sells++; return { success: true, trade: {} }; }
  };
  const result = await closeGeminiPosition({
    trader: wrapped, getQuote: async () => ({ priceUsd: 1.1 }), lastKnownPrice: () => 0, log: quiet
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "Position changed; not closed.");
  assert.equal(sells, 0);
  assert.equal(trader.getState().position.id, position.id);
}));
