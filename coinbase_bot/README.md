# Coinbase Bot

Isolated Coinbase Advanced Trade spot momentum bot workspace. Default mode is paper. Do not enable live trading until fee tier, order protection, and seven-day paper results are reviewed.

This folder is intentionally not wired into the shared dashboard or Railway service. No other bot or shared file is changed.

## Account setup

Create a dedicated Coinbase CDP key for this bot with trade/read permissions only and withdrawals disabled. Put credentials in environment variables, never in source:

    export COINBASE_API_KEY='organizations/.../apiKeys/...'
    export COINBASE_API_SECRET='...'
    export LIVE=false

The fee config contains low-volume estimates (0.40% maker, 0.60% taker). Before spread/slippage, round-trip estimates are 0.80% maker/maker and 1.20% taker/taker. A three-times-fee hurdle is 2.40% and 3.60%, respectively.

## Implementation and safety status

This branch currently contains the paper-first strategy configuration and setup notes only. It does not place orders and does not affect the running dashboard bot. The implementation must use Coinbase's official Python package, coinbase-advanced-py, and a bot-local rate limiter. Verify spot protective stop behavior in the Coinbase sandbox before relying on exchange-side stops. If a protective stop cannot be safely attached, keep the bot paper-only.

## Test gate

1. Verify the actual fee tier with the dedicated API key.
2. Verify supported stop order behavior in Coinbase sandbox.
3. Backtest on Coinbase 1m/5m candles with explicit fee/slippage.
4. Paper trade continuously for at least seven days.
5. Review net after-fee return, win rate, average win/loss, profit factor, and drawdown.

Never set LIVE=true before review and explicit approval of results.
