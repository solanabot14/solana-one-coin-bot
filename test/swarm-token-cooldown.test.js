const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenCooldownActive, TOKEN_COOLDOWN_MS } = require("../janMvpBot");

const TOKEN = "HELLMINT";
const lossExit = (overrides = {}) => ({
  type: "SELL",
  slotId: 4,
  tokenAddress: TOKEN,
  percentSold: 100,
  pnl: -1.1,
  time: "2026-10-23T04:01:09.056Z",
  ...overrides
});

test("cooldown constant is 60 minutes", () => {
  assert.equal(TOKEN_COOLDOWN_MS, 3600000);
});

test("full loss exit blocks the same token within the window, regardless of slot", () => {
  const now = Date.parse("2026-10-23T04:30:00.000Z");
  assert.equal(tokenCooldownActive([lossExit()], TOKEN, now), true);
  assert.equal(tokenCooldownActive([lossExit({ slotId: 5 })], TOKEN, now), true);
});

test("full loss exit no longer blocks after 61 minutes", () => {
  const now = Date.parse("2026-10-23T05:02:00.000Z");
  assert.equal(tokenCooldownActive([lossExit()], TOKEN, now), false);
});

test("loss on a different token does not block", () => {
  const now = Date.parse("2026-10-23T04:30:00.000Z");
  assert.equal(tokenCooldownActive([lossExit({ tokenAddress: "OTHER" })], "MINT", now), false);
});

test("profitable full exit does not block", () => {
  const now = Date.parse("2026-10-23T04:30:00.000Z");
  assert.equal(tokenCooldownActive([lossExit({ pnl: 2 })], TOKEN, now), false);
});

test("partial sell does not block", () => {
  const now = Date.parse("2026-10-23T04:30:00.000Z");
  assert.equal(tokenCooldownActive([lossExit({ percentSold: 25, pnl: -1 })], TOKEN, now), false);
});

test("empty executions does not block", () => {
  const now = Date.parse("2026-10-23T04:30:00.000Z");
  assert.equal(tokenCooldownActive([], TOKEN, now), false);
});
