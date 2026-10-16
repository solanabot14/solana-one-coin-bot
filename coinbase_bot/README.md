# Coinbase Bot

The existing Coinbase Bot runs as a paper simulator in `outcomeBot.js`. Its dashboard records simulated Coinbase spot positions. This branch changes only the Coinbase module, its dedicated tests, and this documentation/configuration folder.

## Current execution boundary

The bot uses Coinbase Exchange public REST market data. It does not use the Coinbase Advanced Trade SDK, private account endpoints, your fee tier, WebSocket feeds, authenticated orders, or exchange-side protective stops. The simulated entry/exit fills include configured fee and slippage estimates. Setting `LIVE=true` does not enable live orders; there is no live order path in this module.

The YAML file documents the JavaScript runtime settings; it is not loaded by the bot. Environment overrides currently supported:

- `OUTCOME_PAPER_FEE_RATE` (default 0.006 per side)
- `OUTCOME_PAPER_SLIPPAGE_RATE` (default 0.001 per side)
- `DATA_DIR` or `RAILWAY_VOLUME_MOUNT_PATH` (paper state storage)

## Changes in this branch

- Position size is constrained to 5%–10% of current estimated paper equity.
- Daily realized-loss pause is 3% of start-of-day equity.
- Breakout entries require a retest and confirmation candle; a simple resistance close no longer qualifies.
- Coinbase public REST requests are paced to 5 per second with bounded 429 retries.
- Previously open positions keep their legacy exit rules; V4 rules apply to new entries.

## Verification and rollout

Run the focused tests with `node --test test/outcome-bot.test.js`. This does not place orders.

Keep the running service unchanged during the seven-day paper review. Before any live implementation, verify the actual account fee tier, supported protective order behavior, API key permissions, backtest costs, and seven-day net results. Any integration or deployment must be reviewed separately before it goes live.
