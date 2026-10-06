require("dotenv").config();
const http = require("node:http");
const crypto = require("node:crypto");
const bot = require("./buyPriorityLock85");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const username = process.env.DASHBOARD_USER || "";
const password = process.env.DASHBOARD_PASSWORD || "";
const railway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
if ((username && !password) || (!username && password)) throw new Error("Set both DASHBOARD_USER and DASHBOARD_PASSWORD.");
if (railway && (!username || !password)) throw new Error("Dashboard credentials are required in Railway.");

function safeEqual(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authorized(req) {
  if (!username && !password) return !railway;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch (_) { return false; }
  const split = decoded.indexOf(":");
  return split >= 0 && safeEqual(decoded.slice(0, split), username) && safeEqual(decoded.slice(split + 1), password);
}
function json(res, body, status) {
  res.writeHead(status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const page = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>V3.1 BUY Priority Test · 85% LP Lock</title>\n<style>\n:root{color-scheme:dark;--bg:#080d16;--panel:#111a29;--line:#253248;--cyan:#54d6ff;--muted:#8fa2ba;--text:#edf4ff;--green:#53dc9a;--red:#ff7186}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}\nmain{max-width:1120px;margin:auto;padding:22px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}\nh1{font-size:22px;margin:0 0 4px}.subtitle,.muted{color:var(--muted)}.tag{display:inline-block;color:var(--cyan);border:1px solid #24536b;border-radius:99px;padding:3px 9px;font-size:11px;letter-spacing:.06em}\n.actions{display:flex;gap:8px}button{background:#18263a;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 13px;font-weight:700}button.primary{background:#12374a;border-color:#267493;color:var(--cyan)}\n.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px}.label{color:var(--muted);font-size:11px;letter-spacing:.08em}.value{font-size:20px;font-weight:750;margin-top:5px}.panel{margin:14px 0;overflow:hidden}.panel h2{font-size:13px;letter-spacing:.08em;margin:0 0 12px;color:#b9c9dc}\n.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{text-align:left;padding:10px 9px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:10px;letter-spacing:.08em}td a{color:var(--cyan);text-decoration:none}.positive{color:var(--green)}.negative{color:var(--red)}.notice{padding:11px 13px;border:1px solid #254359;background:#102033;border-radius:9px;margin:12px 0;color:#bfd4e8;font-size:12px}\n@media(max-width:750px){main{padding:14px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}header{display:block}.actions{margin-top:12px}.value{font-size:18px}h1{font-size:19px}}\n</style></head><body><main>\n<header><div><span class=\"tag\">PAPER ONLY · ISOLATED BOT</span><h1>V3.1 BUY Priority Test</h1><div class=\"subtitle\">85% verified LP-lock experiment · separate account and runtime</div></div><div class=\"actions\"><button class=\"primary\" data-control=\"start\">START</button><button data-control=\"stop\">STOP</button><button data-refresh>REFRESH</button></div></header>\n<div class=\"notice\">This service runs only the 85% lock test. It does not start or control the original V3.1, Swarm, Buy Priority Test, or other bots. All orders here are simulated.</div>\n<div id=\"summary\" class=\"grid\"></div>\n<section class=\"panel\"><h2>OPEN POSITIONS</h2><div class=\"scroll\"><table><thead><tr><th>TOKEN</th><th>INVESTED</th><th>ENTRY PRICE</th><th>ENTRY SIGNAL</th><th>DEXSCREENER</th></tr></thead><tbody id=\"positions\"></tbody></table></div></section>\n<section class=\"panel\"><h2>TRADE HISTORY</h2><div class=\"scroll\"><table><thead><tr><th>TIME</th><th>TOKEN</th><th>TYPE</th><th>INVESTED</th><th>RECEIVED</th><th>P&amp;L</th><th>DETAIL</th></tr></thead><tbody id=\"history\"></tbody></table></div></section>\n<div id=\"status\" class=\"muted\"></div>\n</main><script>\nfunction esc(v){return String(v==null?\"—\":v).replace(/[&<>\"']/g,function(c){return {\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c];});}\nfunction money(v){return Number.isFinite(Number(v))?\"$\"+Number(v).toFixed(2):\"—\";}\nfunction price(v){return Number.isFinite(Number(v))?\"$\"+Number(v).toPrecision(7):\"—\";}\nasync function load(){try{\nconst pair=await Promise.all([fetch(\"/api/data\",{cache:\"no-store\"}).then(r=>r.json()),fetch(\"/api/status\",{cache:\"no-store\"}).then(r=>r.json())]);\nconst d=pair[0],s=pair[1],a=d.account||{},positions=a.positions||[],history=(a.history||[]).slice().reverse();\nconst realized=(a.history||[]).filter(x=>x.type===\"SELL\").reduce((sum,x)=>sum+(Number(x.netPnl??x.pnl)||0),0);\nconst equity=(Number(a.cashBalance)||0)+positions.reduce((sum,p)=>sum+(Number(p.amountInvested)||0),0);\nconst cards=[[\"MODE\",\"PAPER\"],[\"BOT\",s.running?\"RUNNING\":\"STOPPED\"],[\"LOCK MINIMUM\",\"85% verified\"],[\"REALIZED P&L\",money(realized)],[\"STARTING BALANCE\",money(a.startingBalance)],[\"CASH\",money(a.cashBalance)],[\"OPEN SLOTS\",positions.length+\" / 2\"],[\"PAPER EQUITY\",money(equity)]];\ndocument.getElementById(\"summary\").innerHTML=cards.map(x=>'<div class=\"card\"><div class=\"label\">'+esc(x[0])+'</div><div class=\"value\">'+esc(x[1])+'</div></div>').join(\"\");\ndocument.getElementById(\"positions\").innerHTML=positions.length?positions.map(p=>'<tr><td><strong>'+esc(p.symbol)+'</strong></td><td>'+money(p.amountInvested)+'</td><td>'+price(p.entryPrice)+'</td><td>'+esc(p.entrySignal||\"BUY\")+'</td><td><a target=\"_blank\" rel=\"noopener\" href=\"https://dexscreener.com/solana/'+encodeURIComponent(p.tokenAddress||\"\")+'\">OPEN</a></td></tr>').join(\"\"):'<tr><td colspan=\"5\" class=\"muted\">No open paper positions.</td></tr>';\ndocument.getElementById(\"history\").innerHTML=history.length?history.slice(0,100).map(t=>'<tr><td>'+esc(new Date(t.exitTime||t.entryTime||t.timestamp||\"\").toLocaleString())+'</td><td>'+esc(t.symbol||\"—\")+'</td><td>'+esc(t.type)+'</td><td>'+money(t.amountInvested)+'</td><td>'+money(t.saleValue)+'</td><td class=\"'+((Number(t.netPnl??t.pnl)||0)>=0?\"positive\":\"negative\")+'\">'+money(t.netPnl??t.pnl)+'</td><td><a target=\"_blank\" rel=\"noopener\" href=\"https://dexscreener.com/solana/'+encodeURIComponent(t.tokenAddress||\"\")+'\">DEX</a></td></tr>').join(\"\"):'<tr><td colspan=\"7\" class=\"muted\">No trade records yet.</td></tr>';\ndocument.getElementById(\"status\").textContent=(s.error?\"Bot error: \"+s.error:\"Updated \"+new Date().toLocaleTimeString())+(s.error?\"\":\" · unverified locks remain rejected.\");\n}catch(e){document.getElementById(\"status\").textContent=\"Dashboard feed unavailable: \"+e.message;}}\ndocument.addEventListener(\"click\",async e=>{const b=e.target.closest(\"[data-control]\");if(b){await fetch(\"/api/\"+b.dataset.control,{method:\"POST\",headers:{\"x-bot-control\":\"1\"}});load();}if(e.target.closest(\"[data-refresh]\"))load();});\nload();setInterval(load,15000);\n</script></body></html>";
const server = http.createServer((req, res) => {
  const route = new URL(req.url, "http://" + (req.headers.host || "localhost")).pathname;
  if (route === "/healthz") return json(res, { ok: true, mode: "paper" });
  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": "Basic realm=OneCoinBot; charset=UTF-8", "cache-control": "no-store" });
    return res.end("Authentication required.");
  }
  if (route === "/api/status" && req.method === "GET") return json(res, { running: bot.getBotStatus(), error: bot.getLastError(), mode: "paper", lockThresholdPercent: 85 });
  if (route === "/api/data" && req.method === "GET") return json(res, { label: "V3.1 BUY Priority Test - 85% LP Lock", mode: "paper", lockThresholdPercent: 85, account: bot.buildDashboardAccount() });
  if ((route === "/api/start" || route === "/api/stop") && req.method === "POST") {
    if (req.headers["x-bot-control"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return json(res, { error: "Control request rejected" }, 403);
    if (route === "/api/start") bot.startBot(); else bot.stopBot();
    return json(res, { running: bot.getBotStatus() });
  }
  if (route.startsWith("/api/")) return json(res, { error: "Not found" }, 404);
  if (route !== "/" && route !== "/index.html") return json(res, { error: "Not found" }, 404);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
});
if (require.main === module) {
  bot.getPortfolio();
  bot.startBot();
  server.listen(port, host, () => console.log("85% LP-lock paper dashboard listening on " + host + ":" + port));
  const shutdown = () => { bot.stopBot(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 12000).unref(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
module.exports = { server };