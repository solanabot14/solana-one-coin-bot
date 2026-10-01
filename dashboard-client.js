const $ = id => document.getElementById(id);

const money = value => value == null ? "—" : "$" + Number(value || 0).toFixed(2);
const price = value => Number(value) > 0 ? "$" + Number(value).toFixed(8) : "—";
const pct = value => value == null ? "—" : Number(value || 0).toFixed(2) + "%";
const entryRatio = trade => {
	const value = trade.entryBuyRatio ?? trade.entryBuyRatio5m;
	return pct(value == null ? null : Number(value) * 100);
};
const number = value => value == null ? "—" : Number(value).toLocaleString();
const cls = value => value == null ? "" : Number(value) >= 0 ? "green" : "red";
const escapeHtml = value => String(value ?? "-").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);

function duration(ms) {
	if (!Number.isFinite(Number(ms))) return "—";
	let seconds = Math.max(0, Math.floor(Number(ms) / 1000));
	const days = Math.floor(seconds / 86400); seconds %= 86400;
	const hours = Math.floor(seconds / 3600); seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function dexLink(position, live) {
	const address = live?.pairAddress || position?.pairAddress || position?.tokenAddress;
	return address ? "https://dexscreener.com/solana/" + encodeURIComponent(address) : "";
}

async function request(url, options = {}) {
	const response = await fetch(url, {...options, signal: AbortSignal.timeout(15000)});
	if (!response.ok) throw new Error("Dashboard request failed (" + response.status + ")");
	return response.json();
}

function renderLiveTrade(d) {
	const slots = Array.isArray(d.livePositions) ? d.livePositions : [];
	$("slots").textContent = (d.openSlots ?? slots.length) + " / 3";
	if (!slots.length) { $("live").textContent = "Waiting for trades..."; return; }
	$("live").innerHTML = slots.map((slot,index) => {
		const position=slot.position, live=slot.live;
		if(!live) return `<div class="metric"><div class="live-title"><span class="coin-name">Slot ${index+1}: ${escapeHtml(position.symbol)}</span></div><div>Price unavailable. Position remains open.</div></div>`;
		const chart=dexLink(position,live), reasons=Array.isArray(position.entryReasons)&&position.entryReasons.length?position.entryReasons.map(escapeHtml).join(" • "):"No entry reasons recorded.";
		const tp1=position.firstTakeProfitDone?"DONE":"Waiting +15%", tp2=position.secondTakeProfitDone?"DONE":"Waiting +30%";
		return `<div class="metric" style="margin-bottom:16px">
		<div class="live-title"><span class="coin-name">Slot ${index+1}: ${escapeHtml(position.symbol)}</span>
		<span class="badge">${escapeHtml(position.strategyVersion||"V3.1-3Slot")}</span><span class="badge">Score ${escapeHtml(position.entryScore??"—")}</span>
		${chart?`<a class="small-link" href="${chart}" target="_blank" rel="noopener noreferrer">DexScreener</a>`:""}</div>
		<div class="grid">
		<div class="metric"><div class="metric-label">Invested</div><div class="metric-value">${money(position.amountInvested)}</div></div>
		<div class="metric"><div class="metric-label">Entry</div><div class="metric-value">${price(position.entryPrice)}</div></div>
		<div class="metric"><div class="metric-label">Current</div><div class="metric-value">${price(live.currentPrice)}</div></div>
		<div class="metric"><div class="metric-label">Live P/L</div><div class="metric-value ${cls(live.pnl)}">${money(live.pnl)} (${pct(live.pnlPercent)})</div></div>
		<div class="metric"><div class="metric-label">Max Gain</div><div class="metric-value ${cls(live.maxGainPercent)}">${pct(live.maxGainPercent)}</div></div>
		<div class="metric"><div class="metric-label">Time</div><div class="metric-value">${duration(live.holdTimeMs)}</div></div>
		<div class="metric"><div class="metric-label">5m / 1h</div><div class="metric-value">${pct(live.priceChange5m)} / ${pct(live.priceChange1h)}</div></div>
		<div class="metric"><div class="metric-label">Buy Ratio</div><div class="metric-value">${pct(Number(live.buyRatio5m||0)*100)}</div></div>
		<div class="metric"><div class="metric-label">TP1 / TP2</div><div class="metric-value">${tp1} / ${tp2}</div></div></div>
		<div class="reasons"><strong>Entry:</strong> 5m ${pct(position.entryPriceChange5m)} | 1h ${pct(position.entryPriceChange1h)} | Transactions ${number(position.entryTransactions5m)}<br><strong>Reasons:</strong> ${reasons}</div></div>`;
	}).join("");
}

function renderScoreStats(d) {
	const rows = Array.isArray(d.scoreStats) ? d.scoreStats : [];
	$("scoreStats").innerHTML = rows.map(row => `<tr>
		<td><strong>${escapeHtml(row.score)}</strong></td><td>${row.trades}</td><td class="green">${row.winners}</td><td class="red">${row.losers}</td>
		<td>${pct(row.winRate)}</td><td class="${cls(row.averageReturn)}">${pct(row.averageReturn)}</td>
		<td class="${cls(row.averageMaxGain)}">${pct(row.averageMaxGain)}</td><td class="${cls(row.netPnl)}">${money(row.netPnl)}</td></tr>`).join("") || `<tr><td colspan="8">No V3.1 trades yet.</td></tr>`;
}

function renderExitReasons(d) {
	const entries = Object.entries(d.exitReasonCounts || {});
	$("exitReasons").innerHTML = entries.map(([reason, count]) => `<div class="metric"><div class="metric-label">${escapeHtml(reason)}</div><div class="metric-value">${count}</div></div>`).join("") || `<div class="metric">No completed positions yet.</div>`;
}

function renderHistory(d) {
	$("history").innerHTML = d.completedTrades.map(t => {
		const reason = Array.isArray(t.exitReasons) ? t.exitReasons.join(" / ") : "—";
		const chartAddress = t.pairAddress || t.tokenAddress || "";
		return `<tr><td><strong>${escapeHtml(t.symbol)}</strong></td><td>${escapeHtml(t.entryScore ?? "—")}</td>
			<td>${pct(t.entryPriceChange5m)}</td><td>${pct(t.entryPriceChange1h)}</td><td>${entryRatio(t)}</td>
			<td>${price(t.entryPrice)}</td><td>${price(t.exitPrice)}</td><td>${money(t.amountInvested)}</td>
			<td>${money(t.tp1SaleValue)}</td><td>${money(t.tp2SaleValue)}</td><td>${money(t.trailingSaleValue)}</td><td>${money(t.otherExitSaleValue)}</td><td>${money(t.saleValue)}</td>
			<td class="${cls(t.pnl)}">${money(t.pnl)}</td><td class="${cls(t.pnlPercent)}">${pct(t.pnlPercent)}</td>
			<td class="${cls(t.maxGainPercent)}">${pct(t.maxGainPercent)}</td><td>${duration(t.holdTimeMs)}</td><td>${escapeHtml(reason)}</td>
			<td><a class="small-link" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/${encodeURIComponent(chartAddress)}">DexScreener</a></td></tr>`;
	}).join("") || `<tr><td colspan="19">No completed positions yet.</td></tr>`;
}

function renderData(d) {
	const s = d.stats;
	const values = {starting:money(d.startingBalance), cash:money(d.cashBalance), equity:money(d.equity), pnl:money(d.totalPnl), count:s.completedTrades, winrate:pct(s.winRate), winners:s.winners, losers:s.losers, profit:money(s.grossProfit), loss:"-" + money(s.grossLoss), net:money(s.netPnl), factor:s.profitFactorLabel, avgWinner:pct(s.averageWinnerPercent), avgLoser:pct(s.averageLoserPercent), avgHold:duration(s.averageHoldTimeMs), avgMaxGain:pct(s.averageMaxGainPercent)};
	for (const [id, value] of Object.entries(values)) $(id).textContent = value;
	$("pnl").className = "value " + cls(d.totalPnl);
	$("net").className = "metric-value " + cls(s.netPnl);
	renderLiveTrade(d); renderScoreStats(d); renderExitReasons(d); renderHistory(d);
}

async function refreshStatus() {
	try {
		const d = await request("/api/status");
		$("status").textContent = d.running ? "BOT ONLINE" : "BOT OFFLINE";
		$("status").className = "status" + (d.running ? " online" : "");
		if (d.error) $("notice").textContent = "Trading paused after an error. Check server logs before restarting.";
	} catch (error) { $("status").textContent = "CONNECTION UNAVAILABLE"; $("status").className = "status"; }
}

async function refreshData() {
	try { renderData(await request("/api/data")); }
	catch (error) { $("equity").textContent = "Unavailable"; $("pnl").textContent = "Unavailable"; $("live").textContent = "Account update unavailable. Other displayed figures may be out of date."; }
}

async function control(action) {
	$("startButton").disabled = true; $("stopButton").disabled = true;
	try {
		await request("/api/" + action, {method:"POST", headers:{"X-Bot-Control":"1"}});
		$("notice").textContent = action === "stop" ? "Stopped. Open positions remain saved; automatic exits are paused." : "Running. Automatic exits are enabled.";
		await refreshStatus();
	} catch (error) { $("notice").textContent = error.message; }
	finally { $("startButton").disabled = false; $("stopButton").disabled = false; }
}

$("startButton").addEventListener("click", () => control("start"));
$("stopButton").addEventListener("click", () => control("stop"));

async function pollStatus() { await refreshStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); setTimeout(pollData, 5000); }
pollStatus();
pollData();
