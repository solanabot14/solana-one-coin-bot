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

function notifyTrade(event, trade, options) {
  return sendTelegramMessage(formatTradeNotification(event, trade), options);
}

function notifyCritical(message, options) {
  return sendTelegramMessage(formatCriticalNotification(message), options);
}

module.exports = {
  getTelegramConfig,
  dexscreenerLink,
  formatTradeNotification,
  formatCriticalNotification,
  sendTelegramMessage,
  notifyTrade,
  notifyCritical
};
