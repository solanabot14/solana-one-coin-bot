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

function renderLiveTrade(d, targetId = "live", slotsId = "slots", maxSlots = 3) {
	const slots = Array.isArray(d.livePositions) ? d.livePositions : [];
	$(slotsId).textContent = (d.openSlots ?? slots.length) + " / " + maxSlots;
	if (!slots.length) { $(targetId).textContent = "No open positions."; return; }
	$(targetId).innerHTML = slots.map((slot,index) => {
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

function renderHistory(d, targetId = "history") {
	$(targetId).innerHTML = d.completedTrades.map(t => {
		const reason = Array.isArray(t.exitReasons) ? t.exitReasons.join(" / ") : "—";
		const chartAddress = t.pairAddress || t.tokenAddress || "";
		const entryReasons = Array.isArray(t.entryReasons) ? t.entryReasons.join(" • ") : "—";
		return `<tr><td><strong>${escapeHtml(t.symbol)}</strong></td>
			<td>${money(t.amountInvested)}</td><td>${money(t.saleValue)}</td>
			<td class="${cls(t.pnl)}"><strong>${money(t.pnl)}</strong></td><td class="${cls(t.pnlPercent)}">${pct(t.pnlPercent)}</td>
			<td>${escapeHtml(t.entryScore ?? "—")}</td><td>${pct(t.entryPriceChange5m)}</td><td>${pct(t.entryPriceChange1h)}</td><td>${entryRatio(t)}</td>
			<td>${number(t.entryTransactions5m)}</td><td>${money(t.entryLiquidityUsd)}</td><td>${money(t.entryVolume24h)}</td><td>${pct(t.entryPriceChange24h)}</td>
			<td>${escapeHtml(t.entrySignal || "—")}</td><td>${escapeHtml(entryReasons)}</td>
			<td>${price(t.entryPrice)}</td><td>${price(t.exitPrice)}</td>
			<td>${money(t.tp1SaleValue)}</td><td>${money(t.tp2SaleValue)}</td><td>${money(t.trailingSaleValue)}</td><td>${money(t.otherExitSaleValue)}</td>
			<td class="${cls(t.maxGainPercent)}">${pct(t.maxGainPercent)}</td><td>${duration(t.holdTimeMs)}</td><td>${escapeHtml(reason)}</td>
			<td><a class="small-link" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/${encodeURIComponent(chartAddress)}">DexScreener</a></td></tr>`;
	}).join("") || `<tr><td colspan="25">No completed positions yet.</td></tr>`;
}

function renderCandleBreakoutData(d, state = {}, error = null) {
	if (error) {
		$("candleStatus").textContent = "FEED UNAVAILABLE";
		$("candleStatus").className = "metric-value red";
		$("candleOpen").textContent = error;
		$("candleHistory").innerHTML = '<tr><td colspan="9">' + escapeHtml(error) + "</td></tr>";
		return;
	}
	if (!d) { $("candleStatus").textContent = "CONNECTING"; return; }
	const stats = d.stats || {};
	$("candleStatus").textContent = state.running ? "RUNNING · PAPER ONLY" : "STOPPED · PAPER ONLY";
	$("candleStatus").className = "metric-value " + (state.running ? "green" : "");
	$("candleStarting").textContent = money(d.startingBalance);
	$("candleCash").textContent = money(d.cashBalance);
	$("candleEquity").textContent = money(d.equity);
	$("candlePnl").textContent = money(d.totalPnl);
	$("candlePnl").className = "metric-value " + cls(d.totalPnl);
	$("candleReturn").textContent = pct(d.totalPnlPercent);
	$("candleReturn").className = "metric-value " + cls(d.totalPnlPercent);
	$("candleCount").textContent = number(stats.completedTrades || 0);
	$("candleWinRate").textContent = pct(stats.winRate || 0);
	const slots = Array.isArray(d.livePositions) ? d.livePositions : [];
	$("candleSlots").textContent = (d.openSlots || slots.length) + " / " + (d.maxSlots || 3);
	$("candleScanned").textContent = number(state.lockConfirmed || 0) + " / " + number(state.candleCandidates || 0);
	$("candleRejected").textContent = number(state.lockRejected || 0);
	$("candleFeed").textContent = state.candleSource && state.candleInterval
		? state.candleSource + " · " + state.candleInterval + " · LP lock ≥" + number(state.minimumLockedPercent || 90) + "%"
		: "Waiting for closed candle data";
	if (!slots.length) $("candleOpen").textContent = "No open positions.";
	else $("candleOpen").innerHTML = slots.map((slot, index) => {
		const position = slot.position || {}, live = slot.live || {};
		const chart = dexLink(position, live);
		return '<div class="metric" style="margin-bottom:12px"><div class="live-title"><span class="coin-name">Slot ' + (index + 1) + ': ' + escapeHtml(position.symbol) + '</span><span class="badge">CANDLE BREAKOUT V1.1</span>' +
			(chart ? '<a class="small-link" href="' + chart + '" target="_blank" rel="noopener noreferrer">DexScreener</a>' : '') +
			'</div><div class="grid"><div class="metric"><div class="metric-label">Invested</div><div class="metric-value">' + money(position.amountInvested) +
			'</div></div><div class="metric"><div class="metric-label">Entry</div><div class="metric-value">' + price(position.entryPrice) +
			'</div></div><div class="metric"><div class="metric-label">Current</div><div class="metric-value">' + price(live.currentPrice) +
			'</div></div><div class="metric"><div class="metric-label">Live P/L</div><div class="metric-value ' + cls(live.pnl) + '">' + money(live.pnl) + ' (' + pct(live.pnlPercent) +
			')</div></div></div></div>';
	}).join("");
	const trades = Array.isArray(d.completedTrades) ? d.completedTrades : [];
	$("candleHistory").innerHTML = trades.map(t => {
		const reasons = Array.isArray(t.exitReasons) ? t.exitReasons.join(" / ") : (t.reason || "—");
		const chart = dexLink(t, null);
		return '<tr><td><strong>' + escapeHtml(t.symbol) + '</strong></td><td>' + money(t.amountInvested) +
			'</td><td>' + money(t.saleValue) + '</td><td class="' + cls(t.pnl) + '">' + money(t.pnl) +
			'</td><td class="' + cls(t.pnlPercent) + '">' + pct(t.pnlPercent) + '</td><td>' + price(t.entryPrice) +
			'</td><td>' + price(t.exitPrice) + '</td><td>' + escapeHtml(reasons) + '</td><td>' +
			(chart ? '<a class="small-link" href="' + chart + '" target="_blank" rel="noopener noreferrer">Chart</a>' : "—") + '</td></tr>';
	}).join("") || '<tr><td colspan="9">No completed Candle Breakout transactions yet.</td></tr>';
}

function renderData(d) {
	const response = d;
	d = response.v31 || response;
	const s = d.stats;
	const values = {starting:money(d.startingBalance), cash:money(d.cashBalance), equity:d.equity == null ? "Unavailable" : money(d.equity), pnl:d.totalPnl == null ? "Unavailable" : money(d.totalPnl), count:s.completedTrades, winrate:pct(s.winRate), winners:s.winners, losers:s.losers, profit:money(s.grossProfit), loss:"-" + money(s.grossLoss), net:money(s.netPnl), factor:s.profitFactorLabel, avgWinner:pct(s.averageWinnerPercent), avgLoser:pct(s.averageLoserPercent), avgHold:duration(s.averageHoldTimeMs), avgMaxGain:pct(s.averageMaxGainPercent)};
	for (const [id, value] of Object.entries(values)) $(id).textContent = value;
	$("pnlPct").textContent = pct(d.totalPnlPercent);
	$("pnl").className = "value " + cls(d.totalPnl);
	$("pnlPct").className = "value " + cls(d.totalPnlPercent);
	$("net").className = "metric-value " + cls(s.netPnl);
	renderLiveTrade(d); renderScoreStats(d); renderExitReasons(d); renderHistory(d);
	renderCandleBreakoutData(response.candleBreakout, response.candleBreakoutStatus, response.candleBreakoutError);
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




async function refreshSwarm() {
 try { const d=await request("/api/swarm"); const slots=Array.isArray(d.slots)?d.slots:[]; $("swarmStatus").textContent=d.running?"RUNNING":"STOPPED"; $("swarmEquity").textContent=money(d.totalCapital); $("swarmPnl").textContent=money(d.totalPnl); $("swarmPnl").className="metric-value "+cls(d.totalPnl); $("swarmOpen").textContent=slots.filter(s=>s.position).length+" / 5"; $("swarmSlots").innerHTML=slots.slice(0,5).map(s=>"<tr><td>"+escapeHtml(s.id)+"</td><td>"+money(s.cashBalance)+"</td><td>"+escapeHtml(s.position?.symbol||"—")+"</td><td>"+money(s.position?.amountInvested||0)+"</td><td>"+number(s.completedTrades)+"</td><td>"+number(s.winners)+"</td><td>"+number(s.losers)+"</td></tr>").join("")||"<tr><td colspan=\"7\">No slots.</td></tr>"; } catch (_) {}
}
async function pollStatus() { await refreshStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); await refreshSwarm(); setTimeout(pollData, 5000); }
pollStatus();
pollData();

