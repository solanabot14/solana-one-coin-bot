"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { purgeLocalData, removeWalletWebhook } = require("../retiredBotCleanup");
test("retirement deletes only dedicated data and removes retired equity without changing other accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retired-bots-"));
  try {
    fs.writeFileSync(path.join(dir, "wallet-copy-decu-state.json"), "{}");
    fs.writeFileSync(path.join(dir, "launchSniperPaperTradingData.json"), "{}");
    fs.writeFileSync(path.join(dir, "v31BuyPriorityLock85TradingData.json"), "{}");
    fs.writeFileSync(path.join(dir, "profitSniperTradingData.json"), "keep exactly");
    fs.writeFileSync(path.join(dir, "dashboard-equity-history.json"), JSON.stringify([{ time: "old", values: { total: 120, "buy-lock85": 5, "launch-sniper": 5, "wallet-copy": 10, v31: 100 } }]));
    assert.equal(purgeLocalData([dir]).removed, 3);
    assert.equal(fs.readFileSync(path.join(dir, "profitSniperTradingData.json"), "utf8"), "keep exactly");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "dashboard-equity-history.json")))[0].values, { v31: 100 });
    assert.equal(purgeLocalData([dir]).removed, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("webhook cleanup removes only the exact dedicated wallet subscription", async () => {
  const target = "https://solana-one-coin-bot-production.up.railway.app/api/wallet-copy/webhook";
  const wallet = "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9";
  const deleted = [];
  await removeWalletWebhook({ HELIUS_API_KEY: "test" }, async (url, opts) => {
    if (opts.method === "DELETE") { deleted.push(url); return { ok: true }; }
    return { ok: true, json: async () => [
      { webhookID: "dedicated", webhookURL: target, accountAddresses: [wallet] },
      { webhookID: "shared", webhookURL: target, accountAddresses: [wallet, "another"] },
      { webhookID: "other-bot", webhookURL: "https://other.test", accountAddresses: [wallet] }
    ] };
  });
  assert.deepEqual(deleted, ["https://api.helius.xyz/v0/webhooks/dedicated?api-key=test"]);
});
test("shared Profit Sniper discovery imports without instantiating retired trader or timers", () => {
  const source = fs.readFileSync(path.join(__dirname, "../poolDiscovery.js"), "utf8");
  assert.doesNotMatch(source, /createPaperTrader|createBot|statePath|setInterval/);
  const discovery = require("../poolDiscovery");
  assert.equal(typeof discovery.discoverLaunchCandidates, "function");
  assert.equal(typeof discovery.getScanDiagnostics, "function");
});
