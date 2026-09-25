const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getTelegramConfig,
  formatTradeNotification,
  sendTelegramMessage
} = require("../telegram");

test("Telegram is disabled when either environment variable is missing", () => {
  assert.equal(getTelegramConfig({}).enabled, false);
  assert.equal(getTelegramConfig({ TELEGRAM_BOT_TOKEN: "token" }).enabled, false);
  assert.equal(getTelegramConfig({ TELEGRAM_CHAT_ID: "123" }).enabled, false);
  assert.equal(getTelegramConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "123"
  }).enabled, true);
});

test("BUY notification contains available trade details and DexScreener link", () => {
  const text = formatTradeNotification("BUY", {
    symbol: "TEST",
    entryPrice: 0.001,
    amountInvested: 10,
    quantity: 10000,
    tokenAddress: "token-address"
  });

  assert.match(text, /ONE COIN BOT \| BUY/);
  assert.match(text, /Coin: TEST/);
  assert.match(text, /Entry: \$0.001/);
  assert.match(text, /Amount bought: \$10.00/);
  assert.match(text, /dexscreener\.com\/solana\/token-address/);
});

test("SELL notification contains P\/L, percentage and exit reason", () => {
  const text = formatTradeNotification("TAKE PROFIT 1", {
    symbol: "TEST",
    entryPrice: 1,
    exitPrice: 1.15,
    saleValue: 2.875,
    pnl: 0.375,
    pnlPercent: 15,
    reason: "TAKE PROFIT 1",
    pairAddress: "pair-address"
  });

  assert.match(text, /Sell price: \$1.15/);
  assert.match(text, /Amount sold: \$2.88/);
  assert.match(text, /P\/L: \$0.38/);
  assert.match(text, /P\/L %: 15.00%/);
  assert.match(text, /Exit reason: TAKE PROFIT 1/);
  assert.match(text, /dexscreener\.com\/solana\/pair-address/);
});

test("disabled Telegram performs no network request", async () => {
  let called = false;
  const result = await sendTelegramMessage("test", {
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error("should not run");
    }
  });

  assert.equal(called, false);
  assert.deepEqual(result, { sent: false, reason: "disabled" });
});

test("Telegram network failure is contained and never throws into trading code", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await sendTelegramMessage("test", {
      env: {
        TELEGRAM_BOT_TOKEN: "fake-token",
        TELEGRAM_CHAT_ID: "123"
      },
      fetchImpl: async () => {
        throw new Error("network unavailable");
      }
    });

    assert.equal(result.sent, false);
    assert.match(result.reason, /network unavailable/);
  } finally {
    console.error = originalError;
  }
});

test("Telegram request uses environment credentials and expected chat id", async () => {
  let request;
  const result = await sendTelegramMessage("hello", {
    env: {
      TELEGRAM_BOT_TOKEN: "fake-token",
      TELEGRAM_CHAT_ID: "987654"
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        text: async () => ""
      };
    }
  });

  assert.equal(result.sent, true);
  assert.match(request.url, /botfake-token\/sendMessage$/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.chat_id, "987654");
  assert.equal(body.text, "hello");
});
