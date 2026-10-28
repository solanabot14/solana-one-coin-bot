'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-paper-engine-'));
process.env.COPY_STATE_FILE = path.join(tempDir, 'state.json');
const PaperEngine = require('./paper-engine');
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

test('Follow wallet strategy ignores price, liquidity, and inactivity changes until leader sells', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));

  marketSnapshot = () => ({ symbol: 'TEST', liquidity: '1', price: { price: '200', volume_5m: '0', swaps_5m: 0 } });
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), true);
  assert.equal(engine.closed.length, 0);
});

test('closes on the first followed-wallet sell, and retries if the exit price is unavailable', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));

  marketSnapshot = () => ({ symbol: 'TEST', price: { price: '0' } });
  assert.equal(await engine.leaderSold(wallet, token, 'sell-1'), false);
  assert.equal(engine.hasPosition(wallet, token), true);

  marketSnapshot = () => ({ symbol: 'TEST', liquidity: '40000', price: { price: '0.8' } });
  assert.equal(await engine.leaderSold(wallet, token, 'sell-1'), true);
  assert.equal(engine.hasPosition(wallet, token), false);
  assert.equal(engine.closed.at(-1).reason, 'followed_wallet_sold');
});
