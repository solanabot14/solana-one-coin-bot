'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-paper-engine-'));
process.env.COPY_STATE_FILE = path.join(tempDir, 'state.json');
const PaperEngine = require('./paper-engine');
const config = require('./config');
beforeEach(() => fs.rmSync(process.env.COPY_STATE_FILE, { force: true }));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const wallet = '11111111111111111111111111111111';
const token = 'So11111111111111111111111111111111111111112';
const activeMarket = () => ({
  address: token,
  symbol: 'TEST',
  liquidity: '50000',
  price: { price: '1', volume_5m: '2500', swaps_5m: 8 }
});
const idleMarket = () => ({
  address: token,
  symbol: 'TEST',
  liquidity: '50000',
  price: { price: '1', volume_5m: '0', swaps_5m: 0 }
});

test('reads GMGN 5-minute volume and swaps from nested price data', async () => {
  const engine = new PaperEngine({ marketFetcher: async () => activeMarket() });
  const market = await engine.market(token);
  assert.deepEqual(market.activity5m, { volumeUsd: 2500, swaps: 8 });
});

test('copies only when both recent activity thresholds pass', async () => {
  const tooQuiet = new PaperEngine({ marketFetcher: async () => ({
    symbol: 'QUIET', price: { price: '1', volume_5m: '1999', swaps_5m: 8 }
  }) });
  assert.equal(await tooQuiet.open(wallet, token, 'quiet'), null);
  assert.equal(tooQuiet.activityDiagnostics.rejected, 1);

  const tooFewSwaps = new PaperEngine({ marketFetcher: async () => ({
    symbol: 'QUIET', price: { price: '1', volume_5m: '2500', swaps_5m: 4 }
  }) });
  assert.equal(await tooFewSwaps.open(wallet, token, 'few-swaps'), null);
  assert.equal(tooFewSwaps.activityDiagnostics.rejected, 1);

  const active = new PaperEngine({ marketFetcher: async () => activeMarket() });
  const position = await active.open(wallet, token, 'active');
  assert.ok(position);
  assert.equal(position.recentSwaps5m, 8);
});

test('blocks entry when activity metrics are missing', async () => {
  const engine = new PaperEngine({ marketFetcher: async () => ({ symbol: 'UNKNOWN', price: { price: '1' } }) });
  assert.equal(await engine.open(wallet, token, 'missing'), null);
  assert.equal(engine.activityDiagnostics.unavailable, 1);
});

test('starts and resets the sustained inactivity timer, then exits after the configured duration', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  const position = await engine.open(wallet, token, 'active');
  assert.ok(position);

  marketSnapshot = idleMarket;
  await engine.evaluate();
  const opened = engine.getPosition(wallet, token);
  assert.ok(opened.inactiveSinceAt);

  opened.inactiveSinceAt = new Date(Date.now() - (config.inactivityExitSec + 5) * 1000).toISOString();
  marketSnapshot = activeMarket;
  await engine.evaluate();
  assert.equal(engine.getPosition(wallet, token).inactiveSinceAt, null);

  marketSnapshot = idleMarket;
  await engine.evaluate();
  engine.getPosition(wallet, token).inactiveSinceAt = new Date(Date.now() - (config.inactivityExitSec + 5) * 1000).toISOString();
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), false);
  assert.equal(engine.closed.at(-1).reason, 'sustained_inactivity');
});

test('does not count missing market data as sustained inactivity', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));
  marketSnapshot = idleMarket;
  await engine.evaluate();
  const position = engine.getPosition(wallet, token);
  position.inactiveSinceAt = new Date(Date.now() - (config.inactivityExitSec + 5) * 1000).toISOString();

  marketSnapshot = () => ({ symbol: 'TEST', price: { price: '1' } });
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), true);
  assert.equal(engine.getPosition(wallet, token).inactiveSinceAt, null);
});
