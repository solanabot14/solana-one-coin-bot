const http = require("http");
const fs = require("fs");
const { startBot, stopBot, getBotStatus } = require("./bot");
const { getTokenData } = require("./dexscreener");

const PORT = 3000;
const DATA_FILE = "./tradingData.json";

function readTradingData() {
	try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
	catch (_) { return { startingBalance: 100, cashBalance: 100, position: null, history: [] }; }
}

function groupCompletedTrades(history = []) {
	const groups = new Map();
	for (const trade of history) {
		if (!trade.entryTime) continue;
		const key = `${trade.tokenAddress || trade.symbol}-${trade.entryTime}`;
		if (!groups.has(key)) groups.set(key, {
			symbol: trade.symbol || "-", name: trade.name || "-",
			tokenAddress: trade.tokenAddress || "", entryTime: trade.entryTime,
			entryPrice: Number(trade.entryPrice || 0), amountInvested: 0,
			saleValue: 0, pnl: 0, exitTime: null, exitPrice: null, sells: []
		});
		const group = groups.get(key);
		if (trade.type === "BUY") group.amountInvested = Number(trade.amountInvested || 0);
		if (trade.type === "SELL") {
			group.saleValue += Number(trade.saleValue || 0);
			group.pnl += Number(trade.pnl || 0);
			group.exitTime = trade.exitTime || group.exitTime;
			group.exitPrice = Number(trade.exitPrice || 0);
			group.sells.push(trade);
		}
	}
	return [...groups.values()].filter(g => g.sells.length).map(g => ({
		...g, pnlPercent: g.amountInvested > 0 ? g.pnl / g.amountInvested * 100 : 0
	})).sort((a, b) => new Date(b.exitTime || b.entryTime) - new Date(a.exitTime || a.entryTime));
}

async function dashboardData() {
	const data = readTradingData();
	const completedTrades = groupCompletedTrades(data.history);
	let live = null;
	if (data.position) {
		const fresh = await getTokenData(data.position.tokenAddress);
		if (fresh) {
			const currentPrice = Number(fresh.priceUsd || 0);
			const entryPrice = Number(data.position.entryPrice || 0);
			const quantity = Number(data.position.quantity || 0);
			const amountInvested = Number(data.position.amountInvested || 0);
			const currentValue = quantity * currentPrice;
			const pnl = currentValue - amountInvested;
			const highestPrice = Number(data.position.highestPrice || entryPrice);
			live = { currentPrice, currentValue, pnl,
				pnlPercent: amountInvested > 0 ? pnl / amountInvested * 100 : 0,
				peakPercent: entryPrice > 0 ? (highestPrice - entryPrice) / entryPrice * 100 : 0,
				dropFromHigh: highestPrice > 0 ? (highestPrice - currentPrice) / highestPrice * 100 : 0,
				priceChange5m: fresh.priceChange5m, priceChange1h: fresh.priceChange1h,
				priceChange24h: fresh.priceChange24h, buys5m: fresh.buys5m, sells5m: fresh.sells5m,
				pairAddress: fresh.pairAddress };
		}
	}
	const grossProfit = completedTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
	const grossLoss = Math.abs(completedTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
	const winners = completedTrades.filter(t => t.pnl > 0).length;
	return { ...data, live, completedTrades, stats: {
		completedTrades: completedTrades.length, winners,
		losers: completedTrades.filter(t => t.pnl < 0).length,
		winRate: completedTrades.length ? winners / completedTrades.length * 100 : 0,
		netPnl: grossProfit - grossLoss, grossProfit, grossLoss,
		profitFactor: grossLoss ? grossProfit / grossLoss : 0
	} };
}

const page = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solana One Coin Bot</title><style>
*{box-sizing:border-box}body{margin:0;padding:22px;background:#080b12;color:#fff;font:14px Arial}.container{max-width:1200px;margin:auto}.header,.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.header{justify-content:space-between;margin-bottom:20px}h1{margin:0 0 5px}.subtitle,.label,th,.empty{color:#8792a5}.status{padding:9px 15px;border-radius:20px;background:#29151b;color:#ff5c72;font-weight:bold}.online{background:#123d2b;color:#4cff9a}button{border:0;border-radius:8px;padding:11px 18px;font-weight:bold;cursor:pointer}.start{background:#4cff9a}.stop{background:#ff5c72;color:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.card{background:#111722;border:1px solid #222b3a;border-radius:12px;padding:18px}.section{margin-top:18px}.label{text-transform:uppercase;font-size:12px;margin-bottom:7px}.value{font-size:25px;font-weight:bold}.green{color:#4cff9a}.red{color:#ff5c72}.metric{background:#0b1018;border-radius:9px;padding:13px}.metric-label{color:#8792a5;font-size:11px;text-transform:uppercase;margin-bottom:6px}.metric-value{font-size:18px;font-weight:bold}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px;border-bottom:1px solid #283141;white-space:nowrap}.small-link{color:#8fa7ff}@media(max-width:600px){body{padding:14px}.value{font-size:21px}}
</style></head><body><div class="container"><div class="header"><div><h1>Solana One Coin Bot</h1><div class="subtitle">Strategy V2 • Paper Trading</div></div><div id="status" class="status">BOT OFFLINE</div></div><div class="controls"><button class="start" onclick="call('/api/start')">START BOT</button><button class="stop" onclick="call('/api/stop')">STOP BOT</button></div><div class="grid"><div class="card"><div class="label">Starting Balance</div><div class="value" id="starting">$0.00</div></div><div class="card"><div class="label">Cash</div><div class="value" id="cash">$0.00</div></div><div class="card"><div class="label">Equity</div><div class="value" id="equity">$0.00</div></div><div class="card"><div class="label">Total P/L</div><div class="value" id="pnl">$0.00</div></div><div class="card"><div class="label">Completed Positions</div><div class="value" id="count">0</div></div><div class="card"><div class="label">Win Rate</div><div class="value" id="winrate">0%</div></div></div><div class="card section"><h2>Live Trade</h2><div id="live" class="empty">Waiting for a trade...</div></div><div class="card section"><h2>Performance</h2><div class="grid"><div class="metric"><div class="metric-label">Winners</div><div class="metric-value green" id="winners">0</div></div><div class="metric"><div class="metric-label">Losers</div><div class="metric-value red" id="losers">0</div></div><div class="metric"><div class="metric-label">Gross Profit</div><div class="metric-value green" id="profit">$0.00</div></div><div class="metric"><div class="metric-label">Gross Loss</div><div class="metric-value red" id="loss">$0.00</div></div><div class="metric"><div class="metric-label">Net P/L</div><div class="metric-value" id="net">$0.00</div></div><div class="metric"><div class="metric-label">Profit Factor</div><div class="metric-value" id="factor">0.00</div></div></div></div><div class="card section"><h2>Completed Positions</h2><div style="overflow-x:auto"><table><thead><tr><th>Coin</th><th>Entry</th><th>Exit</th><th>Invested</th><th>P/L</th><th>Return</th><th>Chart</th></tr></thead><tbody id="history"></tbody></table></div></div></div><script>
const $=id=>document.getElementById(id),money=x=>'$'+Number(x||0).toFixed(2),price=x=>Number(x||0)?'$'+Number(x).toFixed(8):'-',pct=x=>Number(x||0).toFixed(2)+'%',cls=x=>Number(x||0)>=0?'green':'red';
async function call(url){await fetch(url);status();data()}async function status(){try{const d=await fetch('/api/status?t='+Date.now()).then(r=>r.json());$('status').textContent=d.running?'BOT ONLINE':'BOT OFFLINE';$('status').className='status'+(d.running?' online':'')}catch(e){}}
async function data(){try{const d=await fetch('/api/data?t='+Date.now()).then(r=>r.json()),s=d.stats||{},l=d.live,cash=Number(d.cashBalance||0),equity=cash+(l?Number(l.currentValue||0):0),start=Number(d.startingBalance||0),total=equity-start;[['starting',money(start)],['cash',money(cash)],['equity',money(equity)],['pnl',money(total)],['count',s.completedTrades||0],['winrate',pct(s.winRate)],['winners',s.winners||0],['losers',s.losers||0],['profit',money(s.grossProfit)],['loss','-'+money(s.grossLoss)],['net',money(s.netPnl)],['factor',Number(s.profitFactor||0).toFixed(2)]].forEach(([i,v])=>$(i).textContent=v);$('pnl').className='value '+cls(total);$('net').className='metric-value '+cls(s.netPnl);$('live').innerHTML=d.position&&l?'<b>'+ (d.position.symbol||'-')+'</b><div class="grid"><div class="metric">Current Price<br><strong>'+price(l.currentPrice)+'</strong></div><div class="metric">Current Value<br><strong>'+money(l.currentValue)+'</strong></div><div class="metric">Live P/L<br><strong class="'+cls(l.pnl)+'">'+money(l.pnl)+' ('+pct(l.pnlPercent)+')</strong></div><div class="metric">Momentum 5m<br><strong>'+pct(l.priceChange5m)+'</strong></div></div>':'<div class="empty">Waiting for a trade...</div>';$('history').innerHTML=(d.completedTrades||[]).map(t=>'<tr><td><strong>'+(t.symbol||'-')+'</strong></td><td>'+price(t.entryPrice)+'</td><td>'+price(t.exitPrice)+'</td><td>'+money(t.amountInvested)+'</td><td class="'+cls(t.pnl)+'">'+money(t.pnl)+'</td><td class="'+cls(t.pnl)+'">'+pct(t.pnlPercent)+'</td><td><a class="small-link" target="_blank" href="https://dexscreener.com/solana/'+encodeURIComponent(t.tokenAddress||'')+'">DexScreener</a></td></tr>').join('')||'<tr><td colspan="7">No completed positions yet.</td></tr>'}catch(e){console.log('Dashboard update error:',e)}}status();data();setInterval(status,2000);setInterval(data,5000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
	try {
		if (req.url === "/api/start") { startBot(); return json(res, { running: true }); }
		if (req.url === "/api/stop") { stopBot(); return json(res, { running: false }); }
		if (req.url.startsWith("/api/status")) return json(res, { running: getBotStatus() });
		if (req.url.startsWith("/api/data")) return json(res, await dashboardData());
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page);
	} catch (_) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Could not read dashboard data" })); }
});
function json(res, value) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
server.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
