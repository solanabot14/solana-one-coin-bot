'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPumpLaneFreeFeed, decodeCurveAccount, parseTradeTransaction } = require('../pumpLaneFreeFeed');

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
