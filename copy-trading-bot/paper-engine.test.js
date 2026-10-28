'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-paper-engine-'));
process.env.COPY_STATE_FILE = path.join(tempDir, 'state.json');
process.env.COPY_INACTIVITY_EXIT_SEC = '600';
const PaperEngine = require('./paper-engine');
beforeEach(() => {
  fs.rmSync(process.env.COPY_STATE_FILE, { force: true });
  delete process.env.COPY_MANUAL_CLOSE_POSITIONS;
  delete process.env.COPY_MANUAL_CLOSE_WALLET;
  delete process.env.COPY_MANUAL_CLOSE_TOKEN;
});
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

test('Follow wallet strategy ignores price and liquidity changes while activity remains present', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));

  marketSnapshot = () => ({ symbol: 'TEST', liquidity: '1', price: { price: '200', volume_5m: '100', swaps_5m: 3 } });
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), true);
  assert.equal(engine.closed.length, 0);
});

test('exits after ten continuous minutes of zero activity and resets when activity returns', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));
  marketSnapshot = idleMarket;
  await engine.evaluate();
  let position = engine.getPosition(wallet, token);
  assert.ok(position.inactiveSinceAt);

  position.inactiveSinceAt = new Date(Date.now() - 605_000).toISOString();
  marketSnapshot = activeMarket;
  await engine.evaluate();
  assert.equal(engine.getPosition(wallet, token).inactiveSinceAt, null);
  assert.equal(engine.hasPosition(wallet, token), true);

  marketSnapshot = idleMarket;
  await engine.evaluate();
  position = engine.getPosition(wallet, token);
  position.inactiveSinceAt = new Date(Date.now() - 605_000).toISOString();
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), false);
  assert.equal(engine.closed.at(-1).reason, 'sustained_inactivity');
});

test('missing activity data resets the inactivity timer instead of forcing an exit', async () => {
  let marketSnapshot = activeMarket;
  const engine = new PaperEngine({ marketFetcher: async () => marketSnapshot() });
  assert.ok(await engine.open(wallet, token, 'active'));
  marketSnapshot = idleMarket;
  await engine.evaluate();
  engine.getPosition(wallet, token).inactiveSinceAt = new Date(Date.now() - 605_000).toISOString();
  marketSnapshot = () => ({ symbol: 'TEST', price: { price: '1' } });
  await engine.evaluate();
  assert.equal(engine.hasPosition(wallet, token), true);
  assert.equal(engine.getPosition(wallet, token).inactiveSinceAt, null);
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

test('manually closes every listed paper position and frees the corresponding slots', async () => {
  const secondToken = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const thirdToken = 'So11111111111111111111111111111111111111113';
  const engine = new PaperEngine({ marketFetcher: async () => activeMarket() });
  assert.ok(await engine.open(wallet, token, 'one'));
  assert.ok(await engine.open(wallet, secondToken, 'two'));
  assert.ok(await engine.open(wallet, thirdToken, 'three'));
  process.env.COPY_MANUAL_CLOSE_POSITIONS = JSON.stringify([
    { wallet, token },
    { wallet, token: secondToken },
    { wallet, token: thirdToken }
  ]);
  await engine.evaluate();
  delete process.env.COPY_MANUAL_CLOSE_POSITIONS;
  assert.equal(engine.positions.size, 0);
  assert.equal(engine.closed.length, 3);
  assert.ok(engine.closed.every(trade => trade.reason === 'manual_close'));
});
