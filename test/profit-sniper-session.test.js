const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPaperTrader } = require('../paperTrader');
const { chooseExit, getBuySizing } = require('../profitSniperStrategy');
function account(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sniper-reset-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return path.join(dir,'account.json');
}
test('reset preserves every old event and open snapshot, persists archive, and never repeats',t=>{
 const file=account(t); const old=createPaperTrader(file);
 assert.equal(old.buy({tokenAddress:'mint-old',symbol:'SAME',priceUsd:100}).success,true);
 const before=JSON.parse(fs.readFileSync(file,'utf8'));
 const options={startingBalance:200,sessionResetId:'test-session',getBuySizing};
 const fresh=createPaperTrader(file,fs,options);
 const state=fresh.getPortfolio();
 assert.equal(state.cashBalance,200); assert.equal(state.startingBalance,200);
 assert.deepEqual(state.history,[]); assert.deepEqual(state.positions,[]);
 assert.deepEqual(state.archivedSessions[0].history,before.history);
 assert.deepEqual(state.archivedSessions[0].positions,before.positions);
 fresh.buy({tokenAddress:'mint-new',symbol:'SAME',priceUsd:100});
 const reopened=createPaperTrader(file,fs,options).getPortfolio();
 assert.equal(reopened.cashBalance,180); assert.equal(reopened.history.length,1);
 assert.equal(reopened.archivedSessions.length,1);
});
test('actual paper fills sell 45 original tokens twice then the last 10',t=>{
 const trader=createPaperTrader(account(t),fs,{startingBalance:1000,getBuySizing:()=>({amountInvested:100})});
 trader.buy({tokenAddress:'mint',pairAddress:'pool',priceUsd:1});
 for (const [price,remaining] of [[1.1,55],[1.2,10],[1.35,0]]) {
   let position=trader.getPortfolio().position;
   if(price===1.35) {trader.updateHigh(position.id,1.5);position=trader.getPortfolio().position;}
   const action=chooseExit({position,currentPrice:price});
   assert.ok(action); assert.equal(trader.sell(price,action.percent,{expectedPosition:position.id,...action}).success,true);
   assert.ok(Math.abs((trader.getPortfolio().position?.quantity||0)-remaining)<1e-9);
 }
 assert.equal(trader.getPortfolio().history.length,4);
});
test('failed reset save leaves original persisted account intact',t=>{
 const file=account(t); const trader=createPaperTrader(file);
 trader.buy({tokenAddress:'mint',priceUsd:1});
 const original=fs.readFileSync(file,'utf8');
 const io={...fs,renameSync(){throw new Error('disk failure');}};
 assert.throws(()=>createPaperTrader(file,io,{startingBalance:200,sessionResetId:'reset'}),/disk failure/);
 assert.equal(fs.readFileSync(file,'utf8'),original);
});
