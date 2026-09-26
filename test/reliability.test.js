const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createPaperTrader } = require("../paperTrader");
const { createBot } = require("../bot");
const { buildDashboardData, groupCompletedTrades } = require("../dashboardData");
const { createDashboardServer, getConfig } = require("../dashboard");

const coin = { symbol: "TEST", name: "Test", tokenAddress: "token1", priceUsd: 1, signal: "STRONG BUY", score: 12 };
function account(t) {
  const root = path.resolve(__dirname, "../.test-data");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "account-"));
  t.after(() => {
    // Only remove the specific isolated directory created by this test.
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith("account-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "tradingData.json");
  return { file, trader: createPaperTrader(file) };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function fakeTimers() {
  let next = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(fn, ms) { callbacks.set(++next, { fn, ms }); return next; },
    clearInterval(id) { callbacks.delete(id); },
    run(ms) { return Promise.all([...callbacks.values()].filter(c => c.ms === ms).map(c => c.fn())); }
  };
}

test("profit flags, high, quantity and account survive restart; copies cannot mutate state", t => {
  const { file, trader } = account(t);
  assert.equal(trader.buy(coin).success, true);
  assert.equal(trader.buy(coin).success, false);
  const key = trader.positionKey(trader.getPortfolio().position);
  trader.updateHigh(key, 1.4);
  trader.sell(1.16, 25, { expectedPosition: key, takeProfit: "firstTakeProfitDone" });
  const restarted = createPaperTrader(file);
  assert.equal(restarted.getPortfolio().position.firstTakeProfitDone, true);
  assert.equal(restarted.getPortfolio().position.highestPrice, 1.4);
  assert.equal(restarted.sell(1.16, 25, { takeProfit: "firstTakeProfitDone" }).success, false);
  restarted.sell(1.31, 35, { takeProfit: "secondTakeProfitDone" });
  const restored = createPaperTrader(file).getPortfolio();
  assert.equal(restored.position.secondTakeProfitDone, true);
  assert.ok(Math.abs(restored.position.quantity - 4.875) < 1e-10);
  restored.position.quantity = 0;
  assert.ok(restarted.getPortfolio().position.quantity > 0);
});

test("failed atomic replacement leaves disk and memory unchanged", t => {
  const { file, trader } = account(t);
  trader.buy(coin);
  const before = fs.readFileSync(file, "utf8");
  const broken = createPaperTrader(file, { ...fs, renameSync() { throw Error("Disk unavailable"); } });
  assert.throws(() => broken.sell(1.2, 25, { takeProfit: "firstTakeProfitDone" }), /Disk unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(broken.getPortfolio(), trader.getPortfolio());
});

test("corrupt accounts fail without resetting; nonfinite sale inputs are rejected", t => {
  const { file, trader } = account(t);
  trader.buy(coin);
  assert.equal(trader.sell(Infinity).success, false);
  assert.equal(trader.sell(1, NaN).success, false);
  assert.equal(trader.sell(1, 100, { expectedPosition: "old-position" }).success, false);
  fs.writeFileSync(file, "{broken");
  assert.throws(() => createPaperTrader(file));
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("Stop discards delayed discovery, rapid restart has only two timers, scans do not overlap", async t => {
  const { trader } = account(t);
  const pending = deferred();
  const timers = fakeTimers();
  let scans = 0;
  let signal;
  const bot = createBot({ trader, timers, discoverCandidates: options => {
    signal = options.signal;
    scans++;
    return scans === 1 ? pending.promise : Promise.resolve([coin]);
  } });
  t.after(() => bot.stopBot());
  bot.startBot();
  await timers.run(120000);
  assert.equal(scans, 1);
  bot.stopBot();
  assert.equal(signal.aborted, true);
  bot.startBot();
  assert.equal(timers.callbacks.size, 2);
  pending.resolve([coin]);
  await settle();
  assert.equal(trader.getPortfolio().position, null);
  await timers.run(120000);
  assert.equal(trader.getPortfolio().history.length, 1);
});

test("delayed monitoring cannot sell after Stop or sell a replacement position", async t => {
  const { trader } = account(t);
  trader.buy(coin);
  const pending = deferred();
  const timers = fakeTimers();
  let calls = 0;
  const bot = createBot({ trader, timers, getTokenData: () => { calls++; return pending.promise; } });
  bot.startBot();
  await timers.run(2000);
  assert.equal(calls, 1);
  bot.stopBot();
  pending.resolve({ priceUsd: 0.5 });
  await settle();
  assert.equal(trader.getPortfolio().history.length, 1);
  const second = deferred();
  const bot2 = createBot({ trader, timers, getTokenData: () => second.promise });
  t.after(() => bot2.stopBot());
  bot2.startBot();
  trader.sell(1);
  trader.buy({ ...coin, tokenAddress: "token2" });
  second.resolve({ priceUsd: 0.5 });
  await settle();
  assert.equal(trader.getPortfolio().position.tokenAddress, "token2");
  assert.equal(trader.getPortfolio().history.length, 3);
});

test("unchanged profit targets and trailing exit execute once and restore across restart", async t => {
  const { trader, file } = account(t);
  trader.buy(coin);
  let quote = 1.16;
  const timers = fakeTimers();
  const bot = createBot({ trader, timers, getTokenData: async () => ({ priceUsd: quote }) });
  bot.startBot();
  await settle();
  await timers.run(2000);
  assert.equal(trader.getPortfolio().history.length, 2);
  quote = 1.31;
  await timers.run(2000);
  assert.equal(trader.getPortfolio().history.length, 3);
  bot.stopBot();
  const restarted = createPaperTrader(file);
  const bot2 = createBot({ trader: restarted, timers, discoverCandidates: async () => [],
    getTokenData: async () => ({ priceUsd: 1.2 }) });
  t.after(() => bot2.stopBot());
  bot2.startBot();
  await settle();
  assert.equal(restarted.getPortfolio().position, null);
  assert.equal(restarted.getPortfolio().history.at(-1).reason, "TRAILING STOP");
});

test("dashboard excludes partial positions, averages exit prices and marks missing equity", async t => {
  const { trader } = account(t);
  trader.buy(coin);
  trader.sell(1.2, 25);
  assert.equal(groupCompletedTrades(trader.getPortfolio().history).length, 0);
  const missing = await buildDashboardData(trader.getPortfolio(), async () => null);
  assert.equal(missing.priceUnavailable, true);
  assert.equal(missing.equity, null);
  assert.equal(missing.totalPnl, null);
  trader.sell(1.4);
  const closed = await buildDashboardData(trader.getPortfolio(), async () => null);
  assert.equal(closed.stats.completedTrades, 1);
  assert.equal(closed.stats.profitFactorLabel, "∞");
  assert.ok(Math.abs(closed.completedTrades[0].exitPrice - 1.35) < 1e-10);
  assert.ok(Math.abs(closed.totalPnl - 3.5) < 1e-10);
});

test("network configuration requires credentials and respects Railway port", () => {
  assert.equal(getConfig({}).host, "127.0.0.1");
  assert.throws(() => getConfig({ HOST: "0.0.0.0" }), /DASHBOARD/);
  const config = getConfig({ RAILWAY_ENVIRONMENT_ID: "test", PORT: "4321",
    DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "test-password-long-enough" });
  assert.equal(config.port, 4321);
  assert.equal(config.host, "0.0.0.0");
});

test("hard stop and both momentum exits keep their original behavior", async t => {
  for (const [quote, reason] of [
    [{ priceUsd: 0.89 }, "HARD STOP"],
    [{ priceUsd: 0.97, priceChange5m: -3, buys5m: 4, sells5m: 8 }, "MOMENTUM EXIT"],
    [{ priceUsd: 0.94, priceChange5m: -1 }, "MOMENTUM EXIT"]
  ]) {
    const { trader } = account(t);
    trader.buy(coin);
    const bot = createBot({ trader, timers: fakeTimers(), getTokenData: async () => quote });
    bot.startBot();
    await settle();
    bot.stopBot();
    assert.equal(trader.getPortfolio().position, null);
    assert.equal(trader.getPortfolio().history.at(-1).reason, reason);
  }
});

test("V3.4 profit lock protects gains after a 10 percent peak", async t => {
  const { trader } = account(t);
  trader.buy(coin);
  let quote = 1.14;
  const timers = fakeTimers();
  const bot = createBot({ trader, timers, discoverCandidates: async () => [],
    getTokenData: async () => ({ priceUsd: quote }) });
  t.after(() => bot.stopBot());

  bot.startBot();
  await settle();
  assert.notEqual(trader.getPortfolio().position, null);
  assert.ok(trader.getPortfolio().position.highestPrice >= 1.14);

  quote = 1.059;
  await timers.run(2000);

  assert.equal(trader.getPortfolio().position, null);
  assert.equal(trader.getPortfolio().history.at(-1).reason, "PROFIT LOCK");
  assert.ok(trader.getPortfolio().history.at(-1).pnlPercent > 5);
});

test("V3.4 hands the runner to the 8 percent trailing stop after TP2", async t => {
  const { trader } = account(t);
  trader.buy(coin);
  let quote = 1.16;
  const timers = fakeTimers();
  const bot = createBot({ trader, timers, discoverCandidates: async () => [],
    getTokenData: async () => ({ priceUsd: quote }) });
  t.after(() => bot.stopBot());

  bot.startBot();
  await settle();
  await timers.run(2000);
  assert.equal(trader.getPortfolio().position.firstTakeProfitDone, true);

  quote = 1.31;
  await timers.run(2000);
  assert.equal(trader.getPortfolio().position.secondTakeProfitDone, true);

  quote = 2.00;
  await timers.run(2000);
  assert.notEqual(trader.getPortfolio().position, null);

  quote = 1.85;
  await timers.run(2000);
  assert.notEqual(trader.getPortfolio().position, null);

  quote = 1.83;
  await timers.run(2000);
  assert.equal(trader.getPortfolio().position, null);
  assert.equal(trader.getPortfolio().history.at(-1).reason, "TRAILING STOP");
});

test("storage errors pause the bot and remove timers", async t => {
  const { trader } = account(t);
  trader.buy(coin);
  const timers = fakeTimers();
  const bot = createBot({ trader: { ...trader, updateHigh() { throw Error("Disk unavailable"); } },
    timers, getTokenData: async () => ({ priceUsd: 1.2 }) });
  bot.startBot();
  await settle();
  assert.equal(bot.getBotStatus(), false);
  assert.equal(bot.getLastError(), "Disk unavailable");
  assert.equal(timers.callbacks.size, 0);
  assert.equal(trader.getPortfolio().history.length, 1);
});

test("market requests carry a timeout and cancellation signal and reject another base token", async () => {
  let options;
  const controller = new AbortController();
  const sandbox = { module: { exports: {} }, console, require: name => {
    assert.equal(name, "axios");
    return { get: async (url, config) => {
      options = config;
      return { data: { pairs: [
        { chainId: "solana", baseToken: { address: "wrong-token" }, liquidity: { usd: 999999 }, priceUsd: "999" },
        { chainId: "solana", baseToken: { address: "token1" }, liquidity: { usd: 100000 }, priceUsd: "1" }
      ] } };
    } };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../dexscreener.js"), "utf8"), sandbox);
  const data = await sandbox.module.exports.getTokenData("token1", { signal: controller.signal });
  assert.equal(data.priceUsd, "1");
  assert.equal(options.timeout, 10000);
  assert.equal(options.signal, controller.signal);
});

test("HTTP authentication, POST controls, cross-site rejection and health endpoint", async t => {
  const config = getConfig({ DASHBOARD_USER: "admin", DASHBOARD_PASSWORD: "test-password-long-enough" });
  let running = false;
  const server = createDashboardServer({ config, controls: {
    startBot() { running = true; }, stopBot() { running = false; },
    getBotStatus: () => running, getLastError: () => null
  }, portfolio: () => ({ startingBalance: 100, cashBalance: 100, position: null, history: [] }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = "http://127.0.0.1:" + server.address().port;
  const headers = { Authorization: "Basic " + Buffer.from("admin:test-password-long-enough").toString("base64") };
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await fetch(url + "/api/data")).status, 401);
  assert.equal((await fetch(url + "/api/start", { headers })).status, 405);
  assert.equal((await fetch(url + "/api/start", { method: "POST", headers })).status, 403);
  headers["X-Bot-Control"] = "1";
  assert.equal((await fetch(url + "/api/start", { method: "POST", headers })).status, 200);
  assert.equal(running, true);
  assert.equal((await fetch(url + "/api/stop", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  await fetch(url + "/api/stop", { method: "POST", headers });
  assert.equal(running, false);
  const page = await fetch(url, { headers });
  assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.match(await page.text(), /dashboard-client.js/);
});

test("browser renders hostile symbols as text and unavailable equity honestly", () => {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { addEventListener() {} });
    return nodes.get(id);
  } };
  const source = fs.readFileSync(path.join(__dirname, "../dashboard-client.js"), "utf8")
    .replace(/pollStatus\(\);\s*pollData\(\);\s*$/, "");
  const context = { document };
  vm.runInNewContext(source, context);
  const symbol = '<img src=x onerror="alert(1)">';
  context.renderData({ startingBalance: 100, cashBalance: 90, equity: null, totalPnl: null,
    position: { symbol }, live: null,
    stats: { completedTrades: 0, winRate: 0, winners: 0, losers: 0, grossProfit: 0, grossLoss: 0, netPnl: 0, profitFactorLabel: "—" },
    completedTrades: [{ symbol, tokenAddress: "token1", entryPrice: 1, exitPrice: 1, amountInvested: 10, pnl: 0, pnlPercent: 0 }] });
  assert.equal(nodes.get("equity").textContent, "Unavailable");
  assert.match(nodes.get("live").textContent, /price unavailable/);
  assert.ok(!nodes.get("history").innerHTML.includes("<img"));
  assert.match(nodes.get("history").innerHTML, /&lt;img/);
});
