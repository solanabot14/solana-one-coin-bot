const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
exports.clientContext=()=>{
 const nodes={};const node=id=>nodes[id]||(nodes[id]={innerHTML:'',textContent:'',setAttribute(){},parentNode:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){}});
 const context={Intl,URL,URLSearchParams,Date,console,OneCoinAnalytics:require('../../analytics-core'),document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},location:{pathname:'/',search:'',href:'https://example.test/'},window:{addEventListener(){},scrollTo(){}},history:{pushState(){},replaceState(){}},setInterval(){}};
 let source=fs.readFileSync(path.join(__dirname,'../../dashboard-client.js'),'utf8');
 source=source.replace('  loadData();\n  setInterval(function()', '  globalThis.audit={state,buildSystems,systems:()=>systems,render,normalizeTrade,renderTransactions,livePositionRow,openTransaction};\n  setInterval(function()');
 vm.runInNewContext(source,context);return {context,node,ui:context.audit};
};
