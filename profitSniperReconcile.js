const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const RECONCILIATION_ID = "exclude-fishy-and-dependent-bear-2026-10-13";
const FISHY_POSITION_ID = "20acc90f-e882-4b36-ac64-8f15808a23a6";
const BEAR_POSITION_ID = "593f3434-fef4-4000-ae7b-5b4d7756a36d";
const FISHY_MINT = "EvXQnNoGFK427sLKn1MJgaeqTYyUe9QNGvzQjebaCi6J";
const BEAR_MINT = "49PU6ENTpYc3zkhgCruzCSBzgVAdix5muP2oVzRGpump";

function reconcileProfitSniperAccount(dataFile, io = fs) {
  if (!io.existsSync(dataFile)) return { applied: false, reason: "no-account" };
  const original = io.readFileSync(dataFile, "utf8");
  const state = JSON.parse(original);
  if (state.reconciliationId === RECONCILIATION_ID) return { applied: false, reason: "already-applied" };
  const rows = state.history || [];
  const positions = state.positions || [];
  const expected = new Map([[FISHY_POSITION_ID, FISHY_MINT], [BEAR_POSITION_ID, BEAR_MINT]]);
  const exactLedger = rows.length === 6 && rows.every(row =>
    expected.get(row.positionId) === row.tokenAddress && ["BUY", "SELL"].includes(row.type)
  ) && rows.filter(row => row.type === "BUY").length === 2;
  if (state.sessionId !== "profit-sniper-45-45-10-2026-10-13" ||
      state.startingBalance !== 200 || positions.length || !exactLedger) {
    return { applied: false, reason: "account-differs-from-audited-ledger" };
  }

  const now = new Date().toISOString();
  const backupFile = dataFile + ".pre-reconciliation-" + RECONCILIATION_ID + ".json";
  io.writeFileSync(backupFile, original, { flag: "wx", flush: true });
  const next = {
    ...state,
    cashBalance: 200,
    history: [],
    reconciliationId: RECONCILIATION_ID,
    excludedTradeAudits: [
      ...(state.excludedTradeAudits || []),
      { positionId: FISHY_POSITION_ID, tokenAddress: FISHY_MINT,
        reason: "Invalid paper fill: exit pool had less than $1 liquidity; quoted price was not executable",
        excludedAt: now, history: rows.filter(row => row.positionId === FISHY_POSITION_ID) },
      { positionId: BEAR_POSITION_ID, tokenAddress: BEAR_MINT,
        reason: "Dependent trade: $731.37 entry was funded by the invalid fishy paper credit",
        excludedAt: now, history: rows.filter(row => row.positionId === BEAR_POSITION_ID) }
    ]
  };
  const temporary = dataFile + "." + randomUUID() + ".tmp";
  try {
    io.writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: "wx", flush: true });
    io.renameSync(temporary, dataFile);
  } finally {
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
  return { applied: true, backupFile };
}

module.exports = { reconcileProfitSniperAccount, RECONCILIATION_ID, FISHY_MINT };
