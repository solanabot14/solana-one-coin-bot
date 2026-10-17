'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPumpLaneFreeFeed, decodeCurveAccount, parsePumpTradeLogs, parseTradeTransaction } = require('../pumpLaneFreeFeed');

test('decodes Pump bonding curve reserves and derives progress', () => {
  const data = Buffer.alloc(49);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  data.writeBigUInt64LE(72_500_000_000n, 16);
  data.writeBigUInt64LE(200_000_000_000_000n, 24);
  data.writeBigUInt64LE(42_500_000_000n, 32);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  data[48] = 0;
  const curve = decodeCurveAccount(data.toString('base64'));
  assert.equal(curve.bondingProgress, 50);
  assert.equal(curve.marketCapSol, 72.5);
  assert.equal(curve.graduated, false);
});

test('identifies a token buy and seller from parsed transaction balances', () => {
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: 'wallet-a', signer: true }] } },
    meta: {
      err: null,
      preTokenBalances: [{ mint: 'mint-a', owner: 'wallet-a', uiTokenAmount: { amount: '0', decimals: 6 } }],
      postTokenBalances: [{ mint: 'mint-a', owner: 'wallet-a', uiTokenAmount: { amount: '2500000', decimals: 6 } }]
    }
  };
  assert.deepEqual(parseTradeTransaction(tx, 'sig-a'), {
    mint: 'mint-a', trader: 'wallet-a', type: 'buy', tokenAmount: 2.5, signature: 'sig-a'
  });
  tx.meta.preTokenBalances = [{ mint: 'mint-a', owner: 'wallet-a', uiTokenAmount: { amount: '2500000', decimals: 6 } }];
  tx.meta.postTokenBalances = [];
  assert.equal(parseTradeTransaction(tx, 'sig-b').type, 'sell');
});

test('decodes Pump.fun TradeEvent logs without an HTTP transaction lookup', () => {
  const { createHash } = require('node:crypto');
  const data = Buffer.alloc(113);
  createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8).copy(data, 0);
  data.writeBigUInt64LE(2_500_000_000n, 40);
  data.writeBigUInt64LE(12_500_000n, 48);
  data[56] = 1;
  data.writeBigUInt64LE(115_000_000_000n, 97);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 105);
  const mint = Buffer.alloc(32), trader = Buffer.alloc(32); trader[31] = 1;
  mint.copy(data, 8); trader.copy(data, 57);
  const decoded = parsePumpTradeLogs([`Program data: ${data.toString('base64')}`], '1'.repeat(32), 'sig-test');
  assert.deepEqual(decoded, {
    mint: '1'.repeat(32), trader: `${'1'.repeat(31)}2`, type: 'buy',
    tokenAmount: 12.5, solAmount: 2.5,
    virtualSolReserves: 115_000_000_000, virtualTokenReserves: 1_000_000_000_000_000,
    signature: 'sig-test'
  });
});

test('free feed uses public Solana WebSocket when no Helius key is available', () => {
  let url;
  class FakeSocket {
    constructor(value) { url = value; this.readyState = 0; }
    addEventListener() {}
    close() {}
  }
  const feed = createPumpLaneFreeFeed({ apiKey: '', WebSocketImpl: FakeSocket });
  feed.start();
  assert.equal(url, 'wss://api.mainnet.solana.com');
  feed.stop();
});
