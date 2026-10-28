# Copy Trading Bot

Standalone paper-trading bot for Solana smart-money wallet discovery and copy-entry testing.

Safety defaults:
- Paper trading only
- Fixed simulated position size: $5
- Never uses a wallet private key
- Never submits swaps or orders
- Does not import or modify Gemini or any other bot

Wallet intelligence:
1. Pull recent Solana Smart Money activity from GMGN.
2. Extract active wallet addresses.
3. Score candidate wallets using 7d/30d performance, win rate, realized P&L, trade count/diversity, and recency.
4. Prefer wallets whose style is realistically copyable rather than merely profitable.
5. Track buys from approved wallets.
6. Paper-enter $5 at the observable market price after the leader transaction.
7. Exit each copied position on the first detected sell from the wallet that opened it.

GMGN setup:
- The bot uses the official `gmgn-cli` read-only commands.
- For initial paper testing, GMGN documents a public demo read-only key. For persistent use, set your own `GMGN_API_KEY`.
- No `GMGN_PRIVATE_KEY` is used or needed by this bot.

Run:
```bash
cd copy-trading-bot
npm install
npm start
```

Environment variables:
- `GMGN_API_KEY` optional for initial test; personal key recommended for persistent use
- `COPY_PAPER_TRADE_USD=5`
- `COPY_MAX_OPEN_POSITIONS=3`
- `COPY_POLL_MS=15000`
- `COPY_MIN_ACTIVITY_VOLUME_5M_USD=2000` (required 5-minute token volume before copying a buy)
- `COPY_MIN_ACTIVITY_SWAPS_5M=5` (required swaps in that same 5-minute window)

The recent-activity entry filter fails closed: if GMGN omits either 5-minute metric, the bot does not copy the buy. The active exit mode is **Follow wallet strategy**: one detected sell by the followed wallet closes that wallet's copied position for the token. If GMGN does not provide a valid current price during the sell, the event remains pending and is retried on the next signal poll. Take-profit, stop-loss, liquidity-drop, token-price, and inactivity rules do not automatically close open positions. The $100 token-price ceiling remains an entry filter; manual paper close remains available.

The previous exit settings are preserved by the `before-follow-wallet-strategy-2026-10-27-2236` git tag. Change record: **Follow wallet strategy** (also referred to as **exit wallet strategy**), Tuesday, October 27, 2026, 10:36 p.m. Puerto Rico time.
