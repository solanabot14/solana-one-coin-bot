# Stock Bot

An isolated $100 local paper ledger in the shared dashboard at `/trading/stock`.
It reads Alpaca stock market data and market clock using GET requests only.
It never submits orders to Alpaca, including its paper brokerage account.

## Connect market data

Create an Alpaca paper account and generate paper API credentials. Set these
in the existing dashboard service's Railway Variables panel:

- `ALPACA_PAPER_API_KEY`
- `ALPACA_PAPER_SECRET_KEY`

Do not paste credentials into chat or commit them. Redeploy after configuration.
Without credentials, the dashboard shows the $100 ledger and a waiting status;
it makes no market data requests and cannot trade. A successful authenticated
market-clock request is required before the connection reports connected.

## Experimental strategy

- Watch SPY, QQQ, AAPL, MSFT, AMZN, GOOGL, META, NVDA.
- Three maximum positions, $10 notional each; no borrowing or compounding.
- Require previous close and current price above the 20 completed day average.
- Require current price 0.5–5% below the highest high of the last five completed
  days and above previous close, with a fresh bullish minute bar.
- Fresh bid/ask (at most two minutes old) and entry spread at most 0.2%.
- Exit all at +4%, trigger a stop at -2%, or trail 1.5% from the monitored high
  after a +2% gain. Trail activation remains armed as the price falls.
- Exit after five calendar days at the next available regular-session quote.
- Prevent duplicate open symbols and same-day reentry after a close.
- Poll every minute while enabled; daily history cached per New York date.
- Use Alpaca market clock for weekends, holidays and shortened sessions.

IEX is one exchange, not consolidated US market coverage. Daily bars and quotes
use IEX consistently. Entry fills use ask plus 0.05% slippage; exits use bid
minus 0.05% slippage. An illustrative 0.01% fee allowance applies to each side.
These are simulation assumptions, not a broker fee schedule or execution promise.
All reported ledger P&L already includes these costs.

Stops are triggers, not guaranteed loss limits. Overnight gaps, halts, stale
quotes and polling delays can produce larger losses. Positions stay open when
the market is closed or fresh quotes are unavailable. No backtest or live
performance claim has been made; this is a first strategy for forward testing.

## Persistence and checks

State is atomically saved in `stock-paper-state.json` on the existing persistent
volume. Saved invalid state is rejected, never silently reset. The other bots'
ledgers and trading modules are unchanged.

`node --test test/stock-bot.test.js`

Tests cover missing credentials, fractional sizing, position limits, duplicate
prevention, cash/P&L reconciliation, restoration, gap losses, persistent trail
activation, closed market and stale data. Dashboard controls inherit existing
authentication, POST and same-origin checks. Close-all uses fresh regular-session
stock quotes and reports failure rather than inventing a fill.
