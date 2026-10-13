const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { reconcileProfitSniperAccount, RECONCILIATION_ID, FISHY_MINT } = require("../profitSniperReconcile");

const FISHY_ID = "20acc90f-e882-4b36-ac64-8f15808a23a6";
const BEAR_ID = "593f3434-fef4-4000-ae7b-5b4d7756a36d";
const BEAR_MINT = "49PU6ENTpYc3zkhgCruzCSBzgVAdix5muP2oVzRGpump";

function account(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-reconcile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "profitSniperTradingData.json");
  const state = { startingBalance: 200, cashBalance: 6005.276799853257, positions: [],
    sessionId: "profit-sniper-45-45-10-2026-10-13", archivedSessions: [{ history: [{ type: "BUY", symbol: "old" }] }],
    history: [
      { type: "BUY", positionId: FISHY_ID, tokenAddress: FISHY_MINT, symbol: "fishy", amountInvested: 20 },
      { type: "SELL", positionId: FISHY_ID, tokenAddress: FISHY_MINT, symbol: "fishy", pnl: 5650.935862368671 },
      { type: "BUY", positionId: BEAR_ID, tokenAddress: BEAR_MINT, symbol: "Bear", amountInvested: 731.3669827960858 },
      ...Array.from({ length: 3 }, () => ({ type: "SELL", positionId: BEAR_ID, tokenAddress: BEAR_MINT, symbol: "Bear" }))
    ], ...overrides };
  fs.writeFileSync(file, JSON.stringify(state));
  return { file, state };
}

test("reconciles exactly the audited invalid credit and its dependent trade once", t => {
  const { file, state } = account(t);
  const result = reconcileProfitSniperAccount(file);
  assert.equal(result.applied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupFile)), state);
  const current = JSON.parse(fs.readFileSync(file));
  assert.equal(current.startingBalance, 200);
  assert.equal(current.cashBalance, 200);
  assert.deepEqual(current.history, []);
  assert.deepEqual(current.archivedSessions, state.archivedSessions);
  assert.equal(current.reconciliationId, RECONCILIATION_ID);
  assert.equal(current.excludedTradeAudits.length, 2);
  assert.equal(current.excludedTradeAudits[0].history.length, 2);
  assert.equal(current.excludedTradeAudits[1].history.length, 4);
  assert.equal(reconcileProfitSniperAccount(file).reason, "already-applied");
});

test("does not alter an account with other trades or an open position", t => {
  const { file } = account(t, { positions: [{ id: "extra" }] });
  const original = fs.readFileSync(file, "utf8");
  assert.equal(reconcileProfitSniperAccount(file).reason, "account-differs-from-audited-ledger");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});
