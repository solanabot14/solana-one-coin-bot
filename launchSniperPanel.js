(function(){
"use strict";
function esc(v){return String(v==null?"—":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function num(v){if(v===null||v===undefined||v==="")return null;var n=Number(v);return Number.isFinite(n)?n:null;}
function money(v){var n=num(v);return n===null?"Not recorded":"$"+n.toFixed(2);}
function price(v){var n=num(v);return n===null?"Not recorded":"$"+n.toPrecision(7);}
async function load(){
try{
const pair=await Promise.all([
fetch("/api/launch-sniper/data",{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("Account request failed");return r.json();}),
fetch("/api/launch-sniper/status",{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("Status request failed");return r.json();})
]);
const a=pair[0].account||{},s=pair[1],positions=a.livePositions||[],history=(a.history||[]).slice().reverse();
const equity=num(a.equity),pnl=num(a.totalPnl),trades=(a.completedTrades||[]).length;
const cards=[["MODE","PAPER ONLY"],["BOT",s.running?"RUNNING":"STOPPED"],["PAPER EQUITY",money(equity)],["TOTAL NET P&L",money(pnl)],["CLOSED POSITIONS",String(trades)],["OPEN POSITIONS",positions.length+" / 3"],["STARTING BALANCE",money(a.startingBalance)],["ENTRY SIZE","$10 fixed"]];
document.getElementById("launch-summary").innerHTML=cards.map(function(x){return '<div class="launch-card"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></div>';}).join("");
document.getElementById("launch-positions").innerHTML=positions.length?positions.map(function(x){var p=x.position||{},l=x.live||{},age=Number(p.experimentEntry&&p.experimentEntry.pairAgeMs);return '<tr><td>'+esc(p.symbol)+'</td><td>'+money(p.amountInvested)+'</td><td>'+price(p.entryPrice)+'</td><td>'+money(l.currentValue)+'</td><td>'+esc(l.pnlPercent==null?"Not recorded":(Number(l.pnlPercent)>=0?"+":"")+Number(l.pnlPercent).toFixed(2)+"%")+'</td><td>'+(Number.isFinite(age)?Math.max(0,Math.round(age/60000))+" min":"Not recorded")+'</td><td><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/'+encodeURIComponent(p.tokenAddress||"")+'">OPEN</a></td></tr>';}).join(""):'<tr><td colspan="7">No open paper position.</td></tr>';
document.getElementById("launch-history").innerHTML=history.length?history.slice(0,100).map(function(t){var pnl=num(t.netPnl??t.pnl);return '<tr><td>'+esc(new Date(t.exitTime||t.entryTime||t.timestamp||"").toLocaleString())+'</td><td>'+esc(t.symbol||"—")+'</td><td>'+esc(t.type)+'</td><td>'+money(t.amountInvested)+'</td><td>'+money(t.saleValue)+'</td><td>'+money(t.estimatedCostUsd)+'</td><td class="'+(pnl!==null&&pnl>=0?"launch-positive":"launch-negative")+'">'+money(pnl)+'</td><td>'+esc(t.reason||t.entryReasons?.join("; ")||"—")+'</td></tr>';}).join(""):'<tr><td colspan="8">No trade records yet.</td></tr>';
var d=s.scanDiagnostics,g=d&&d.gates,signals=d&&d.signalCounts||{};
var signalText=Object.keys(signals).map(function(k){return k+" "+signals[k];}).join(", ")||"none";
var scanText=d?" · Last scan: "+(d.poolsTracked||0)+" recent pools, "+d.dexPairsReturned+" pairs, "+(g?g.eligible:0)+" passed activity; signals "+signalText+(d.error?" · Feed error: "+d.error:""):" · Waiting for first scan";
document.getElementById("launch-status").textContent=s.error?"Bot error: "+s.error:"Updated "+new Date().toLocaleTimeString()+" · Entry checks: "+s.maximumPairAgeMinutes+"m age, 70% LP lock, $20k liquidity, $25k 24h volume."+scanText;
}catch(error){document.getElementById("launch-status").textContent="Dashboard feed unavailable: "+error.message;}
}
document.addEventListener("click",function(event){
const button=event.target.closest("[data-launch]");
if(button){fetch("/api/launch-sniper/"+button.dataset.launch,{method:"POST",headers:{"x-bot-control":"1"}}).then(load);return;}
if(event.target.closest("[data-launch-refresh]"))load();
});
load();setInterval(load,10000);
})();
