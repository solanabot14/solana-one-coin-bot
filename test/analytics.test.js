const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createPaperTrader } = require("../paperTrader");
const { buildDashboardData, groupCompletedTrades } = require("../dashboardData");

const candidate = { tokenAddress: "token", symbol: "TEST", priceUsd: 1, score: 12,
  priceChange5m: 2.5, priceChange1h: 14, buys5m: 60, sells5m: 40,
  liquidityUsd: 150000, volume24h: 500000 };
const metrics = { entryScore: 12, entryPriceChange5m: 2.5, entryPriceChange1h: 14,
  entryBuyRatio: 0.6, entryBuys5m: 60, entrySells5m: 40,
  entryLiquidityUsd: 150000, entryVolume24h: 500000 };

test("entry snapshot survives quotes, partial sales and restart; exit dollars use sale records", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-analytics-"));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith("bot-analytics-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "tradingData.json");
  let trader = createPaperTrader(file);
  const selected = { ...candidate };
  trader.buy(selected);
  selected.score = 0;
  selected.buys5m = 0;
  const id = trader.getPortfolio().position.id;
  trader.updateHigh(id, 1.5);
  await buildDashboardData(trader.getPortfolio(), async () => ({ ...candidate, priceUsd: 1.5, score: 0, buys5m: 1 }));
  trader.sell(1.2, 25, { reason: "TAKE PROFIT 1" });
  trader = createPaperTrader(file);
  for (const [key, value] of Object.entries(metrics)) assert.equal(trader.getPortfolio().position[key], value);
  trader.sell(1.4, 35, { reason: "TAKE PROFIT 2" });
  trader.sell(1.3, 50, { reason: "TRAILING STOP" });
  trader.sell(1.1, 100, { reason: "MOMENTUM EXIT" });
  const saved = createPaperTrader(file).getPortfolio();
  for (const row of saved.history) {
    assert.equal(row.positionId, id);
    for (const [key, value] of Object.entries(metrics)) assert.equal(row[key], value);
  }
  const before = JSON.stringify(saved);
  const data = await buildDashboardData(saved, async () => { throw Error("No live quote needed"); });
  assert.equal(JSON.stringify(saved), before);
  const [completed] = data.completedTrades;
  assert.equal(data.completedTrades.length, 1);
  for (const [key, value] of Object.entries(metrics)) assert.equal(completed[key], value);
  for (const [key, value] of Object.entries({ tp1SaleValue: 3, tp2SaleValue: 3.675,
    trailingSaleValue: 3.16875, otherExitSaleValue: 2.68125, saleValue: 12.525 })) {
    assert.ok(Math.abs(completed[key] - value) < 1e-10, key);
  }
  assert.equal(completed.saleValue, saved.history.filter(t => t.type === "SELL").reduce((sum, t) => sum + t.saleValue, 0));
});

function history(id, time = "2026-01-01T00:00:00Z") {
  const base = { tokenAddress: "token", symbol: "TEST", entryTime: time, entryPrice: 1 };
  return [
    { ...base, type: "BUY", ...(id ? { id } : {}), quantity: 10, amountInvested: 10 },
    { ...base, type: "SELL", ...(id ? { positionId: id } : {}), percentSold: 25,
      quantitySold: 2.5, saleValue: 7.25, reason: "TAKE PROFIT 1" },
    { ...base, type: "SELL", ...(id ? { positionId: id } : {}), percentSold: 100,
      quantitySold: 7.5, saleValue: 8.5, reason: "HARD STOP", exitTime: "2026-01-01T01:00:00Z" }
  ];
}

test("legacy history remains valid without fabricated metrics or percentage-based proceeds", async () => {
  const old = history();
  const data = await buildDashboardData({ startingBalance: 100, cashBalance: 105.75, position: null, history: old });
  const [trade] = data.completedTrades;
  for (const key of Object.keys(metrics)) assert.equal(trade[key], null, key);
  assert.equal(trade.saleValue, 15.75);
  assert.equal(trade.tp1SaleValue, 7.25);
  assert.equal(trade.otherExitSaleValue, 8.5);
  assert.equal(trade.tp2SaleValue, 0);
  assert.deepEqual(data.scoreStats, []);
  old[0].entryBuyRatio5m = 0.65;
  assert.equal(groupCompletedTrades(old)[0].entryBuyRatio, 0.65);
});

test("position IDs separate identical token/times and bridge unambiguous older partial sells", () => {
  const first = history("first"), second = history("second");
  assert.equal(groupCompletedTrades([...first, ...second]).length, 2);
  assert.equal(groupCompletedTrades([...first, ...second], { ...second[0] }).length, 1);
  delete first[1].positionId;
  assert.equal(groupCompletedTrades(first)[0].saleValue, 15.75);
  assert.equal(groupCompletedTrades(first, first[0]).length, 0);
  const olderBuy = history("bridge");
  delete olderBuy[0].id;
  assert.equal(groupCompletedTrades(olderBuy)[0].saleValue, 15.75);
  assert.equal(groupCompletedTrades([...history(), ...history(null, "2026-01-02T00:00:00Z")]).length, 2);
  assert.equal(groupCompletedTrades(history("open").slice(0, 2)).length, 0);
});

test("current transaction table and drawer preserve recorded dollars and missing metrics", () => {
  const {ui,node}=require('./helpers/client.cjs').clientContext();
  const records=history();
  records[1].pnl=0.25;
  records[2].pnl=0.50;
  records[2].reason='Trailing stop 10%';
  const trade=groupCompletedTrades(records)[0];
  const system={id:'v31',name:'V3.1',mode:'PAPER'};
  const normalized=ui.normalizeTrade(trade,system,false);
  const html=ui.renderTransactions([normalized]);
  assert.match(html,/\$15\.75/);
  assert.match(html,/DEXSCREENER/);
  assert.match(html,/Not recorded/);
  assert.equal(normalized.invested,10);
  assert.equal(normalized.saleValue,15.75);
  assert.equal(normalized.sourceRecord.tp1SaleValue,7.25);
  ui.openTransaction(0);
  assert.match(node('detailDrawer').innerHTML,/7\.25/);
  assert.match(node('detailDrawer').innerHTML,/15\.75/);
  assert.match(node('detailDrawer').innerHTML,/REALIZED PROFIT BY EXIT/);
  assert.match(node('detailDrawer').innerHTML,/\$0\.25/);
  assert.match(node('detailDrawer').innerHTML,/\$0\.50/);
  assert.match(node('detailDrawer').innerHTML,/Trailing/);
  const empty=ui.renderTransactions([]);
  assert.match(empty,/No transactions/);
});
