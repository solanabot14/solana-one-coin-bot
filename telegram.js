const TELEGRAM_API = "https://api.telegram.org";

function getTelegramConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();
  return { token, chatId, enabled: Boolean(token && chatId) };
}

function number(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return "$" + n.toFixed(2);
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2) + "%";
}

function dexscreenerLink(trade = {}) {
  const id = trade.pairAddress || trade.tokenAddress;
  return id ? `https://dexscreener.com/solana/${encodeURIComponent(id)}` : null;
}

function formatTradeNotification(event, trade = {}) {
  const lines = [`ONE COIN BOT | ${event}`];

  if (trade.symbol) lines.push(`Coin: ${trade.symbol}`);
  if (Number.isFinite(Number(trade.entryPrice))) {
    lines.push(`Entry: $${number(trade.entryPrice, 10)}`);
  }

  const currentPrice =
    trade.exitPrice ??
    trade.currentPrice ??
    trade.priceUsd;

  if (Number.isFinite(Number(currentPrice))) {
    lines.push(`${event === "BUY" ? "Price" : "Sell price"}: $${number(currentPrice, 10)}`);
  }

  if (event === "BUY") {
    if (Number.isFinite(Number(trade.amountInvested))) {
      lines.push(`Amount bought: ${money(trade.amountInvested)}`);
    }
    if (Number.isFinite(Number(trade.quantity))) {
      lines.push(`Quantity: ${number(trade.quantity, 8)}`);
    }
  } else {
    if (Number.isFinite(Number(trade.saleValue))) {
      lines.push(`Amount sold: ${money(trade.saleValue)}`);
    } else if (Number.isFinite(Number(trade.quantitySold))) {
      lines.push(`Quantity sold: ${number(trade.quantitySold, 8)}`);
    }
    if (Number.isFinite(Number(trade.pnl))) {
      lines.push(`P/L: ${money(trade.pnl)}`);
    }
    if (Number.isFinite(Number(trade.pnlPercent))) {
      lines.push(`P/L %: ${percent(trade.pnlPercent)}`);
    }
    if (trade.reason) lines.push(`Exit reason: ${trade.reason}`);
  }

  const link = dexscreenerLink(trade);
  if (link) lines.push(`DexScreener: ${link}`);

  return lines.join("\n");
}

function formatCriticalNotification(message) {
  return [
    "ONE COIN BOT | CRITICAL ERROR",
    String(message || "The bot stopped unexpectedly.")
  ].join("\n");
}

async function sendTelegramMessage(text, {
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { token, chatId, enabled } = getTelegramConfig(env);
  if (!enabled) return { sent: false, reason: "disabled" };
  if (typeof fetchImpl !== "function") return { sent: false, reason: "fetch unavailable" };

  try {
    const response = await fetchImpl(
      `${TELEGRAM_API}/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(
        "Telegram notification failed:",
        `HTTP ${response.status}`,
        body.slice(0, 200)
      );
      return { sent: false, reason: `HTTP ${response.status}` };
    }

    return { sent: true };
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
    return { sent: false, reason: error.message };
  }
}

// Suppress automatic bot entries; keep sale and profit updates plus personal Gemini Buy signals.
function notifyTrade(event, trade, options) {
  const normalizedEvent = String(event || "").trim().toUpperCase();
  if (normalizedEvent === "BUY" || normalizedEvent.startsWith("BUY ")) {
    return Promise.resolve({ sent: false, reason: "automatic bot buy notifications muted" });
  }
  return sendTelegramMessage(formatTradeNotification(event, trade), options);
}

function notifyCritical(message, options) {
  return sendTelegramMessage(formatCriticalNotification(message), options);
}


function formatGeminiBuyAlert(signalId, candidate = {}, amountUsd = 0, expiresInSeconds = 120) {
  const lines = [
    "GEMINI | BUY SIGNAL",
    "Coin: " + String(candidate.symbol || candidate.name || "Unknown"),
    "Suggested live size: $" + Number(amountUsd || 0).toFixed(2),
    "Price: $" + number(candidate.priceUsd, 10),
    "Liquidity: $" + number(candidate.liquidityUsd, 2),
    "5m change: " + percent(candidate.priceChange5m),
    "5m buys/sells: " + Number(candidate.buys5m || 0) + "/" + Number(candidate.sells5m || 0),
    "Pool: PumpSwap verified",
    "Expires in " + expiresInSeconds + " seconds",
    "This button authorizes only this one buy. Gemini will not enter a position unless you tap Buy.",
    "Gemini will manage exits for a position you authorize."
  ];
  lines.push("Mint: " + String(candidate.tokenAddress || ""));
  const link = dexscreenerLink(candidate);
  if (link) lines.push("Chart: " + link);
  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [[{
        text: "BUY $" + Number(amountUsd || 0).toFixed(2) + " · Gemini manages exits",
        callback_data: "gbuy:" + signalId
      }]]
    }
  };
}

async function sendGeminiBuyAlert(signalId, candidate, amountUsd, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  expiresInSeconds = 120
} = {}) {
  const { token, chatId, enabled } = getTelegramConfig(env);
  if (!enabled) return { sent: false, reason: "Telegram is not configured" };
  if (typeof fetchImpl !== "function") return { sent: false, reason: "fetch unavailable" };
  try {
    const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...formatGeminiBuyAlert(signalId, candidate, amountUsd, expiresInSeconds), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      console.error("Telegram Gemini signal failed:", `HTTP ${response.status}`, String(result.description || "").slice(0, 200));
      return { sent: false, reason: result.description || `HTTP ${response.status}` };
    }
    return { sent: true, messageId: result.result?.message_id ?? null };
  } catch (error) {
    console.error("Telegram Gemini signal failed:", error.message);
    return { sent: false, reason: error.message };
  }
}

function startTelegramBuyPolling(onBuy, {
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { token, chatId, enabled } = getTelegramConfig(env);
  if (!enabled || typeof fetchImpl !== "function" || typeof onBuy !== "function") return () => {};
  let stopped = false;
  let offset = 0;
  const api = (method) => `${TELEGRAM_API}/bot${token}/${method}`;
  async function request(method, payload) {
    const response = await fetchImpl(api(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.description || `Telegram HTTP ${response.status}`);
    return body.result;
  }
  async function handleCallback(query) {
    const chat = query?.message?.chat;
    const authorized = chat?.type === "private" &&
      String(chat.id) === chatId &&
      String(query?.from?.id) === chatId;
    const match = /^gbuy:([0-9a-f-]{36})$/i.exec(String(query?.data || ""));
    if (!authorized || !match) {
      await request("answerCallbackQuery", { callback_query_id: query.id, text: "This buy action is not available for this account.", show_alert: true }).catch(() => {});
      return;
    }
    await request("answerCallbackQuery", { callback_query_id: query.id, text: "Checking the signal and preparing the order..." }).catch(() => {});
    let result;
    try {
      result = await onBuy(match[1]);
    } catch (error) {
      result = { success: false, message: error.message || "The buy could not be completed." };
    }
    if (query.message?.message_id) {
      await request("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
    }
    if (result?.message) await sendTelegramMessage(result.message, { env, fetchImpl });
  }
  async function run() {
    while (!stopped) {
      try {
        const updates = await request("getUpdates", { offset, timeout: 5, allowed_updates: ["callback_query"] });
        for (const update of Array.isArray(updates) ? updates : []) {
          offset = Math.max(offset, Number(update.update_id) + 1);
          if (update.callback_query) await handleCallback(update.callback_query);
        }
      } catch (error) {
        if (!stopped) {
          console.warn("Telegram buy-button polling failed:", error.message);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
  }
  void run();
  return () => { stopped = true; };
}

module.exports = {
  getTelegramConfig,
  dexscreenerLink,
  formatTradeNotification,
  formatCriticalNotification,
  sendTelegramMessage,
  notifyTrade,
  notifyCritical,
  formatGeminiBuyAlert,
  sendGeminiBuyAlert,
  startTelegramBuyPolling
};
