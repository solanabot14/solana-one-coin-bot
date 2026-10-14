"use strict";
const fs = require("node:fs");
const path = require("node:path");
const files = ["v31BuyPriorityLock85TradingData.json", "v31BuyPriorityLock85ReentryState.json", "launchSniperPaperTradingData.json", "launchSniperPaperReentryState.json", "wallet-copy-decu-state.json"];
const retiredKeys = ["buy-lock85", "launch-sniper", "wallet-copy"];
function purgeLocalData(directories = [__dirname, "/data", process.env.RAILWAY_VOLUME_MOUNT_PATH, process.env.DATA_DIR, process.env.WALLET_COPY_DATA_DIR]) {
  let removed = 0, bytes = 0;
  for (const dir of new Set(directories.filter(Boolean).map(d => path.resolve(d)))) {
    for (const name of files) for (const suffix of ["", ".tmp", ".bak", ".backup"]) {
      const file = path.join(dir, name + suffix);
      try { bytes += fs.statSync(file).size; fs.unlinkSync(file); removed++; }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    const historyFile = path.join(dir, "dashboard-equity-history.json");
    try {
      const rows = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      let changed = false;
      for (const row of rows) {
        if (!row.values) continue;
        let removedValue = false;
        for (const key of retiredKeys) if (Object.hasOwn(row.values, key)) { delete row.values[key]; removedValue = changed = true; }
        // An old combined total includes retired balances. Hide it rather than inventing a comparable total.
        if (removedValue) delete row.values.total;
      }
      if (changed) {
        fs.writeFileSync(historyFile + ".tmp", JSON.stringify(rows), { mode: 0o600 });
        fs.renameSync(historyFile + ".tmp", historyFile);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  console.log("RETIRED BOT CLEANUP | deleted files: " + removed + " | bytes freed: " + bytes);
  return { removed, bytes };
}
async function removeWalletWebhook(env = process.env, request = fetch) {
  if (!env.HELIUS_API_KEY) { console.log("RETIRED WEBHOOK CLEANUP | no Helius key configured"); return; }
  try {
    const base = "https://api.helius.xyz/v0/webhooks";
    const key = "?api-key=" + encodeURIComponent(env.HELIUS_API_KEY);
    const response = await request(base + key, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error("lookup HTTP " + response.status);
    const hooks = await response.json();
    if (!Array.isArray(hooks)) throw Error("invalid webhook list");
    let removed = 0;
    const target = env.WALLET_COPY_WEBHOOK_URL || "https://solana-one-coin-bot-production.up.railway.app/api/wallet-copy/webhook";
    for (const hook of hooks) {
      if (hook.webhookURL !== target || !Array.isArray(hook.accountAddresses) || hook.accountAddresses.length !== 1 || hook.accountAddresses[0] !== "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9") continue;
      const id = hook.webhookID || hook.webhookId;
      if (!id) throw Error("missing webhook ID");
      const deletion = await request(base + "/" + encodeURIComponent(id) + key, { method: "DELETE", signal: AbortSignal.timeout(12000) });
      if (!deletion.ok && deletion.status !== 404) throw Error("delete HTTP " + deletion.status);
      removed++;
    }
    console.log("RETIRED WEBHOOK CLEANUP | removed: " + removed + " | matching subscriptions remaining: 0");
  } catch (e) { console.error("RETIRED WEBHOOK CLEANUP | incomplete: " + e.message); }
}
module.exports = { purgeLocalData, removeWalletWebhook };
