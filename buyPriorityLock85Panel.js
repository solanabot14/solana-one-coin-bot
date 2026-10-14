(function(){
"use strict";
function esc(v){return String(v==null?"—":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function money(v){return Number.isFinite(Number(v))?"$"+Number(v).toFixed(2):"—";}
function price(v){return Number.isFinite(Number(v))?"$"+Number(v).toPrecision(7):"—";}
async function load(){
try{
const pair=await Promise.all([fetch("/api/lock85/data",{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("Data request failed");return r.json();}),fetch("/api/lock85/status",{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("Status request failed");return r.json();})]);
const a=pair[0].account||{},s=pair[1],positions=a.positions||[],history=(a.history||[]).slice().reverse();
const sellRows=(a.history||[]).filter(function(x){return x.type==="SELL";}),pricedRows=sellRows.filter(function(x){return x.costEstimateAvailable;});
const estimatesComplete=pricedRows.length===sellRows.length;
const estimatedFees=pricedRows.reduce(function(sum,x){return sum+(Number(x.estimatedFeesUsd)||0);},0);
const estimatedSlippage=pricedRows.reduce(function(sum,x){return sum+(Number(x.estimatedSlippageUsd)||0);},0);
const grossRealized=sellRows.reduce(function(sum,x){return sum+(Number(x.grossPnl??x.pnl)||0);},0);
const realizedNet=estimatesComplete?sellRows.reduce(function(sum,x){return sum+(Number(x.netPnl??x.pnl)||0);},0):null;
const equity=a.equity;
const cards=[["MODE","PAPER"],["BOT",s.running?"RUNNING":"STOPPED"],["LOCK MINIMUM","60% verified"],["GROSS REALIZED P&L",money(grossRealized)],["EST. NETWORK + POOL FEES",money(estimatedFees)],["EST. SLIPPAGE",estimatesComplete?money(estimatedSlippage):"Liquidity not saved"],["EST. NET P&L",money(realizedNet)],["STARTING BALANCE",money(a.startingBalance)],["CASH",money(a.cashBalance)],["OPEN SLOTS",positions.length+" / 2"],["PAPER EQUITY",money(equity)]];
document.getElementById("lock85-summary").innerHTML=cards.map(function(x){return '<div class="lock85-card"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></div>';}).join("");
document.getElementById("lock85-positions").innerHTML=positions.length?positions.map(function(p){return '<tr><td>'+esc(p.symbol)+'</td><td>'+money(p.amountInvested)+'</td><td>'+price(p.entryPrice)+'</td><td>'+esc(p.entrySignal||"BUY")+'</td><td><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/'+encodeURIComponent(p.tokenAddress||"")+'">OPEN</a></td></tr>';}).join(""):'<tr><td colspan="5">No open paper positions.</td></tr>';
document.getElementById("lock85-history").innerHTML=history.length?history.slice(0,100).map(function(t){const pnl=Number(t.netPnl??t.pnl)||0;return '<tr><td>'+esc(new Date(t.exitTime||t.entryTime||t.timestamp||"").toLocaleString())+'</td><td>'+esc(t.symbol||"—")+'</td><td>'+esc(t.type)+'</td><td>'+money(t.amountInvested)+'</td><td>'+money(t.saleValue)+'</td><td>'+money(t.estimatedFeesUsd)+'</td><td>'+money(t.estimatedSlippageUsd)+'</td><td class="'+(pnl>=0?"lock85-positive":"lock85-negative")+'">'+money(t.netPnl??t.pnl)+'</td><td><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/'+encodeURIComponent(t.tokenAddress||"")+'">OPEN</a></td></tr>';}).join(""):'<tr><td colspan="9">No trade records yet.</td></tr>';
document.getElementById("lock85-status").textContent=s.error?"Bot error: "+s.error:"Updated "+new Date().toLocaleTimeString()+" · unverified locks remain rejected.";
}catch(error){document.getElementById("lock85-status").textContent="Dashboard feed unavailable: "+error.message;}
}
document.addEventListener("click",function(event){
const button=event.target.closest("[data-lock85]");if(button){fetch("/api/lock85/"+button.dataset.lock85,{method:"POST",headers:{"x-bot-control":"1"}}).then(load);return;}
if(event.target.closest("[data-lock85-refresh]"))load();
});
load();setInterval(load,15000);
})();
