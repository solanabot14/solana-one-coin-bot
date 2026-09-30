const $ = id => document.getElementById(id);

const money = value => value == null ? "—" : "$" + Number(value || 0).toFixed(2);
const price = value => Number(value) > 0 ? "$" + Number(value).toFixed(8) : "—";
const pct = value => value == null ? "—" : Number(value || 0).toFixed(2) + "%";
const entryRatio = trade => {
	const value = trade.entryBuyRatio ?? trade.entryBuyRatio5m;
	return pct(value == null ? null : Number(value) * 100);
};
const number = value => value == null ? "—" : Number(value).toLocaleString();
const smartMoneyLabel = value => {
	if (!value) return "—";
	const flow = Number(value.netFlow) || 0;
	const traders = Number(value.smartTraders) || 0;
	return (flow >= 0 ? "+" : "") + money(flow) + " / " + traders + " wallets";
};
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
			<span class="badge">${escapeHtml(position.strategyVersion || "R3-EARLY-RUNNER")}</span>
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
			<div class="metric"><div class="metric-label">Current 5m Volume</div><div class="metric-value">${money(live.volume5m)}</div></div>
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
			Entry 5m Volume: ${money(position.entryVolume5m)} &nbsp; | &nbsp;
			Entry 24h Volume: ${money(position.entryVolume24h)}<br>
			15m Observed Extension: ${pct(position.entryPostPump?.extensionPercent)} &nbsp; | &nbsp;
			Historical 15m: ${pct(position.entryPreDiscoveryPump?.window15m?.extensionPercent)} &nbsp; | &nbsp;
			Historical 30m: ${pct(position.entryPreDiscoveryPump?.window30m?.extensionPercent)}<br>
			Pre-Discovery Check: ${escapeHtml(position.entryPreDiscoveryPump?.status || "—")} &nbsp; | &nbsp;
			Failed Structure: ${position.entryPreDiscoveryPump?.failedStructure?.blocked ? "BLOCKED" : "OK"}<br>
			Smart Money: ${escapeHtml(smartMoneyLabel(position.entrySmartMoney))}<br>
			Source: ${escapeHtml((position.entryDiscoverySources || []).join(", ") || "—")}<br><br>
			<strong>Strategy Reasons:</strong> ${reasons}
		</div>`;
}



function renderDiscoveryTelemetry(d) {
	const telemetry = d.discoveryTelemetry || {};
	$("discoveryUnique").textContent = number(telemetry.uniqueSolanaCandidates || 0);
	$("discoveryPassed").textContent = number(telemetry.candidatesAfterSafetyFilters || 0);
	$("discoveryStrong").textContent = number(telemetry.strongBuys || 0);
	$("discoveryUpdated").textContent = telemetry.updatedAt
		? new Date(telemetry.updatedAt).toLocaleTimeString()
		: "—";

	const sources = Array.isArray(telemetry.sources) ? telemetry.sources : [];
	$("discoverySources").innerHTML = sources.map(source => `<tr>
		<td><strong>${escapeHtml(source.name)}</strong></td>
		<td>${escapeHtml(source.type || "—")}</td>
		<td>${number(source.received)}</td>
	</tr>`).join("") || `<tr><td colspan="3">Waiting for scan data...</td></tr>`;

	const candidates = Array.isArray(telemetry.topCandidates) ? telemetry.topCandidates : [];
	$("discoveryCandidates").innerHTML = candidates.map(candidate => `<tr>
		<td><strong>${escapeHtml(candidate.symbol)}</strong></td>
		<td>${escapeHtml(candidate.score ?? "—")}</td>
		<td>${escapeHtml(candidate.signal || "—")}</td>
		<td>${escapeHtml((candidate.discoverySources || []).join(", ") || "—")}</td>
	</tr>`).join("") || `<tr><td colspan="4">Waiting for scan data...</td></tr>`;
}


function renderRejectionTelemetry(d) {
	const r = d.discoveryTelemetry?.rejectionTelemetry || {};
	const counts = {
		rejectNotStrong: r.notStrongBuy || 0,
		rejectScore: r.scoreBelow8 || 0,
		reject5m: r.fiveMinute || 0,
		reject1h: r.oneHour || 0,
		rejectRatio: r.buyRatio || 0,
		rejectTx: r.transactions || 0,
		rejectAnti5m: r.antiChase5m || 0,
		rejectAnti1h: r.antiChase1h || 0,
		rejectAnti24h: r.antiChase24h || 0,
		rejectPostPump: r.postPump || 0,
		rejectCurrentActivity: r.currentActivity || 0,
		rejectLateMomentum: r.lateMomentum || 0,
		rejectMarketIntegrity: r.marketDataIntegrity || 0,
		rejectPreDiscoveryPump: r.preDiscoveryPump || 0,
		rejectPostPumpRebound: r.postPumpRebound || 0
	};
	const sm = d.discoveryTelemetry?.smartMoney || {};
	const historical = d.discoveryTelemetry?.preDiscoveryPumpGuard || {};
	const historicalUsage = historical.usage || {};
	const dexHealth = d.discoveryTelemetry?.marketDataHealth || {};
	$("birdeyeOhlcvStatus").textContent = escapeHtml(historicalUsage.lastStatus || "—");
	$("birdeyeOhlcvRequests").textContent = number(historicalUsage.requests || 0);
	$("birdeyeOhlcvCacheHits").textContent = number(historicalUsage.cacheHits || 0);
	$("dexDiscoveryHealth").textContent = dexHealth.discoveryCircuitOpen
		? "PAUSED (" + number(dexHealth.consecutiveDiscoveryFailures || 0) + " failures)"
		: "OK";
	$("smartMoneyStatus").textContent = escapeHtml(sm.status || "—");
	$("smartMoneyMatches").textContent = number(sm.matchedCandidates || 0);
	for (const [id, value] of Object.entries(counts)) $(id).textContent = number(value);

	const blockerLabel = blocker => ({
		SCORE_BELOW_8: "Score < 8",
		"5M_CONFIRMATION": "5m confirmation",
		"1H_CONFIRMATION": "1h confirmation",
		BUY_RATIO: "Buy ratio < 55%",
		TRANSACTIONS: "5m tx < 20",
		ANTI_CHASE_5M: "Anti-chase 5m",
		ANTI_CHASE_1H: "Anti-chase 1h",
		ANTI_CHASE_24H: "Anti-chase 24h",
		POST_PUMP: "Post-pump guard",
		CURRENT_ACTIVITY: "Current activity",
		LATE_MOMENTUM: "Late momentum",
		MARKET_DATA_INTEGRITY: "Market data integrity",
		PRE_DISCOVERY_PUMP: "Pre-discovery pump",
		POST_PUMP_REBOUND: "Post-pump rebound"
	}[blocker] || blocker);

	const near = Array.isArray(r.nearEntries) ? r.nearEntries : [];
	$("rejectionNearEntries").innerHTML = near.map(item => `<tr>
		<td><strong>${escapeHtml(item.symbol)}</strong></td>
		<td>${escapeHtml(item.score)}</td>
		<td>${escapeHtml(item.signal || "—")}</td>
		<td>${pct(item.priceChange5m)}</td>
		<td>${pct(item.priceChange1h)}</td>
		<td>${item.buyRatio == null ? "—" : pct(Number(item.buyRatio) * 100)}</td>
		<td>${number(item.transactions5m)}</td>
		<td>${money(item.volume5m)}</td>
		<td>${pct(item.volumeLiquidity5mPercent)}</td>
		<td>${pct(item.postPumpExtensionPercent)}</td>
		<td>${pct(item.preDiscoveryPump?.window15m?.extensionPercent)}</td>
		<td>${pct(item.preDiscoveryPump?.window30m?.extensionPercent)}</td>
		<td>${escapeHtml(smartMoneyLabel(item.smartMoney))}</td>
		<td>${escapeHtml((item.blockers || []).map(blockerLabel).join(", ") || "—")}</td>
		<td>${escapeHtml((item.discoverySources || []).join(", ") || "—")}</td>
	</tr>`).join("") || `<tr><td colspan="15">No near-entry BUY candidates in the latest scan.</td></tr>`;
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

function renderCurrentResearch(d) {
	const research = d.v36Research || {};
	const s = research.stats || {};
	const values = {
		v36Trades: s.completedTrades || 0,
		v36WinRate: pct(s.winRate || 0),
		v36Net: money(s.netPnl || 0),
		v36Factor: s.profitFactorLabel || "—",
		v36Expectancy: pct(s.expectancyPercent),
		v36Payoff: s.payoffRatio == null ? "—" : Number(s.payoffRatio).toFixed(2) + "x",
		v36Drawdown: pct(s.maxDrawdownPercent),
		v36LossStreak: number(s.maxConsecutiveLosses || 0),
		v36Started: research.startedAt ? new Date(research.startedAt).toLocaleString() : "Waiting for first R3 trade",
		v36StartBalance: money(research.startingBalance)
	};
	for (const [id, value] of Object.entries(values)) $(id).textContent = value;
	$("v36Net").className = "metric-value " + cls(s.netPnl);
	$("v36Expectancy").className = "metric-value " + cls(s.expectancyPercent);

	const versionRows = Array.isArray(d.strategyVersionStats) ? d.strategyVersionStats : [];
	$("strategyVersionStats").innerHTML = versionRows.map(row => `<tr>
		<td><strong>${escapeHtml(row.version)}</strong></td><td>${number(row.trades)}</td><td>${pct(row.winRate)}</td>
		<td class="${cls(row.expectancyPercent)}">${pct(row.expectancyPercent)}</td><td>${escapeHtml(row.profitFactorLabel || "—")}</td>
		<td class="${cls(row.netPnl)}">${money(row.netPnl)}</td>
	</tr>`).join("") || `<tr><td colspan="6">No completed strategy data yet.</td></tr>`;

	const sourceRows = Array.isArray(research.sourceStats) ? research.sourceStats : [];
	$("v36SourceStats").innerHTML = sourceRows.map(row => `<tr>
		<td><strong>${escapeHtml(row.source)}</strong></td><td>${number(row.trades)}</td><td>${pct(row.winRate)}</td>
		<td class="${cls(row.expectancyPercent)}">${pct(row.expectancyPercent)}</td><td>${escapeHtml(row.profitFactorLabel || "—")}</td>
		<td class="${cls(row.netPnl)}">${money(row.netPnl)}</td>
	</tr>`).join("") || `<tr><td colspan="6">Waiting for R3 trades.</td></tr>`;

	const rankRows = Array.isArray(research.birdeyeRankStats) ? research.birdeyeRankStats : [];
	$("v36RankStats").innerHTML = rankRows.map(row => `<tr>
		<td><strong>${escapeHtml(row.rank)}</strong></td><td>${number(row.trades)}</td><td>${pct(row.winRate)}</td>
		<td class="${cls(row.expectancyPercent)}">${pct(row.expectancyPercent)}</td><td>${escapeHtml(row.profitFactorLabel || "—")}</td>
		<td class="${cls(row.netPnl)}">${money(row.netPnl)}</td>
	</tr>`).join("") || `<tr><td colspan="6">Waiting for R3 ranked trades.</td></tr>`;

	const archived = d.v35Research?.stats || {};
	$("v35ArchiveStats").innerHTML = `<tr>
		<td><strong>V3.1R2 Historical Baseline</strong></td>
		<td>${number(archived.completedTrades || 0)}</td>
		<td>${pct(archived.winRate || 0)}</td>
		<td class="${cls(archived.expectancyPercent)}">${pct(archived.expectancyPercent)}</td>
		<td>${escapeHtml(archived.profitFactorLabel || "—")}</td>
		<td class="${cls(archived.netPnl)}">${money(archived.netPnl || 0)}</td>
	</tr>`;
}

function renderExitReasons(d) {
	const entries = Object.entries(d.exitReasonCounts || {});
	$("exitReasons").innerHTML = entries.map(([reason, count]) => `<div class="metric"><div class="metric-label">${escapeHtml(reason)}</div><div class="metric-value">${count}</div></div>`).join("") || `<div class="metric">No completed positions yet.</div>`;
}

function renderHistory(d) {
	$("history").innerHTML = d.completedTrades.map(t => {
		const reason = Array.isArray(t.exitReasons) ? t.exitReasons.join(" / ") : "—";
		const chartAddress = t.pairAddress || t.tokenAddress || "";
		return `<tr><td><strong>${escapeHtml(t.symbol)}</strong></td><td>${escapeHtml(t.strategyVersion || "—")}</td><td>${t.entryBirdeyeRank == null ? "—" : "#" + escapeHtml(t.entryBirdeyeRank)}</td><td>${escapeHtml(t.entryScore ?? "—")}</td>
			<td>${pct(t.entryPriceChange5m)}</td><td>${pct(t.entryPriceChange1h)}</td><td>${entryRatio(t)}</td>
			<td>${money(t.entryVolume5m)}</td><td>${pct(t.entryPostPump?.extensionPercent)}</td>
			<td>${escapeHtml(smartMoneyLabel(t.entrySmartMoney))}</td>
			<td>${escapeHtml((t.entryDiscoverySources || []).join(", ") || "—")}</td>
			<td>${price(t.entryPrice)}</td><td>${price(t.exitPrice)}</td><td>${money(t.amountInvested)}</td>
			<td>${money(t.tp1SaleValue)}</td><td>${money(t.tp2SaleValue)}</td><td>${money(t.trailingSaleValue)}</td><td>${money(t.otherExitSaleValue)}</td><td>${money(t.saleValue)}</td>
			<td class="${cls(t.pnl)}">${money(t.pnl)}</td><td class="${cls(t.pnlPercent)}">${pct(t.pnlPercent)}</td>
			<td class="${cls(t.maxGainPercent)}">${pct(t.maxGainPercent)}</td><td>${duration(t.holdTimeMs)}</td><td>${escapeHtml(reason)}</td>
			<td><a class="small-link" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/${encodeURIComponent(chartAddress)}">DexScreener</a></td></tr>`;
	}).join("") || `<tr><td colspan="25">No completed positions yet.</td></tr>`;
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
	}).join("") || `<tr><td colspan="9">Waiting for Swarm activity...</td></tr>`;

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
		const isSplit = execution.type === "SPLIT";
		const amount = execution.type === "BUY" || isSplit
			? money(execution.amount)
			: execution.saleValue == null ? "—" : money(execution.saleValue);
		const details = execution.type === "SELL"
			? `${escapeHtml(execution.reason || "SELL")} ${execution.pnl == null ? "" : " | " + money(execution.pnl)}`
			: isSplit
				? `Created slots ${escapeHtml((execution.childSlotIds || []).join(", "))} | Parent kept ${money(execution.remainingBalance)}`
				: "BUY";
		return `<tr>
			<td>${escapeHtml(time)}</td>
			<td>${escapeHtml(execution.type || "—")}</td>
			<td>Slot ${escapeHtml(execution.slotId)}</td>
			<td><strong>${isSplit ? "—" : escapeHtml(execution.symbol || "—")}</strong></td>
			<td>${isSplit ? "—" : price(execution.price)}</td>
			<td>${amount}</td>
			<td class="${execution.pnl == null ? "" : cls(execution.pnl)}">${details}</td>
		</tr>`;
	}).join("") || `<tr><td colspan="7">Waiting for Swarm executions...</td></tr>`;
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
	renderLiveTrade(d); renderCurrentResearch(d); renderDiscoveryTelemetry(d); renderRejectionTelemetry(d); renderTokenDiversity(d); renderScoreStats(d); renderExitReasons(d); renderHistory(d); renderSlotSimulation(d);
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
		$("janStatus").textContent = d.running ? "SWARM ONLINE" : "SWARM OFFLINE";
		$("janStatus").className = "status" + (d.running ? " online" : "");
		if (d.error) $("janNotice").textContent = "Swarm error: " + d.error;
	} catch (error) {
		$("janStatus").textContent = "SWARM UNAVAILABLE";
		$("janStatus").className = "status";
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

async function pollStatus() { await refreshStatus(); await refreshJanStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); setTimeout(pollData, 5000); }
pollStatus();
pollData();
