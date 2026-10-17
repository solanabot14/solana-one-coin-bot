'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluatePumpCandidate: evaluate, progressFromVirtualSol: progress } = require('./pumpLaneFilter');
const { createPumpLaneTrader } = require('./pumpLaneTrader');
const clean = () => ({ mint: 'clean', symbol: 'CLEAN', ageMinutes: 5, virtualSolReserves: 85.25, marketCapSol: 50, distinctTraders: 15, buyCount: 20, sellCount: 10, creatorBuyTokens: 100, creatorSellTokens: 20 });
function account(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-lane-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { file: path.join(dir, 'pump-lane-state.json'), dir }; }
test('progress supports SOL and lamports', () => { assert.equal(progress(72.5), 50); assert.equal(progress(72500000000), 50); assert.equal(progress(10), 0); assert.equal(progress(200), 100); });
test('reject age below 3 minutes', () => assert.equal(evaluate({ ...clean(), ageMinutes: 2.99 }).accepted, false));
test('reject progress 20 and 96', () => { for (const bondingProgress of [20, 96]) assert.equal(evaluate({ ...clean(), bondingProgress }).accepted, false); });
test('reject creator selling 90%', () => assert.equal(evaluate({ ...clean(), creatorSellTokens: 90 }).accepted, false));
test('accept clean coin', () => assert.equal(evaluate(clean()).accepted, true));
test('reject creation and first block', () => { assert.equal(evaluate({ ...clean(), txType: 'create' }).accepted, false); assert.equal(evaluate({ ...clean(), firstBlock: true }).accepted, false); });
test('paper +50% triggers 40% original partial and remains open', t => {
  const { file } = account(t), a = createPumpLaneTrader(file);
  assert.equal(a.buy({ mint: 'coin', symbol: 'COIN', priceUsd: 1 }).success, true);
  const initial = a.getState().position;
  a.decideExit(1.5);
  const s = a.getState();
  assert.equal(s.position.tp1Done, true); assert.equal(s.position.tp2Done, false);
  assert.ok(Math.abs(s.position.quantity / initial.originalQuantity - 0.6) < 1e-9);
  assert.equal(s.history[0].reason, 'TP1 +40%'); assert.equal(s.history[0].exitPrice, 1.5 * 0.9925);
  assert.deepEqual(createPumpLaneTrader(file).getState(), s);
});
test('TP2 then trail completes one trade and reconciles account', t => {
  const a = createPumpLaneTrader(account(t).file); a.buy({ mint: 'coin', priceUsd: 1 });
  const entry = a.getState().position.entryPrice; a.decideExit(entry * 2);
  assert.ok(Math.abs(a.getState().position.quantity / a.getState().position.originalQuantity - 0.3) < 1e-9);
  a.decideExit(entry * 1.69);
  const d = a.dashboard(); assert.equal(d.completedTrades, 1); assert.equal(d.livePositions.length, 0);
  assert.ok(Math.abs(d.totalPnl - d.completedTradeRecords[0].pnlUsd) < 1e-9);
  assert.equal(a.buy({ mint: 'coin', priceUsd: 1 }).success, false);
});
test('hard stop and timeout close positions', t => {
  for (const [price, elapsed] of [[0.8, 0], [1, 18 * 60000]]) {
    const a = createPumpLaneTrader(account(t).file); a.buy({ mint: 'coin', priceUsd: 1 }, 1000); a.decideExit(price, 1000 + elapsed); assert.equal(a.getState().position, null);
  }
});
test('invalid JSON and invalid schema never reset the saved file', t => {
  const { file } = account(t);
  for (const text of ['{broken', '{}']) { fs.writeFileSync(file, text); assert.throws(() => createPumpLaneTrader(file), /refusing to reset/); assert.equal(fs.readFileSync(file, 'utf8'), text); }
});
test('one position and cash cap', t => {
  const a = createPumpLaneTrader(account(t).file); a.buy({ mint: 'a', priceUsd: 1 }); assert.equal(a.buy({ mint: 'b', priceUsd: 1 }).success, false); assert.ok(a.getState().cashBalance >= 0);
});
test('live flag is explicit and execution unimplemented', () => {
  const { liveEnabled, executeLive } = require('./pumpLaneLive'); const old = process.env.PUMP_LANE_LIVE;
  try { delete process.env.PUMP_LANE_LIVE; assert.equal(liveEnabled(), false); assert.throws(executeLive, /disabled/); process.env.PUMP_LANE_LIVE = 'true'; assert.equal(liveEnabled(), true); assert.throws(executeLive, /not implemented/); }
  finally { if (old === undefined) delete process.env.PUMP_LANE_LIVE; else process.env.PUMP_LANE_LIVE = old; }
});
test('socket never buys creation; preserves paper isolation and resumes watched position', t => {
  const { dir } = account(t), oldDir = process.env.DATA_DIR, oldWs = global.WebSocket, oldVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH; process.env.DATA_DIR = dir;
  const instances = [];
  class FakeSocket {
    constructor() { this.handlers = {}; this.sent = []; instances.push(this); }
    addEventListener(k, cb) { this.handlers[k] = cb; }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.handlers.close?.(); }
    event(obj) { this.handlers.message({ data: JSON.stringify(obj) }); }
  }
  global.WebSocket = FakeSocket;
  delete require.cache[require.resolve('./pumpLaneTrader')]; delete require.cache[require.resolve('./pumpLaneBot')];
  const bot = require('./pumpLaneBot'), trader = require('./pumpLaneTrader');
  try {
    bot.start(); const ws = instances[0]; ws.handlers.open();
    assert.deepEqual(ws.sent[0], { method: 'subscribeNewToken' });
    ws.event({ txType: 'create', mint: 'mint', symbol: 'TEST', traderPublicKey: 'creator', tokenAmount: 100 });
    assert.equal(trader.getState().position, null); assert.equal(bot.getStatus().watched, 1);
    assert.deepEqual(ws.sent[1], { method: 'subscribeTokenTrade', keys: ['mint'] });
    trader.buy({ mint: 'mint', symbol: 'TEST', priceUsd: 1 });
    ws.event({ txType: 'buy', mint: 'mint', solAmount: 0.01, tokenAmount: 1, traderPublicKey: 'trader' });
    assert.equal(trader.getState().position.tp1Done, true);
    assert.deepEqual(bot.getStatus(), { running: true, error: null, watched: 1, live: false, mode: 'PAPER' });
    for (let i = 0; i < 85; i++) ws.event({ txType: 'create', mint: 'm' + i, symbol: 'TEST' });
    assert.equal(bot.getStatus().watched, 80);
    assert.ok(!ws.sent.some(x => x.method === 'unsubscribeTokenTrade' && x.keys.includes('mint')));
    bot.stop(); bot.start(); instances[1].handlers.open();
    assert.ok(instances[1].sent.some(x => x.method === 'subscribeTokenTrade' && x.keys.includes('mint')));
    assert.deepEqual(fs.readdirSync(dir), ['pump-lane-state.json']);
  } finally {
    bot.stop(); global.WebSocket = oldWs;
    if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
    if (oldVolume === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH; else process.env.RAILWAY_VOLUME_MOUNT_PATH = oldVolume;
    delete require.cache[require.resolve('./pumpLaneTrader')]; delete require.cache[require.resolve('./pumpLaneBot')];
  }
});
test('dashboard has separate Pump Lane PAPER row, routes, controls and account strategy', t => {
  const vm = require('node:vm'), nodes = {};
  const node = id => nodes[id] ||= { innerHTML: '', textContent: '', parentNode: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} };
  const context = { Intl, URL, URLSearchParams, Date, console, OneCoinAnalytics: require('./analytics-core'), document: { getElementById: node, querySelectorAll: () => [], addEventListener() {} }, location: { pathname: '/', search: '', href: 'https://example.test/' }, window: { addEventListener() {}, scrollTo() {} }, history: { pushState() {}, replaceState() {} }, setInterval() {} };
  const source = fs.readFileSync(path.join(__dirname, 'dashboard-client.js'), 'utf8').replace('  loadData();', '  globalThis.audit={state,buildSystems,render,systems:()=>systems,routeForSystem};');
  vm.runInNewContext(source, context);
  const ui = context.audit, d = createPumpLaneTrader(account(t).file).dashboard();
  ui.state.api = { pumpLane: d, pumpLaneStatus: { running: true, mode: 'PAPER', live: false } };
  ui.buildSystems();
  const rows = ui.systems().filter(s => s.id === 'pump-lane'); assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, 'PAPER'); assert.equal(rows[0].equity, 200);
  assert.equal(ui.routeForSystem('pump-lane'), '/trading/pump-lane');
  for (const route of ['/trading/pump-lane', '/trading/pump-lane/live', '/trading/pump-lane/transactions']) {
    context.location.pathname = route; ui.render(); assert.match(node('view').innerHTML, /Pump Lane PAPER/); assert.match(node('view').innerHTML, /pump-lane\/start/); assert.doesNotMatch(node('view').innerHTML, /Original V3.1 entries/);
  }
  context.location.pathname = '/'; ui.render(); assert.match(node('view').innerHTML, /Pump Lane/);
});
