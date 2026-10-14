'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createEquityHistory}=require('../equityHistory');
const {buildGeminiAnalytics}=require('../geminiAnalytics');
const a=require('../analytics-core');
test('equity snapshots persist, throttle, retain 90 days, and never convert unknown quotes to zero',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'equity-audit-'));try{
 const file=path.join(dir,'history.json'),h=createEquityHistory(file),time=Date.parse('2026-10-14T12:00:00Z');
 h.record({v31:100,gemini:null,stock:NaN},time);assert.deepEqual(h.getRows()[0].values,{v31:100});
 h.record({v31:110},time+1000);assert.equal(h.getRows().length,1);
 h.record({v31:110},time+300000);assert.equal(createEquityHistory(file).getRows().length,2);
 h.record({v31:120},time+91*86400000);assert.equal(h.getRows().length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Gemini legacy id-only buys restore entry time, invested cash, return and liquidity',()=>{
 const data=buildGeminiAnalytics({cashUsd:12,startingBalanceUsd:10,history:[
 {type:'BUY',id:'p',symbol:'TEST',amountUsd:10,time:'2026-10-14T12:00:00Z',entryPrice:1,entryDetails:{liquidityUsd:100000}},
 {type:'SELL',positionId:'p',quantity:10,amountUsd:12,costBasisUsd:10,pnlUsd:2,time:'2026-10-14T12:05:00Z',reason:'TP'}]});
 const t=data.completedTrades[0];assert.equal(t.returnPercent,20);assert.equal(t.holdTimeMs,300000);assert.equal(t.entryLiquidityUsd,100000);
});
test('exchange aliases preserve sale proceeds and exit reason without fictional prices',()=>{
 const t=a.normalizeTrade({pnlUsd:2,investedUsd:10,saleValueUsd:12,exitReason:'HARD STOP'});
 assert.equal(t.pnl,2);assert.equal(t.invested,10);assert.equal(t.saleValue,12);assert.equal(t.exitReason,'HARD STOP');assert.equal(t.entryTime,null);
});
function clientContext(){
 const nodes={};const node=id=>nodes[id]||(nodes[id]={innerHTML:'',textContent:'',parentNode:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){}});
 const context={Intl,URL,URLSearchParams,Date,console,OneCoinAnalytics:a,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},location:{pathname:'/',search:'',href:'https://example.test/'},window:{addEventListener(){},scrollTo(){}},history:{pushState(){},replaceState(){}},setInterval(){}};
 let source=fs.readFileSync(path.join(__dirname,'../dashboard-client.js'),'utf8');
 source=source.replace('  loadData();\n  setInterval(function()', '  globalThis.audit={state,buildSystems,render,systems:()=>systems,swarmTrades,swarmTransactions,estimateTradeCosts,chartSeries};\n  setInterval(function()');
 vm.runInNewContext(source,context);return {context,nodes,node,ui:context.audit};
}
test('every bot route renders, full Lab records and Swarm closed positions appear, equity is usable',()=>{
 const {context,node,ui}=clientContext();const account={startingBalance:100,cashBalance:90,equity:102,totalPnl:2,totalPnlPercent:2,history:[],livePositions:[],completedTrades:[{positionId:'p',symbol:'<unsafe>',entryTime:'2026-10-14T12:00:00Z',exitTime:'2026-10-14T12:05:00Z',pnl:2,amountInvested:10,pnlPercent:20,entryLiquidityUsd:100000}]};
 ui.state.api={v31:account,candleBreakout:account,candleBreakoutStatus:{running:true},buyPriorityLock85:account,buyPriorityLock85Status:{running:true},launchSniper:account,launchSniperStatus:{running:true},profitSniper:account,profitSniperStatus:{running:true},walletCopy:account,walletCopyStatus:{running:true,error:'Quota exhausted'},gemini:account,geminiStatus:{running:true},outcomeBot:{...account,candidates:[]},outcomeBotStatus:{running:true},stockBot:account,stockBotStatus:{running:true},profitabilityLab:{...account,completedTrades:270,completedTradeRecords:account.completedTrades,running:true},equityHistory:[{time:'2026-10-14T12:00:00Z',values:{total:1122,v31:102}}]};
 ui.state.status={running:true};ui.state.swarm={running:true,startingCapital:100,totalCapital:102,totalPnl:2,slots:[],executions:[{type:'SELL',positionId:'p',time:'2026-10-14T12:05:00Z',pnl:1,amountInvested:5},{type:'SELL',positionId:'p',time:'2026-10-14T12:06:00Z',pnl:1,amountInvested:5,closedTrade:{positionId:'p',symbol:'T',realizedPnl:2,invested:10,entryTime:'2026-10-14T12:00:00Z',exitTime:'2026-10-14T12:06:00Z'}}]};
 ui.buildSystems();assert.equal(ui.systems().length,7);assert.equal(ui.systems().find(s=>s.id==='lab').historyLimited,false);assert.equal(ui.swarmTrades().length,1);assert.equal(ui.swarmTrades()[0].pnl,2);
 for(const route of ['/','/trading/v31','/trading/candle-breakout','/trading/b31-lab','/trading/profit-sniper','/trading/gemini','/trading/outcome','/trading/stock','/analytics','/reports','/transactions','/swarm']){context.location.pathname=route;assert.doesNotThrow(()=>ui.render(),route);assert.doesNotMatch(node('view').innerHTML,/<unsafe>/);}
 ui.state.chartMetric='EQUITY';assert.equal(ui.chartSeries()[0].points[0].value,1122);
 const c=ui.estimateTradeCosts({pnl:-1,estimatedFeesUsd:0.1,estimatedSlippageUsd:0.2});assert.equal(c.netPnl,-1);assert.equal(c.grossPnl,-0.7);
});

