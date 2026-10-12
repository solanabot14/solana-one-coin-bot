const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPaperTrader } = require("../paperTrader");

test("manual no-liquidity write-off closes the paper position, records zero recovery, and frees its slot", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-writeoff-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const trader = createPaperTrader(path.join(directory, "account.json"), fs, {
    startingBalance: 100,
    maxOpenPositions: 1,
    estimateExecutionCosts: ({ side }) => side === "BUY"
      ? { feesUsd: 0.03, slippageUsd: 0.07, poolFeeUsd: 0.02, solanaFeeUsd: 0.01, priorityFeeUsd: 0 }
      : null
  });
  const bought = trader.buy({ tokenAddress: "Token111", symbol: "CARLO", priceUsd: 1, liquidityUsd: 2000 });
  assert.equal(bought.success, true);
  const closed = trader.writeOff(trader.positionKey(bought.trade), "MANUAL PAPER WRITE-OFF · NO LIQUIDITY");
  assert.equal(closed.success, true);
  assert.equal(closed.writeOff, true);
  assert.equal(closed.trade.saleValue, 0);
  assert.equal(closed.trade.exitPrice, 0);
  assert.equal(closed.trade.percentSold, 100);
  assert.equal(closed.trade.pnl, -10.1);
  assert.equal(trader.getPortfolio().positions.length, 0);
  assert.equal(trader.getPortfolio().cashBalance, 89.9);
  const nextBuy = trader.buy({ tokenAddress: "Token222", symbol: "NEXT", priceUsd: 1, liquidityUsd: 2000 });
  assert.equal(nextBuy.success, true);
});

test("write-off refuses an already-closed position without changing the ledger", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-writeoff-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const trader = createPaperTrader(path.join(directory, "account.json"), fs, { startingBalance: 100 });
  const result = trader.writeOff("not-open", "MANUAL PAPER WRITE-OFF · NO LIQUIDITY");
  assert.equal(result.success, false);
  assert.equal(trader.getPortfolio().positions.length, 0);
  assert.equal(trader.getPortfolio().history.length, 0);
});
