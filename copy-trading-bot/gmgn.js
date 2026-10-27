'use strict';

const { spawn } = require('node:child_process');
const config = require('./config');

function runGmgn(args) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['--no-install', 'gmgn-cli', ...args, '--raw'], {
      env: {
        ...process.env,
        GMGN_API_KEY: process.env.GMGN_API_KEY || config.demoReadOnlyApiKey
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`gmgn-cli failed (${code}): ${err || out}`));
      const text = out.trim();
      try {
        resolve(JSON.parse(text));
      } catch {
        const line = text.split(/\r?\n/).filter(Boolean).at(-1);
        try { resolve(JSON.parse(line)); }
        catch { reject(new Error(`Could not parse gmgn-cli JSON: ${text.slice(0, 500)}`)); }
      }
    });
  });
}

function flatten(value, rows = []) {
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, rows);
  } else if (value && typeof value === 'object') {
    rows.push(value);
    for (const v of Object.values(value)) flatten(v, rows);
  }
  return rows;
}

function firstNumber(obj, keys) {
  const rows = flatten(obj);
  for (const row of rows) {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
        const n = Number(row[key]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

function firstString(obj, keys) {
  const rows = flatten(obj);
  for (const row of rows) {
    for (const key of keys) {
      if (typeof row[key] === 'string' && row[key]) return row[key];
    }
  }
  return null;
}

module.exports = { runGmgn, flatten, firstNumber, firstString };
