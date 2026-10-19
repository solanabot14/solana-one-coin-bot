'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadIsolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-lane-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldDataDir = process.env.DATA_DIR;
  const oldVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.DATA_DIR = dir;
  for (const name of ['pumpLaneBot', 'pumpLaneTrader']) delete require.cache[require.resolve(path.join(__dirname, '..', name))];
  const dex = require('../dexscreener');
  const originalGetTokenData = dex.getTokenData;
  t.after(() => {
    dex.getTokenData = originalGetTokenData;
    for (const name of ['pumpLaneBot', 'pumpLaneTrader']) delete require.cache[require.resolve(path.join(__dirname, '..', name))];
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    if (oldVolume === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH; else process.env.RAILWAY_VOLUME_MOUNT_PATH = oldVolume;
  });
  const trader = require('../pumpLaneTrader');
  const bot = require('../pumpLaneBot');
  return { trader, bot, dex };
}

test('DexScreener fallback refreshes a stale open-position mark', async t => {
  const { trader, bot, dex } = loadIsolated(t);
  dex.getTokenData = async mint => ({ tokenAddress: mint, priceUsd: 0.95, pairAddress: 'pair' });
  assert.equal(trader.buy({ mint: 'mint', symbol: 'PELICAN', priceUsd: 1 }, Date.now() - 60 * 1000).success, true);

  assert.equal(await bot.refreshOpenPositionFromDexScreener(), true);
  const data = trader.dashboard();
  assert.equal(data.quoteAvailable, true);
  assert.equal(data.livePositions[0].currentPrice, 0.95);
  assert.ok(data.livePositions[0].pnl !== null);
});

test('DexScreener fallback applies the existing paper hard stop', async t => {
  const { trader, bot, dex } = loadIsolated(t);
  dex.getTokenData = async mint => ({ tokenAddress: mint, priceUsd: 0.70, pairAddress: 'pair' });
  assert.equal(trader.buy({ mint: 'mint', symbol: 'PELICAN', priceUsd: 1 }, Date.now() - 8 * 60 * 60 * 1000).success, true);

  assert.equal(await bot.refreshOpenPositionFromDexScreener(), true);
  const data = trader.dashboard();
  assert.equal(data.livePositions.length, 0);
  assert.equal(data.completedTradeRecords[0].reason, 'Hard stop -18%');
  assert.equal(data.history[0].reason, 'Hard stop -18%');
});
