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

function renderLiveTrade(d, targetId = "live", slotsId = "slots", maxSlots = 2) {
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

function renderLabData(d, error = null) {
	if (error || !d) {
		$("labStatus").textContent = error ? "FEED UNAVAILABLE" : "CONNECTING";
		$("labStatus").className = "metric-value " + (error ? "red" : "");
		$("labHistory").innerHTML = '<tr><td colspan="6">' + escapeHtml(error || "Waiting for lab data…") + "</td></tr>";
		return;
	}
	$("labStatus").textContent = d.running ? "RUNNING · PAPER ONLY" : "STOPPED · PAPER ONLY";
	$("labStatus").className = "metric-value " + (d.running ? "green" : "");
	$("labStarting").textContent = money(d.startingBalance);
	$("labCash").textContent = money(d.cashBalance);
	$("labEquity").textContent = d.equity == null ? "Unavailable" : money(d.equity);
	$("labPnl").textContent = d.totalPnl == null ? "Unavailable" : money(d.totalPnl);
	$("labPnl").className = "metric-value " + cls(d.totalPnl);
	$("labReturn").textContent = pct(d.totalPnlPercent);
	$("labReturn").className = "metric-value " + cls(d.totalPnlPercent);
	$("labCount").textContent = number(d.completedTrades || 0);
	$("labWinRate").textContent = pct(d.winRate || 0);
	$("labSlots").textContent = (d.openSlots || 0) + " / " + (d.maxSlots || 2);
	$("labProfitFactor").textContent = d.profitFactor || "—";
	const positions = Array.isArray(d.openPositions) ? d.openPositions : [];
	$("labOpenCount").textContent = positions.length + " / " + (d.maxSlots || 2);
	$("labOpenPositions").innerHTML = positions.map((p, index) => {
		const address = p.tokenAddress || p.pairAddress || "";
		const shortAddress = address ? address.slice(0, 5) + "…" + address.slice(-5) : "—";
		const chart = dexLink(p, p);
		return '<article class="card lab-open-card"><div class="lab-position-header"><div><span class="badge">SLOT ' + (index + 1) + '</span> <span class="coin-name">' + escapeHtml(p.symbol) + '</span>' +
			'<div class="muted" title="' + escapeHtml(address) + '">Mint: ' + escapeHtml(shortAddress) + '</div></div>' +
			(chart ? '<a class="small-link" href="' + chart + '" target="_blank" rel="noopener noreferrer">View chart ↗</a>' : '') + '</div>' +
			'<div class="lab-position-pnl ' + cls(p.pnl) + '">' + (p.currentPrice == null ? 'Live P/L unavailable' : money(p.pnl)) +
			'<span class="muted" style="font-size:14px"> · ' + pct(p.pnlPercent) + '</span></div>' +
			'<div class="lab-position-details">' +
			'<div class="metric"><div class="metric-label">Invested</div><div class="metric-value">' + money(p.amountInvested) + '</div></div>' +
			'<div class="metric"><div class="metric-label">Entry</div><div class="metric-value">' + price(p.entryPrice) + '</div></div>' +
			'<div class="metric"><div class="metric-label">Live Price</div><div class="metric-value">' + price(p.currentPrice) + '</div></div>' +
			'<div class="metric"><div class="metric-label">Max Gain</div><div class="metric-value ' + cls(p.maxGainPercent) + '">' + pct(p.maxGainPercent) + '</div></div>' +
			'<div class="metric"><div class="metric-label">Time Open</div><div class="metric-value">' + duration(p.holdTimeMs) + '</div></div></div></article>';
	}).join("") || '<div class="card empty">No open lab positions.</div>';
	const trades = Array.isArray(d.recentTrades) ? d.recentTrades : [];
	$("labHistory").innerHTML = trades.map(t => {
		const reasons = Array.isArray(t.exitReasons) ? t.exitReasons.join(" / ") : "—";
		return '<tr><td><strong>' + escapeHtml(t.symbol) + '</strong></td><td>' + money(t.amountInvested) +
			'</td><td>' + money(t.saleValue) + '</td><td class="' + cls(t.pnl) + '">' + money(t.pnl) +
			'</td><td class="' + cls(t.pnlPercent) + '">' + pct(t.pnlPercent) + '</td><td>' + escapeHtml(reasons) + '</td></tr>';
	}).join("") || '<tr><td colspan="6">No completed lab transactions yet.</td></tr>';
}

function renderQuickPosition(position, live, index, slotLabel = null) {
	position = position || {};
	live = live || {};
	const chart = dexLink(position, live);
	const label = slotLabel || ("Slot " + (index + 1));
	return '<div class="quick-position-row"><div><strong>' + escapeHtml(label) + ': ' + escapeHtml(position.symbol || "Unknown coin") +
		'</strong><div class="muted">' + (live.currentPrice != null ? price(live.currentPrice) : "Price unavailable") +
		' · ' + pct(live.pnlPercent) + '</div></div><div class="quick-position-result ' + cls(live.pnl) + '">' +
		money(live.pnl) + (chart ? '<br><a class="small-link" href="' + chart + '" target="_blank" rel="noopener noreferrer">Chart</a>' : "") +
		'</div></div>';
}

function renderQuickOverview(v31, lab, labError = null, candle = null, candleStatus = null, candleError = null) {
	$("quickV31Equity").textContent = v31.equity == null ? "Unavailable" : money(v31.equity);
	$("quickV31Pnl").textContent = v31.totalPnl == null ? "Unavailable" : money(v31.totalPnl);
	$("quickV31Pnl").className = "quick-stat-value " + cls(v31.totalPnl);
	$("quickV31Return").textContent = pct(v31.totalPnlPercent);
	$("quickV31Return").className = "quick-stat-value " + cls(v31.totalPnlPercent);
	const v31Positions = Array.isArray(v31.livePositions) ? v31.livePositions : [];
	$("quickV31Slots").textContent = (v31.openSlots || 0) + " / " + (v31.maxSlots || 2);
	$("quickV31Positions").innerHTML = v31Positions.map((slot, i) =>
		renderQuickPosition(slot.position, slot.live, i)).join("") || '<div class="muted">No open positions.</div>';

	if (labError || !lab) {
		$("quickLabStatus").textContent = labError ? "FEED UNAVAILABLE" : "CONNECTING";
		$("quickLabTelegram").textContent = "Telegram: unavailable";
		$("quickLabEquity").textContent = "—";
		$("quickLabPnl").textContent = "—";
		$("quickLabReturn").textContent = "—";
		$("quickLabSlots").textContent = "—";
		$("quickLabPositions").innerHTML = '<div class="muted">' + escapeHtml(labError || "Waiting for lab data…") + "</div>";
	} else {
		$("quickLabStatus").textContent = lab.running ? "RUNNING · PAPER" : "STOPPED · PAPER";
		$("quickLabTelegram").textContent = lab.telegramConfigured ? "Telegram: ready" : "Telegram: missing";
		$("quickLabEquity").textContent = lab.equity == null ? "Unavailable" : money(lab.equity);
		$("quickLabPnl").textContent = lab.totalPnl == null ? "Unavailable" : money(lab.totalPnl);
		$("quickLabPnl").className = "quick-stat-value " + cls(lab.totalPnl);
		$("quickLabReturn").textContent = pct(lab.totalPnlPercent);
		$("quickLabReturn").className = "quick-stat-value " + cls(lab.totalPnlPercent);
		$("quickLabSlots").textContent = (lab.openSlots || 0) + " / " + (lab.maxSlots || 2);
		const labPositions = Array.isArray(lab.openPositions) ? lab.openPositions : [];
		$("quickLabPositions").innerHTML = labPositions.map((position, i) =>
			renderQuickPosition(position, position, i)).join("") || '<div class="muted">No open positions.</div>';
	}

	if (candleError || !candle) {
		$("quickCandleStatus").textContent = candleError ? "FEED UNAVAILABLE" : "CONNECTING";
		$("quickCandleEquity").textContent = "—";
		$("quickCandlePnl").textContent = "—";
		$("quickCandleReturn").textContent = "—";
		$("quickCandleSlots").textContent = "—";
		$("quickCandlePositions").innerHTML = '<div class="muted">' + escapeHtml(candleError || "Waiting for Candle Breakout data…") + "</div>";
		return;
	}
	$("quickCandleStatus").textContent = candleStatus?.running ? "RUNNING · PAPER" : "STOPPED · PAPER";
	$("quickCandleStatus").className = "badge" + (candleStatus?.running ? " online" : "");
	$("quickCandleEquity").textContent = candle.equity == null ? "Unavailable" : money(candle.equity);
	$("quickCandlePnl").textContent = candle.totalPnl == null ? "Unavailable" : money(candle.totalPnl);
	$("quickCandlePnl").className = "quick-stat-value " + cls(candle.totalPnl);
	$("quickCandleReturn").textContent = pct(candle.totalPnlPercent);
	$("quickCandleReturn").className = "quick-stat-value " + cls(candle.totalPnlPercent);
	const candlePositions = Array.isArray(candle.livePositions) ? candle.livePositions : [];
	$("quickCandleSlots").textContent = (candle.openSlots || candlePositions.length) + " / " + (candle.maxSlots || 3);
	$("quickCandlePositions").innerHTML = candlePositions.map((slot, i) =>
		renderQuickPosition(slot.position, slot.live, i)).join("") || '<div class="muted">No open positions.</div>';
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
	renderLabData(response.profitabilityLab, response.profitabilityLabError);
	renderQuickOverview(d, response.profitabilityLab, response.profitabilityLabError, response.candleBreakout, response.candleBreakoutStatus, response.candleBreakoutError);
}

async function refreshStatus() {
	try {
		const d = await request("/api/status");
		$("status").textContent = d.running ? "BOT ONLINE" : "BOT OFFLINE";
		$("status").className = "status" + (d.running ? " online" : "");
		$("quickV31Status").textContent = d.running ? "RUNNING" : "STOPPED";
		$("quickV31Status").className = "badge" + (d.running ? " online" : "");
		if (d.error) $("notice").textContent = "Trading paused after an error. Check server logs before restarting.";
	} catch (error) { $("status").textContent = "CONNECTION UNAVAILABLE"; $("status").className = "status"; }
}

async function refreshData() {
	try { renderData(await request("/api/data")); }
	catch (error) { $("equity").textContent = "Unavailable"; $("pnl").textContent = "Unavailable"; $("live").textContent = "Account update unavailable. Other displayed figures may be out of date."; }
}




async function refreshSwarm() {
	try {
		const d = await request("/api/swarm");
		const slots = Array.isArray(d.slots) ? d.slots : [];
		const openSlots = slots.filter(slot => slot.position);
		const totalPnl = Number(d.totalPnl) || 0;
		const startingCapital = Number(d.startingCapital) || (Number(d.totalCapital) - totalPnl);
		$("swarmStatus").textContent = d.running ? "RUNNING · PAPER" : "STOPPED · PAPER";
		$("quickSwarmStatus").textContent = d.running ? "RUNNING · PAPER" : "STOPPED · PAPER";
		$("quickSwarmStatus").className = "badge" + (d.running ? " online" : "");
		$("swarmEquity").textContent = money(d.totalCapital);
		$("swarmStarting").textContent = money(startingCapital);
		$("swarmPnl").textContent = money(totalPnl);
		$("swarmPnl").className = "metric-value " + cls(totalPnl);
		$("swarmOpen").textContent = slots.length + " active · " + openSlots.length + " trading";
		$("swarmReinvested").textContent = money(d.reinvestedProfit);
		$("swarmReproduction").textContent = money(slots.reduce((sum, s) => sum + Number(s.reproductionBalance || 0), 0));
		$("swarmPocketed").textContent = money(d.pocketedProfit);
		$("swarmChildren").textContent = number(d.childrenCreated);
		$("swarmSlots").innerHTML = slots.slice().sort((a,b) => Number(Boolean(b.position)) - Number(Boolean(a.position)) || Number(a.id) - Number(b.id)).map(s => {
			const p = s.position || {};
			const live = s.live || {};
			const chart = p.tokenAddress ? dexLink(p, live) : null;
			const parent = s.parentId ? "Parent " + s.parentId : "Genesis root";
			const next = s.nextChild ? "Child " + (Number(s.nextChildIndex || 0) + 1) + ": " + money(s.nextChild.cost) + " (" + s.nextChild.multiplier + "X)" : "Pyramid complete";
			const state = s.position ? "TRADING" : (s.growthStatus === "PYRAMID_COMPLETE" ? "PYRAMID COMPLETE" : "GROWING TOWARD NEXT CHILD");
			return '<article class="swarm-card"><h3>' + escapeHtml(s.swarmId || ("Swarm " + s.id)) + ' · ' + escapeHtml(state) + '</h3>' +
				'<div class="swarm-card-meta">' + escapeHtml(parent) + ' · Genesis ' + escapeHtml(s.genesisId || "—") + ' · Generation ' + number(s.generation) +
				(s.formationRow ? ' · Pyramid row ' + number(s.formationRow) + ', position ' + number(s.formationPosition) : '') + '</div>' +
				'<div class="swarm-card-stats"><div class="swarm-card-stat"><div class="swarm-card-label">Operating capital</div><div class="swarm-card-value">' + money(s.capital) + '</div></div>' +
				'<div class="swarm-card-stat"><div class="swarm-card-label">Reproduction reserve</div><div class="swarm-card-value">' + money(s.reproductionBalance) + '</div></div>' +
				'<div class="swarm-card-stat"><div class="swarm-card-label">Next child</div><div class="swarm-card-value">' + escapeHtml(next) + '</div></div>' +
				'<div class="swarm-card-stat"><div class="swarm-card-label">Eligibility</div><div class="swarm-card-value">' + (s.reproductionEligible ? 'Eligible · retains ≥75%' : (s.growthStatus === "PYRAMID_COMPLETE" ? 'Complete' : 'Keep growing')) + '</div></div>' +
				'<div class="swarm-card-stat"><div class="swarm-card-label">Pocketed · realized P/L</div><div class="swarm-card-value">' + money(s.pocketedProfit) + ' · ' + money(s.realizedProfit) + '</div></div>' +
				'<div class="swarm-card-stat"><div class="swarm-card-label">Children · trades</div><div class="swarm-card-value">' + number((s.children || []).length) + ' · ' + number(s.completedTrades) + '</div></div></div>' +
				'<div class="swarm-card-meta" style="margin:10px 0 0">' + (p.tokenAddress ?
					'<strong>' + escapeHtml(p.symbol || "Coin") + '</strong> · ' + money(p.amountInvested) + ' invested · ' +
					(live.currentPrice != null ? price(live.currentPrice) + ' current · ' + money(live.pnl) + ' (' + pct(live.pnlPercent) + ')' : 'live price unavailable') +
					(chart ? ' · <a class="small-link" href="' + chart + '" target="_blank" rel="noopener noreferrer">Chart</a>' : '') :
					'No open position') + '</div></article>';
		}).join("") || '<div class="muted">No active swarms.</div>';
		$("quickSwarmCapital").textContent = money(d.totalCapital);
		$("quickSwarmPnl").textContent = money(totalPnl);
		$("quickSwarmPnl").className = "quick-stat-value " + cls(totalPnl);
		$("quickSwarmReinvested").textContent = money(d.reinvestedProfit);
		$("quickSwarmChildren").textContent = number(d.childrenCreated);
		const returnPercent = startingCapital > 0 ? totalPnl / startingCapital * 100 : null;
		$("quickSwarmReturn").textContent = pct(returnPercent);
		$("quickSwarmReturn").className = "quick-stat-value " + cls(returnPercent);
		$("quickSwarmSlots").textContent = openSlots.length + " / " + (d.slotCount || slots.length || 5);
		$("quickSwarmPositions").innerHTML = openSlots.map(slot =>
			renderQuickPosition(slot.position, slot.live, Number(slot.id) - 1, "Slot " + slot.id)
		).join("") || '<div class="muted">No open positions.</div>';
	} catch (error) {
		$("quickSwarmStatus").textContent = "FEED UNAVAILABLE";
		$("quickSwarmCapital").textContent = "—";
		$("quickSwarmPnl").textContent = "—";
		$("quickSwarmReturn").textContent = "—";
		$("quickSwarmSlots").textContent = "—";
		$("quickSwarmReinvested").textContent = "—";
		$("quickSwarmChildren").textContent = "—";
		$("quickSwarmPositions").innerHTML = '<div class="muted">Swarm data unavailable.</div>';
	}
}
async function pollStatus() { await refreshStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); await refreshSwarm(); setTimeout(pollData, 5000); }
pollStatus();
pollData();
