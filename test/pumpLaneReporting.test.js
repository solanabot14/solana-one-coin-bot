'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createPumpLaneTrader } = require('../pumpLaneTrader');
const { createPumpLaneFreeFeed } = require('../pumpLaneFreeFeed');
function account(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-lane-reporting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPumpLaneTrader(path.join(dir, 'pump-lane-state.json'));
}
test('Pump Lane live row reports current price, net unrealized P&L and holding time', t => {
  const a = account(t), now = Date.now();
  a.buy({ mint: 'coin', symbol: 'TEST', priceUsd: 1 }, now - 60000);
  a.decideExit(1.2, now, now);
  const d = a.dashboard(now), p = d.livePositions[0];
  assert.equal(d.quoteAvailable, true);
  assert.equal(p.currentPrice, 1.2);
  assert.equal(p.holdTimeMs, 60000);
  assert.ok(p.pnl > 0); assert.equal(p.pnlUsd, p.pnl);
  assert.ok(Math.abs(d.equity - d.cashBalance - p.currentValue) < 1e-9);
  assert.ok(Math.abs(p.pnlPercent - p.pnl / p.amountInvestedUsd * 100) < 1e-9);
});
test('stale prices remain unavailable; checking the position never refreshes the quote timestamp', t => {
  const a = account(t), now = Date.now();
  a.buy({ mint: 'coin', symbol: 'TEST', priceUsd: 1 }, now);
  a.decideExit(1.1, now + 130000, now);
  const d = a.dashboard(now + 130000);
  assert.equal(d.equity, null); assert.equal(d.totalPnl, null);
  assert.equal(d.livePositions[0].pnl, null); assert.equal(d.livePositions[0].currentPrice, null);
  assert.equal(d.livePositions[0].holdTimeMs, 130000);
  assert.equal(d.cashBalance, 190);
});
test('cash-only account needs no market quote', t => {
  const d = account(t).dashboard(); assert.equal(d.quoteAvailable, true); assert.equal(d.equity, d.cashBalance);
});
class Socket {
  static all = [];
  constructor(url) { this.url = url; this.handlers = {}; this.readyState = 0; this.sent = []; Socket.all.push(this); }
  addEventListener(k, cb) { this.handlers[k] = cb; }
  send(data) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.handlers.open(); }
  close() { this.readyState = 3; this.handlers.close?.({code:1000}); }
  message(data) { this.handlers.message({data:JSON.stringify(data)}); }
}
test('one unindexed coin is a warning and does not invalidate the feed', async t => {
  const events = [];
  const feed = createPumpLaneFreeFeed({ apiKey:'', WebSocketImpl:Socket, fetchImpl:async()=>({ok:false,status:400}), onStatus:x=>events.push(x) });
  t.after(() => feed.stop()); feed.start(); Socket.all.at(-1).open();
  await feed.addMint('missing', {symbol:'TEST'});
  assert.equal(feed.status().error, null); assert.equal(feed.status().connected, true);
  assert.equal(feed.status().warnings.length, 1);
  assert.ok(events.some(x=>x.warning));
  feed.removeMint('missing'); assert.equal(feed.status().warnings.length, 0);
});
test('reconnect restores retained curves, prioritizes the open position, and paces subscriptions', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const curves = [], feed = createPumpLaneFreeFeed({ apiKey:'', WebSocketImpl:Socket, priorityMint:()=> 'open', onCurve:c=>curves.push(c.mint) });
  t.after(()=>feed.stop()); feed.start(); let ws = Socket.all.at(-1); ws.open();
  await feed.addMint('old',{bondingCurveKey:'old-curve'});
  await feed.addMint('open',{bondingCurveKey:'open-curve'});
  assert.equal(ws.sent.length, 2); assert.equal(feed.status().queuedSubscriptions, 2);
  t.mock.timers.tick(500); assert.equal(ws.sent.length, 4);
  ws.readyState = 3; ws.handlers.close({code:1006});
  t.mock.timers.tick(5000); ws = Socket.all.at(-1); ws.open();
  assert.equal(ws.sent.length,2);
  assert.equal(ws.sent[0].params[0].mentions[0],'open'); assert.equal(ws.sent[1].params[0],'open-curve');
  ws.message({id:ws.sent[1].id,result:999});
  const data = Buffer.alloc(49); data.writeBigUInt64LE(1000000000000000n,8); data.writeBigUInt64LE(72500000000n,16);
  ws.message({method:'accountNotification',params:{subscription:999,result:{value:{data:[data.toString('base64'),'base64']}}}});
  assert.deepEqual(curves,['open']); assert.equal(feed.getCandidate('open').lastQuoteAt,Date.now()); assert.equal(feed.status().error,null);
  t.mock.timers.tick(500); assert.equal(ws.sent.length,4);
});
test('removed mint cannot leave a queued subscription behind', async t => {
  const feed = createPumpLaneFreeFeed({apiKey:'',WebSocketImpl:Socket}); t.after(()=>feed.stop());
  feed.start(); const ws=Socket.all.at(-1); ws.open();
  await feed.addMint('a',{bondingCurveKey:'ac'}); await feed.addMint('b',{bondingCurveKey:'bc'});
  assert.equal(feed.status().queuedSubscriptions,2); feed.removeMint('b'); assert.equal(feed.status().queuedSubscriptions,0);
});
function uiContext() {
  const nodes={}, node=id=>nodes[id] ||= {innerHTML:'',textContent:'',parentNode:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){}};
  const context={Intl,URL,URLSearchParams,Date,console,OneCoinAnalytics:require('../analytics-core'),document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},location:{pathname:'/',search:'',href:'https://example.test/'},window:{addEventListener(){},scrollTo(){}},history:{pushState(){},replaceState(){}},setInterval(){}};
  const source=fs.readFileSync(path.join(__dirname,'../dashboard-client.js'),'utf8').replace('  loadData();','  globalThis.testUi={state,render};');
  vm.runInNewContext(source,context); return {ui:context.testUi,node};
}
test('Pump Lane cash is included during a feed error, while another bot keeps its existing rules', t => {
  const {ui,node}=uiContext(), d=account(t).dashboard();
  const a={...d,completedTrades:[],equity:100,totalPnl:0,livePositions:[]};
  ui.state.api={v31:a,candleBreakout:a,candleBreakoutStatus:{running:true},profitSniper:a,profitSniperStatus:{running:true},gemini:a,geminiStatus:{running:true},outcomeBot:a,outcomeBotStatus:{running:true},stockBot:a,stockBotStatus:{running:true},pumpLane:d,pumpLaneStatus:{running:true,error:'Socket disconnected'}};
  ui.state.status={running:true}; ui.state.swarm={running:true,startingCapital:100,totalCapital:100,totalPnl:0,slots:[]};
  ui.render(); assert.doesNotMatch(node('view').innerHTML,/Pump Lane \(feed error\)/);
  assert.match(node('view').innerHTML,/Socket disconnected/);
  ui.state.api.geminiStatus.error='Other feed down'; ui.render(); assert.match(node('view').innerHTML,/Gemini Bot \(feed error\)/);
  ui.state.api.pumpLane={...d,equity:null,quoteAvailable:false}; ui.render(); assert.match(node('view').innerHTML,/Pump Lane \(no current quote\)/);
});
