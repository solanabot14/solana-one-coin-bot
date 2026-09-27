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
	const position = d.position, live = d.live;
	if (!position) { $("live").textContent = "Waiting for a trade..."; return; }
	if (!live) { $("live").textContent = (position.symbol || "Open position") + " — price unavailable. Position remains open."; return; }
	const chart = dexLink(position, live);
	const reasons = Array.isArray(position.entryReasons) && position.entryReasons.length ? position.entryReasons.map(escapeHtml).join(" • ") : "No entry reasons recorded.";
	const tp1 = position.firstTakeProfitDone ? "DONE" : "Waiting +15%";
	const tp2 = position.secondTakeProfitDone ? "DONE" : "Waiting +30%";
	const profitLock = live.profitLockActive ? "ACTIVE" : "OFF";
	const protectedFloor = live.protectedFloorPercent == null ? "—" : pct(live.protectedFloorPercent);
	const trailingLevel = live.trailingExitPrice == null
		? "—"
		: `${price(live.trailingExitPrice)} (${pct(live.trailingExitPercent)})`;
	$("live").innerHTML = `
		<div class="live-title"><span class="coin-name">${escapeHtml(position.symbol)}</span>
			<span class="badge">${escapeHtml(position.strategyVersion || "V3.1")}</span>
			<span class="badge">Score ${escapeHtml(position.entryScore ?? "—")}</span>
			<span class="badge">${escapeHtml(position.entrySignal || "—")}</span>
			${chart ? `<a class="small-link" href="${chart}" target="_blank" rel="noopener noreferrer">View on DexScreener</a>` : ""}
		</div>
		<div class="grid">
			<div class="metric"><div class="metric-label">Entry Price</div><div class="metric-value">${price(position.entryPrice)}</div></div>
			<div class="metric"><div class="metric-label">Current Price</div><div class="metric-value">${price(live.currentPrice)}</div></div>
			<div class="metric"><div class="metric-label">Highest Price</div><div class="metric-value">${price(live.highestPrice)}</div></div>
			<div class="metric"><div class="metric-label">Amount Invested</div><div class="metric-value">${money(position.amountInvested)}</div></div>
			<div class="metric"><div class="metric-label">Current Value</div><div class="metric-value">${money(live.currentValue)}</div></div>
			<div class="metric"><div class="metric-label">Live P/L</div><div class="metric-value ${cls(live.pnl)}">${money(live.pnl)} (${pct(live.pnlPercent)})</div></div>
			<div class="metric"><div class="metric-label">Max Gain</div><div class="metric-value ${cls(live.maxGainPercent)}">${pct(live.maxGainPercent)}</div></div>
			<div class="metric"><div class="metric-label">Mode</div><div class="metric-value">${escapeHtml(live.mode || "NORMAL")}</div></div>
			<div class="metric"><div class="metric-label">Profit Lock</div><div class="metric-value">${profitLock}</div></div>
			<div class="metric"><div class="metric-label">Protected Floor</div><div class="metric-value ${cls(live.protectedFloorPercent)}">${protectedFloor}</div></div>
			<div class="metric"><div class="metric-label">Runner Trailing Exit</div><div class="metric-value">${trailingLevel}</div></div>
			<div class="metric"><div class="metric-label">Time in Trade</div><div class="metric-value">${duration(live.holdTimeMs)}</div></div>
			<div class="metric"><div class="metric-label">Current 5m</div><div class="metric-value ${cls(live.priceChange5m)}">${pct(live.priceChange5m)}</div></div>
			<div class="metric"><div class="metric-label">Current 1h</div><div class="metric-value ${cls(live.priceChange1h)}">${pct(live.priceChange1h)}</div></div>
			<div class="metric"><div class="metric-label">Current 24h</div><div class="metric-value ${cls(live.priceChange24h)}">${pct(live.priceChange24h)}</div></div>
			<div class="metric"><div class="metric-label">Current Buy Ratio</div><div class="metric-value">${pct(Number(live.buyRatio5m || 0) * 100)}</div></div>
			<div class="metric"><div class="metric-label">5m Buys / Sells</div><div class="metric-value">${number(live.buys5m)} / ${number(live.sells5m)}</div></div>
			<div class="metric"><div class="metric-label">Liquidity</div><div class="metric-value">${money(live.liquidityUsd)}</div></div>
			<div class="metric"><div class="metric-label">24h Volume</div><div class="metric-value">${money(live.volume24h)}</div></div>
			<div class="metric"><div class="metric-label">TP1</div><div class="metric-value">${tp1}</div></div>
			<div class="metric"><div class="metric-label">TP2</div><div class="metric-value">${tp2}</div></div>
		</div>
		<div class="reasons"><strong>Entry Conditions</strong><br>
			Entry 5m: ${pct(position.entryPriceChange5m)} &nbsp; | &nbsp;
			Entry 1h: ${pct(position.entryPriceChange1h)} &nbsp; | &nbsp;
			Entry 24h: ${pct(position.entryPriceChange24h)}<br>
			Entry Buy Ratio: ${entryRatio(position)} &nbsp; | &nbsp;
			Transactions: ${number(position.entryTransactions5m)}<br>
			Entry Liquidity: ${money(position.entryLiquidityUsd)} &nbsp; | &nbsp;
			Entry Volume: ${money(position.entryVolume24h)}<br><br>
			<strong>Strategy Reasons:</strong> ${reasons}
		</div>`;
}


function renderTokenDiversity(d) {
	const rows = Array.isArray(d.tokenDiversity?.rows) ? d.tokenDiversity.rows : [];
	$("diversityRows").innerHTML = rows.map(row => {
		const available = row.availableAt
			? new Date(row.availableAt).toLocaleString()
			: row.status === "OPEN NOW" ? "After close" : row.status === "RESTING 24H" ? "—" : "If qualified";
		return `<tr>
			<td><strong>${escapeHtml(row.symbol)}</strong></td>
			<td><span class="badge">${escapeHtml(row.status)}</span></td>
			<td>${number(row.entries24h)}</td>
			<td class="green">${number(row.wins24h)}</td>
			<td class="red">${number(row.losses24h)}</td>
			<td class="${cls(row.maxGainPercent)}">${pct(row.maxGainPercent)}</td>
			<td>${escapeHtml(available)}</td>
			<td>${escapeHtml(row.detail)}</td>
		</tr>`;
	}).join("") || `<tr><td colspan="8">No recent token activity.</td></tr>`;
}

function renderScoreStats(d) {
	const rows = Array.isArray(d.scoreStats) ? d.scoreStats : [];
	$("scoreStats").innerHTML = rows.map(row => `<tr>
		<td><strong>${escapeHtml(row.score)}</strong></td><td>${row.trades}</td><td class="green">${row.winners}</td><td class="red">${row.losers}</td>
		<td>${pct(row.winRate)}</td><td class="${cls(row.averageReturn)}">${pct(row.averageReturn)}</td>
		<td class="${cls(row.averageMaxGain)}">${pct(row.averageMaxGain)}</td><td class="${cls(row.netPnl)}">${money(row.netPnl)}</td></tr>`).join("") || `<tr><td colspan="8">No completed trades yet.</td></tr>`;
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


function renderSlotSimulation(d) {
	const sim = d.slotSimulation;
	if (!sim) return;
	$("slotStarting").textContent = money(sim.startingCapital);
	$("slotTotal").textContent = money(sim.totalCapital);
	$("slotPnl").textContent = money(sim.totalPnl);
	$("slotPnl").className = "metric-value " + cls(sim.totalPnl);
	$("slotTarget").textContent = (sim.targets || []).map(target => money(target)).join(" → ");
	$("slotTrades").textContent = number(sim.tradesReplayed);

	$("slotRows").innerHTML = (sim.slots || []).map(slot => {
		const p = slot.position;
		return `<tr>
			<td><strong>Slot ${escapeHtml(slot.id)}</strong></td>
			<td>${money(slot.cashBalance)}</td>
			<td>${p ? `<strong>${escapeHtml(p.symbol)}</strong>` : "—"}</td>
			<td>${p ? money(p.originalAmountInvested || p.amountInvested) : "—"}</td>
			<td>${slot.currentTarget == null ? "COMPLETE" : money(slot.currentTarget)}</td>
			<td style="min-width:160px">
				${pct(slot.progressPercent)}
				<div class="progress"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(slot.progressPercent) || 0))}%"></div></div>
			</td>
			<td>${number(slot.completedTrades)}</td>
			<td class="green">${number(slot.winners)}</td>
			<td class="red">${number(slot.losers)}</td>
		</tr>`;
	}).join("") || `<tr><td colspan="9">Waiting for Jan MVP activity...</td></tr>`;

	const progress = Array.isArray(sim.targetProgress) ? sim.targetProgress : [];
	$("slotTargets").innerHTML = (sim.targets || []).map(target => {
		const row = progress.find(item => Number(item.target) === Number(target));
		const reached = row?.reachedBy ?? 0;
		const total = row?.totalSlots ?? sim.slotCount ?? 0;
		return `<div class="metric">
			<div class="metric-label">Milestone Progress</div>
			<div class="metric-value">${money(target)} / slot</div>
			<div class="muted">${reached} of ${total} slots reached</div>
		</div>`;
	}).join("");

	const executions = Array.isArray(sim.executions) ? sim.executions : [];
	$("slotExecutions").innerHTML = executions.map(execution => {
		const time = execution.time ? new Date(execution.time).toLocaleString() : "—";
		const amount = execution.type === "BUY"
			? money(execution.amount)
			: execution.saleValue == null ? "—" : money(execution.saleValue);
		const details = execution.type === "SELL"
			? `${escapeHtml(execution.reason || "SELL")} ${execution.pnl == null ? "" : " | " + money(execution.pnl)}`
			: "BUY";
		return `<tr>
			<td>${escapeHtml(time)}</td>
			<td>${escapeHtml(execution.type || "—")}</td>
			<td>Slot ${escapeHtml(execution.slotId)}</td>
			<td><strong>${escapeHtml(execution.symbol)}</strong></td>
			<td>${price(execution.price)}</td>
			<td>${amount}</td>
			<td class="${execution.pnl == null ? "" : cls(execution.pnl)}">${details}</td>
		</tr>`;
	}).join("") || `<tr><td colspan="7">Waiting for Jan MVP executions...</td></tr>`;
}

function showTab(name) {
	const botActive = name === "bot";
	$("botPanel").className = "tab-panel" + (botActive ? " active" : "");
	$("slotPanel").className = "tab-panel" + (!botActive ? " active" : "");
	$("botTab").className = "tab-button" + (botActive ? " active" : "");
	$("slotTab").className = "tab-button" + (!botActive ? " active" : "");
}

function renderData(d) {
	const s = d.stats;
	const values = {starting:money(d.startingBalance), cash:money(d.cashBalance), equity:money(d.equity), pnl:money(d.totalPnl), count:s.completedTrades, winrate:pct(s.winRate), winners:s.winners, losers:s.losers, profit:money(s.grossProfit), loss:"-" + money(s.grossLoss), net:money(s.netPnl), factor:s.profitFactorLabel, avgWinner:pct(s.averageWinnerPercent), avgLoser:pct(s.averageLoserPercent), avgHold:duration(s.averageHoldTimeMs), avgMaxGain:pct(s.averageMaxGainPercent)};
	for (const [id, value] of Object.entries(values)) $(id).textContent = value;
	$("pnl").className = "value " + cls(d.totalPnl);
	$("net").className = "metric-value " + cls(s.netPnl);
	renderLiveTrade(d); renderTokenDiversity(d); renderScoreStats(d); renderExitReasons(d); renderHistory(d); renderSlotSimulation(d);
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

async function refreshJanStatus() {
	try {
		const d = await request("/api/jan/status");
		$("janStatus").textContent = d.running ? "JAN MVP ONLINE" : "JAN MVP OFFLINE";
		$("janStatus").className = "status" + (d.running ? " online" : "");
		if (d.error) $("janNotice").textContent = "Jan MVP error: " + d.error;
	} catch (error) {
		$("janStatus").textContent = "JAN MVP UNAVAILABLE";
		$("janStatus").className = "status";
	}
}

async function janControl(action) {
	$("janStartButton").disabled = true;
	$("janStopButton").disabled = true;
	try {
		await request("/api/jan/" + action, {method:"POST", headers:{"X-Bot-Control":"1"}});
		$("janNotice").textContent = action === "stop"
			? "Jan MVP paused. Its simulated positions remain saved."
			: "Jan MVP running independently from the original bot.";
		await refreshJanStatus();
	} catch (error) {
		$("janNotice").textContent = error.message;
	} finally {
		$("janStartButton").disabled = false;
		$("janStopButton").disabled = false;
	}
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
$("botTab").addEventListener("click", () => showTab("bot"));
$("slotTab").addEventListener("click", () => showTab("slot"));
$("janStartButton").addEventListener("click", () => janControl("start"));
$("janStopButton").addEventListener("click", () => janControl("stop"));

async function pollStatus() { await refreshStatus(); await refreshJanStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); setTimeout(pollData, 5000); }
pollStatus();
pollData();
