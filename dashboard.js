const http = require("http");
const fs = require("fs");
const { startBot, stopBot, getBotStatus } = require("./bot");

const PORT = 3000;
const DATA_FILE = "./tradingData.json";

const server = http.createServer((req, res) => {
    if (req.url === "/api/start") {
  startBot();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ running: true }));
  return;
}

if (req.url === "/api/stop") {
  stopBot();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ running: false }));
  return;
}

if (req.url.startsWith("/api/status")) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ running: getBotStatus() }));
  return;
}
	if (req.url.startsWith("/api/data")) {
		try {
			const data = fs.readFileSync(DATA_FILE, "utf8");

			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store"
			});

			res.end(data);
		} catch (error) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Could not read trading data" }));
		}

		return;
	}

	res.writeHead(200, { "Content-Type": "text/html" });

	res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Solana One Coin Bot</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 25px; background: #080b12; color: #fff; font-family: Arial, sans-serif; }
.container { max-width: 1100px; margin: auto; }
h1 { margin-bottom: 5px; }
.subtitle { color: #8c96a8; margin-bottom: 30px; }
.status { display: inline-block; background: #123d2b; color: #4cff9a; padding: 8px 14px; border-radius: 20px; margin-bottom: 25px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; }
.card { background: #111722; border: 1px solid #222b3a; border-radius: 12px; padding: 20px; }
.label { color: #8792a5; font-size: 13px; text-transform: uppercase; margin-bottom: 8px; }
.value { font-size: 28px; font-weight: bold; }
.position { margin-top: 20px; }
.position h2 { margin-top: 0; }
.green { color: #4cff9a; }
.red { color: #ff5c72; }
.yellow { color: #ffd166; }
table { width: 100%; border-collapse: collapse; margin-top: 15px; }
th, td { text-align: left; padding: 12px; border-bottom: 1px solid #283141; font-size: 14px; }
th { color: #8792a5; }
@media (max-width: 600px) { body { padding: 15px; } .value { font-size: 22px; } table { font-size: 12px; } }
</style>
</head>
<body>
<div class="container">
	<h1>Solana One Coin Bot</h1>
	<div class="subtitle">Paper Trading Dashboard</div>
	<div class="status" id="botStatus">BOT OFFLINE</div>
<div style="margin: 12px 0 20px 0;">
  <button onclick="startBot()">START BOT</button>
  <button onclick="stopBot()">STOP BOT</button>
</div>
	<div class="grid">
		<div class="card"><div class="label">Starting Balance</div><div class="value" id="startingBalance">$0.00</div></div>
		<div class="card"><div class="label">Cash Balance</div><div class="value" id="cashBalance">$0.00</div></div>
		<div class="card"><div class="label">Active Position</div><div class="value" id="activePosition">NONE</div></div>
		<div class="card"><div class="label">Trades</div><div class="value" id="tradeCount">0</div></div>
	</div>
	<div class="card position"><h2>Current Position</h2><div id="positionData">Waiting for a trade...</div></div>
	<div class="card position"><h2>Trade History</h2><div style="overflow-x:auto;"><table><thead><tr><th>Type</th><th>Coin</th><th>Price</th><th>Amount</th><th>P/L</th></tr></thead><tbody id="history"></tbody></table></div></div>
</div>
<script>
async function startBot() {
  await fetch("/api/start");
  await updateBotStatus();
}

async function stopBot() {
  await fetch("/api/stop");
  await updateBotStatus();
}
async function updateBotStatus() {
  try {
    const response = await fetch("/api/status?t=" + Date.now());
    const data = await response.json();

    const status = document.getElementById("botStatus");

    if (data.running === true) {
      status.textContent = "BOT ONLINE";
      status.className = "status green";
    } else {
      status.textContent = "BOT OFFLINE";
      status.className = "status red";
    }
  } catch (error) {
    console.log("Status error:", error);
  }
}
async function updateBotStatus() {
  const response = await fetch("/api/status?t=" + Date.now());
  const data = await response.json();
  console.log("BOT STATUS FROM SERVER:", data);

  const status = document.getElementById("botStatus");

  if (data.running) {
    status.textContent = "BOT ONLINE";
  } else {
    status.textContent = "BOT OFFLINE";
  }
}

setInterval(updateBotStatus, 2000);
updateBotStatus();
function money(value) { return "$" + Number(value || 0).toFixed(2); }
function price(value) { const number = Number(value || 0); return number ? "$" + number.toFixed(8) : "-"; }

async function updateDashboard() {
	try {
		const response = await fetch("/api/data?t=" + Date.now());
		const data = await response.json();
		document.getElementById("startingBalance").textContent = money(data.startingBalance);
		document.getElementById("cashBalance").textContent = money(data.cashBalance);
		document.getElementById("tradeCount").textContent = (data.history || []).length;
		const position = data.position;

		if (position) {
			document.getElementById("activePosition").textContent = position.symbol || "ACTIVE";
			document.getElementById("activePosition").className = "value green";
			document.getElementById("positionData").innerHTML = "<strong>" + (position.symbol || "-") + "</strong><br><br>" + "Name: " + (position.name || "-") + "<br>" + "Entry Price: " + price(position.entryPrice) + "<br>" + "Amount Invested: " + money(position.amountInvested) + "<br>" + "Quantity: " + Number(position.quantity || 0).toFixed(4);
		} else {
			document.getElementById("activePosition").textContent = "NONE";
			document.getElementById("activePosition").className = "value yellow";
			document.getElementById("positionData").textContent = "Waiting for a trade...";
		}

		const rows = (data.history || []).slice().reverse().map(trade => {
			let pnl = "-";
			let pnlClass = "";
			if (trade.type === "SELL" && trade.pnl !== undefined) { const pnlNumber = Number(trade.pnl); pnl = money(pnlNumber); pnlClass = pnlNumber >= 0 ? "green" : "red"; }
			const tradePrice = trade.type === "SELL" ? trade.exitPrice : trade.entryPrice;
			const amount = trade.type === "SELL" ? trade.saleValue : trade.amountInvested;
return "<tr><td>" + (trade.type || "-") + "</td><td>" + (trade.symbol || "-") + "</td><td>" + price(tradePrice) + "</td><td>" + money(amount) + "</td><td class='" + pnlClass + "'>" + pnl + "</td></tr>";		}).join("");
		document.getElementById("history").innerHTML = rows;
	} catch (error) { console.log("Dashboard update error:", error); }
}

updateDashboard();
setInterval(updateDashboard, 3000);
</script>
</body>
</html>
	`);
});

server.listen(PORT, () => {
	console.log("Dashboard running at http://localhost:" + PORT);
});
