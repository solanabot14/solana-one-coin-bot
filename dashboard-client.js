const $ = id => document.getElementById(id);
const money = value => value === null ? "Unavailable" : "$" + Number(value || 0).toFixed(2);
const price = value => Number(value) > 0 ? "$" + Number(value).toFixed(8) : "—";
const pct = value => Number(value || 0).toFixed(2) + "%";
const cls = value => value === null ? "" : Number(value || 0) >= 0 ? "green" : "red";
const escapeHtml = value => String(value ?? "-").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Dashboard request failed (" + response.status + ")");
  return response.json();
}
function renderData(d) {
  const s = d.stats;
  const l = d.live;
  const values = {
    starting: money(d.startingBalance), cash: money(d.cashBalance), equity: money(d.equity),
    pnl: money(d.totalPnl), count: s.completedTrades, winrate: pct(s.winRate), winners: s.winners,
    losers: s.losers, profit: money(s.grossProfit), loss: "-" + money(s.grossLoss),
    net: money(s.netPnl), factor: s.profitFactorLabel
  };
  for (const [id, value] of Object.entries(values)) $(id).textContent = value;
  $("pnl").className = "value " + cls(d.totalPnl);
  $("net").className = "metric-value " + cls(s.netPnl);
  if (d.position && l) {
    $("live").innerHTML = '<b>' + escapeHtml(d.position.symbol) + '</b><div class="grid">' +
      '<div class="metric">Current Price<br><strong>' + price(l.currentPrice) + '</strong></div>' +
      '<div class="metric">Current Value<br><strong>' + money(l.currentValue) + '</strong></div>' +
      '<div class="metric">Live P/L<br><strong class="' + cls(l.pnl) + '">' + money(l.pnl) +
      ' (' + pct(l.pnlPercent) + ')</strong></div><div class="metric">Momentum 5m<br><strong>' +
      pct(l.priceChange5m) + '</strong></div></div>';
  } else {
    $("live").textContent = d.position ?
      (d.position.symbol || "Open position") + " — price unavailable. Position remains open." : "Waiting for a trade...";
  }
  $("history").innerHTML = d.completedTrades.map(t => '<tr><td><strong>' + escapeHtml(t.symbol) +
    '</strong></td><td>' + price(t.entryPrice) + '</td><td>' + price(t.exitPrice) + '</td><td>' +
    money(t.amountInvested) + '</td><td class="' + cls(t.pnl) + '">' + money(t.pnl) +
    '</td><td class="' + cls(t.pnl) + '">' + pct(t.pnlPercent) +
    '</td><td><a class="small-link" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/' +
    encodeURIComponent(t.tokenAddress || '') + '">DexScreener</a></td></tr>').join('') ||
    '<tr><td colspan="7">No completed positions yet.</td></tr>';
}
async function refreshStatus() {
  try {
    const d = await request("/api/status");
    $("status").textContent = d.running ? "BOT ONLINE" : "BOT OFFLINE";
    $("status").className = "status" + (d.running ? " online" : "");
    if (d.error) $("notice").textContent = "Trading paused after an error. Check server logs before restarting.";
  } catch (error) {
    $("status").textContent = "CONNECTION UNAVAILABLE";
    $("status").className = "status";
  }
}
async function refreshData() {
  try { renderData(await request("/api/data")); }
  catch (error) {
    $("equity").textContent = $("pnl").textContent = "Unavailable";
    $("live").textContent = "Account update unavailable. Other displayed figures may be out of date.";
  }
}
async function control(action) {
  $("startButton").disabled = $("stopButton").disabled = true;
  try {
    await request("/api/" + action, { method: "POST", headers: { "X-Bot-Control": "1" } });
    $("notice").textContent = action === "stop" ?
      "Stopped. Open positions remain saved; automatic exits are paused." : "Running. Automatic exits are enabled.";
    await refreshStatus();
  } catch (error) { $("notice").textContent = error.message; }
  finally { $("startButton").disabled = $("stopButton").disabled = false; }
}
$("startButton").addEventListener("click", () => control("start"));
$("stopButton").addEventListener("click", () => control("stop"));
async function pollStatus() { await refreshStatus(); setTimeout(pollStatus, 2000); }
async function pollData() { await refreshData(); setTimeout(pollData, 5000); }
pollStatus();
pollData();
