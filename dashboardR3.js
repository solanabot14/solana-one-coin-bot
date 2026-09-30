require("dotenv").config();
const http = require("node:http");
const bot = require("./botR3");
const trader = require("./paperTraderR3");

function getConfig(env = process.env) {
  const railway = !!env.RAILWAY_ENVIRONMENT_ID;
  const host = env.HOST || (railway ? "0.0.0.0" : "127.0.0.1");
  const port = Number(env.PORT || 3000);
  return { host, port };
}

function completedPositions(history) {
  const buys = new Map();
  const rows = [];
  for (const trade of history || []) {
    if (trade.type === "BUY") buys.set(trade.positionId, trade);
    if (trade.type !== "SELL") continue;
    const buy = buys.get(trade.positionId);
    rows.push({
      symbol: trade.symbol,
      entryTime: trade.entryTime || buy?.entryTime || null,
      exitTime: trade.exitTime || null,
      entryPrice: Number(trade.entryPrice || buy?.entryPrice || 0),
      exitPrice: Number(trade.exitPrice || 0),
      highestPrice: Number(trade.highestPrice || buy?.highestPrice || 0),
      returnPercent: Number(trade.pnlPercent || 0),
      pnl: Number(trade.pnl || 0),
      reason: trade.reason || "UNKNOWN",
      strategyVersion: trade.strategyVersion || buy?.strategyVersion || "R3-EARLY-RUNNER"
    });
  }
  return rows.reverse();
}

function statePayload() {
  const p = trader.getPortfolio();
  const completed = completedPositions(p.history);
  const realized = completed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const wins = completed.filter(t => t.returnPercent > 0).length;
  const losses = completed.filter(t => t.returnPercent < 0).length;
  return {
    botOnline: bot.getBotStatus(),
    strategy: "R3 Early Runner",
    startingBalance: p.startingBalance,
    cashBalance: p.cashBalance,
    realizedPnl: realized,
    completed: completed.length,
    wins,
    losses,
    winRate: completed.length ? (wins / completed.length) * 100 : 0,
    position: p.position,
    history: completed.slice(0, 100)
  };
}

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>R3 Early Runner</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:22px;background:#080b12;color:#fff;font:14px Arial}
.container{max-width:1200px;margin:auto}.header,.controls{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
h1{margin:0}.muted{color:#8b95a7}.status{padding:8px 14px;border-radius:20px;background:#29151b;color:#ff657a;font-weight:bold}
.online{background:#123d2b;color:#4cff9a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:18px}
.card{background:#111722;border:1px solid #222b3a;border-radius:12px;padding:18px}.label{font-size:11px;text-transform:uppercase;color:#8b95a7;margin-bottom:7px}
.value{font-size:24px;font-weight:bold}.section{margin-top:18px}.green{color:#4cff9a}.red{color:#ff657a}
button{border:0;border-radius:8px;padding:10px 16px;font-weight:bold;cursor:pointer}.start{background:#4cff9a}.stop{background:#ff657a;color:#fff}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #283141;white-space:nowrap}
</style>
</head>
<body><div class="container">
<div class="header"><div><h1>R3 Early Runner</h1><div class="muted">Experimental paper strategy • V3.1R2 preserved on main</div></div><div id="status" class="status">OFFLINE</div></div>
<div class="controls" style="margin-top:16px"><div><button class="start" onclick="action('/start')">START R3</button> <button class="stop" onclick="action('/stop')">STOP R3</button></div><div class="muted">Separate paper account: tradingDataR3.json</div></div>
<div class="grid">
<div class="card"><div class="label">Starting Balance</div><div class="value" id="starting">$100.00</div></div>
<div class="card"><div class="label">Cash</div><div class="value" id="cash">$100.00</div></div>
<div class="card"><div class="label">Realized P/L</div><div class="value" id="pnl">$0.00</div></div>
<div class="card"><div class="label">Completed</div><div class="value" id="count">0</div></div>
<div class="card"><div class="label">Win Rate</div><div class="value" id="winrate">0%</div></div>
</div>
<div class="card section"><h2>Live Trade</h2><div id="live" class="muted">Waiting for an R3 trade...</div></div>
<div class="card section"><h2>Completed R3 Trades</h2><div style="overflow-x:auto"><table><thead><tr><th>Coin</th><th>Return</th><th>P/L</th><th>Max Gain</th><th>Exit</th></tr></thead><tbody id="history"><tr><td colspan="5">No completed R3 trades yet.</td></tr></tbody></table></div></div>
</div>
<script>
const money=n=>'$'+Number(n||0).toFixed(2);
const pct=n=>Number(n||0).toFixed(2)+'%';
async function action(path){await fetch(path,{method:'POST'});await refresh();}
async function refresh(){
  const d=await fetch('/api/state').then(r=>r.json());
  const s=document.getElementById('status');s.textContent=d.botOnline?'R3 ONLINE':'R3 OFFLINE';s.className='status'+(d.botOnline?' online':'');
  starting.textContent=money(d.startingBalance);cash.textContent=money(d.cashBalance);pnl.textContent=money(d.realizedPnl);
  pnl.className='value '+(d.realizedPnl>=0?'green':'red');count.textContent=d.completed;winrate.textContent=pct(d.winRate);
  if(d.position){
    const p=d.position;live.innerHTML='<b>'+p.symbol+'</b> • Entry '+Number(p.entryPrice).toPrecision(6)+' • Highest '+Number(p.highestPrice||p.entryPrice).toPrecision(6)+' • Score '+(p.entryScore??'—')+' • '+(p.entrySignal||'');
    live.className='';
  }else{live.textContent='Waiting for an R3 trade...';live.className='muted';}
  if(d.history.length){
    history.innerHTML=d.history.map(t=>{
      const mfe=t.entryPrice>0?((t.highestPrice-t.entryPrice)/t.entryPrice*100):0;
      return '<tr><td>'+t.symbol+'</td><td class="'+(t.returnPercent>=0?'green':'red')+'">'+pct(t.returnPercent)+'</td><td>'+money(t.pnl)+'</td><td>'+pct(mfe)+'</td><td>'+t.reason+'</td></tr>';
    }).join('');
  }
}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const { host, port } = getConfig();

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok");
  }
  if (req.method === "GET" && req.url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(statePayload()));
  }
  if (req.method === "POST" && req.url === "/start") {
    bot.startBot(); res.writeHead(204); return res.end();
  }
  if (req.method === "POST" && req.url === "/stop") {
    bot.stopBot(); res.writeHead(204); return res.end();
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page);
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(port, host, () => {
  console.log(`R3 DASHBOARD LISTENING | http://${host}:${port}`);
  bot.startBot();
});
