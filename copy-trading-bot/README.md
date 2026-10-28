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
7. Use our own TP/SL risk rules while also recording leader-wallet sells for comparison.

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
- `COPY_TAKE_PROFIT_PCT=15`
- `COPY_STOP_LOSS_PCT=12`
- `COPY_MAX_OPEN_POSITIONS=3`
- `COPY_POLL_MS=15000`
- `COPY_MIN_ACTIVITY_VOLUME_5M_USD=2000` (required 5-minute token volume before copying a buy)
- `COPY_MIN_ACTIVITY_SWAPS_5M=5` (required swaps in that same 5-minute window)
- `COPY_INACTIVITY_EXIT_SEC=600` (close after 10 uninterrupted minutes with zero volume and zero swaps in the rolling 5-minute market data)

The recent-activity entry filter fails closed: if GMGN omits either 5-minute metric, the bot does not copy the buy. For open positions, an inactivity timer starts when both metrics report zero and resets as soon as either reports activity. The bot exits with `sustained_inactivity` after the configured period; it still needs a valid current price from GMGN to record the exit.

The exit rules are intentionally isolated in `config.js` so they can be changed after paper-trade evidence without touching wallet discovery.
