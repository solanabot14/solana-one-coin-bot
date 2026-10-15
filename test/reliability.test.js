const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createPaperTrader } = require("../paperTrader");
const { createBot: createSharedBot } = require("../bot");
const createBot = options => createSharedBot({discoverCandidates:async()=>[],checkLiquidityLock:async()=>({allowed:true,lockedPercent:100}),notifier:{notifyTrade:async()=>{},notifyCritical:async()=>{}},...options});
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

test("current +20%/+40% profit targets and 12% trailing exit execute once and restore across restart", async t => {
  const { trader, file } = account(t);
  trader.buy(coin);
  let quote = 1.21;
  const timers = fakeTimers();
  const bot = createBot({ trader, timers, getTokenData: async () => ({ priceUsd: quote }) });
  bot.startBot();
  await settle();
  await timers.run(2000);
  assert.equal(trader.getPortfolio().history.length, 2);
  quote = 1.41;
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

test("public configuration stays read-only and respects Railway port", () => {
  assert.equal(getConfig({}).host, "127.0.0.1");
  assert.equal(getConfig({ HOST: "0.0.0.0" }).readOnly, true);
  assert.throws(() => getConfig({DASHBOARD_USER:"admin"}), /DASHBOARD/);
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
  let options, requestUrl;
  const controller = new AbortController();
  const sandbox = { module: { exports: {} }, console, require: name => {
    assert.equal(name, "axios");
    return { get: async (url, config) => {
      requestUrl = url;
      options = config;
      return { data: [
        { chainId: "solana", baseToken: { address: "wrong-token" }, liquidity: { usd: 999999 }, priceUsd: "999" },
        { chainId: "solana", baseToken: { address: "token1" }, liquidity: { usd: 100000 }, priceUsd: "1" }
      ] };
    } };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../dexscreener.js"), "utf8"), sandbox);
  const data = (await sandbox.module.exports.getTokensData(["token1"], { signal: controller.signal })).get("token1");
  assert.equal(data.priceUsd, "1");
  assert.match(requestUrl, /tokens\/v1\/solana\/token1$/);
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
  t.after(() => server.close());
  const request = (url, { method = "GET", headers = {} } = {}) => new Promise(resolve => {
    const responseHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) responseHeaders[name.toLowerCase()] = value;
      },
      end(body = "") { resolve({ status: this.statusCode, headers: responseHeaders, body: String(body) }); }
    };
    const normalizedHeaders = { host: "127.0.0.1", ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])) };
    server.emit("request", { method, url, headers: normalizedHeaders }, res);
  });
  const headers = { Authorization: "Basic " + Buffer.from("admin:test-password-long-enough").toString("base64") };
  assert.equal((await request("/healthz")).status, 200);
  assert.equal((await request("/api/data")).status, 401);
  assert.equal((await request("/api/data", { headers: { Authorization: "Basic " + Buffer.from("admin:wrong-password").toString("base64") } })).status, 401);
  assert.equal((await request("/api/start", { headers })).status, 405);
  assert.equal((await request("/api/start", { method: "POST", headers })).status, 403);
  headers["X-Bot-Control"] = "1";
  assert.equal((await request("/api/start", { method: "POST", headers })).status, 200);
  assert.equal(running, true);
  assert.equal((await request("/api/stop", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  await request("/api/stop", { method: "POST", headers });
  assert.equal(running, false);
  const page = await request("/", { headers });
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.match(page.body, /dashboard-client.js/);
});

test("browser escapes hostile symbols and preserves unavailable equity", () => {
  const {context,node,ui}=require('./helpers/client.cjs').clientContext();
  const symbol='<img src=x onerror="alert(1)">';
  const data={startingBalance:100,cashBalance:90,equity:null,totalPnl:null,
    livePositions:[{position:{symbol},live:null}],completedTrades:[{symbol,entryPrice:1,exitPrice:1,amountInvested:10,pnl:0,pnlPercent:0}]};
  ui.state.api={v31:data};ui.buildSystems();assert.equal(ui.systems().find(s=>s.id==='v31').equity,null);context.location.pathname='/trading/v31';ui.render();
  const html=node('view').innerHTML;
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/&lt;img/);
  assert.match(html,/Not recorded/);
});
