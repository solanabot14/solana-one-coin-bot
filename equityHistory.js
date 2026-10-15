"use strict";
const fs = require("node:fs");
const path = require("node:path");
function createEquityHistory(file = path.join(process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname), 'dashboard-equity-history.json')) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(rows)) rows = []; } catch (_) {}
  function record(values, now = Date.now()) {
    if (rows.length && now - Date.parse(rows.at(-1).time) < 300000) return rows;
    const known = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    if (!Object.keys(known).length) return rows;
    const next = [...rows, { time: new Date(now).toISOString(), values: known }].filter(r => now - Date.parse(r.time) <= 90 * 86400000).slice(-26000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    rows = next;
    return rows;
  }
  return { record, getRows: () => rows };
}
module.exports = { createEquityHistory };
