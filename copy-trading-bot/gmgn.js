'use strict';

const { spawn } = require('node:child_process');
const config = require('./config');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let pending = [];
let queueBusy = false;
let nextAllowedAt = 0;

function execGmgn(args) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['--no-install', 'gmgn-cli', ...args, '--raw'], {
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || config.demoReadOnlyApiKey },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`gmgn-cli failed (${code}): ${err || out}`));
      const text = out.trim();
      try { resolve(JSON.parse(text)); }
      catch {
        const line = text.split(/\r?\n/).filter(Boolean).at(-1);
        try { resolve(JSON.parse(line)); }
        catch { reject(new Error(`Could not parse gmgn-cli JSON: ${text.slice(0, 500)}`)); }
      }
    });
  });
}

function parseResetAt(message) {
  const match = String(message || '').match(/resets at ([0-9-]{10}) ([0-9:]{8}) GMT\+00:00/i);
  if (!match) return null;
  const t = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(t) ? t : null;
}

async function runWithBackoff(args) {
  if (Date.now() < nextAllowedAt) await sleep(nextAllowedAt - Date.now());
  try {
    const result = await execGmgn(args);
    nextAllowedAt = Math.max(nextAllowedAt, Date.now() + 2500);
    return result;
  } catch (error) {
    const msg = String(error && error.message || error);
    if (/429|RATE_LIMIT/i.test(msg)) {
      const resetAt = parseResetAt(msg) || Date.now() + 120000;
      nextAllowedAt = Math.max(nextAllowedAt, resetAt + 5000);
      console.error(`[gmgn backoff] paused until ${new Date(nextAllowedAt).toISOString()}`);
      await sleep(Math.max(0, nextAllowedAt - Date.now()));
      const result = await execGmgn(args);
      nextAllowedAt = Date.now() + 2500;
      return result;
    }
    throw error;
  }
}

function pumpQueue() {
  if (queueBusy || !pending.length) return;
  queueBusy = true;
  const job = pending.shift();
  runWithBackoff(job.args).then(job.resolve, job.reject).finally(() => {
    queueBusy = false;
    pumpQueue();
  });
}

function runGmgn(args, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const job = { args, resolve, reject };
    if (priority) {
      const firstNormal = pending.findIndex(item => !item.priority);
      job.priority = true;
      if (firstNormal < 0) pending.push(job);
      else pending.splice(firstNormal, 0, job);
    } else {
      job.priority = false;
      pending.push(job);
    }
    pumpQueue();
  });
}

function flatten(value, rows = []) {
  if (Array.isArray(value)) for (const v of value) flatten(v, rows);
  else if (value && typeof value === 'object') { rows.push(value); for (const v of Object.values(value)) flatten(v, rows); }
  return rows;
}

function firstNumber(obj, keys) {
  const rows = flatten(obj);
  for (const row of rows) for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
    const n = Number(row[key]); if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(obj, keys) {
  const rows = flatten(obj);
  for (const row of rows) for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key];
  return null;
}

module.exports = { runGmgn, flatten, firstNumber, firstString };
