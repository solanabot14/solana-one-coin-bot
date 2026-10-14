# Stock Bot — Intraday Opportunity

An isolated $100 local paper ledger in the shared dashboard at `/trading/stock`.
Alpaca IEX quotes, 5-minute bars and its market clock drive the simulation.
GET requests only: no broker orders, no live trades, options, shorts or borrowing.

## Connection

The existing dashboard Railway service uses `ALPACA_PAPER_API_KEY` and
`ALPACA_PAPER_SECRET_KEY`. Never commit or paste these into chat.
Without credentials it shows a waiting status and makes no market requests.
The ledger is distinct from Alpaca's default simulated brokerage balance.

## Entry rules

- Scan a fixed 60-symbol universe of actively traded stocks and unleveraged ETFs.
  This is a watchlist scanner, not a whole-market or news scanner.
- Use at least three completed consecutive 5-minute bars from today's regular
  session. The first possible signal is approximately 15 minutes after opening.
- Require a fresh bid/ask with spread <= 0.25%; completed bars remain current for five minutes plus
  two minutes of publication/cache allowance after their closing timestamp. Never use an incomplete candle.
- Require +0.3% to +8% from session opening price, above session VWAP and at most
  3% above VWAP; bullish signal candle with <= 2% gain.
- Require signal bar volume >= 1.2x the preceding up to five bars' average and >= $25k
  traded value on IEX. Volume is from this exchange, not total US volume.
- BREAKOUT: signal close exceeds the previous up to five bars' highs.
- PULLBACK RECOVERY: previous bar closes below its predecessor, dip is 0.2–2%
  below the preceding peak, and signal bar closes above previous bar's high.
- Current quote must hold within 0.1% of the signal close or higher.
- Rank qualifying signals by relative volume and session price movement.
- Three positions maximum, $10 starting notional; keep unused cash available.
- Increase next entry size 10% after each net winning completed position, capped
  at $20 and 20% of marked account equity. Reset to $10 after a net loss. Partial
  profit alone does not increase size; use total net P&L after final exit.
- No duplicate open symbols. Reentry after 5 minutes for net winners, 15 minutes
  for losses; maximum six entries per symbol per New York session date.

## Exits and session control

- Sell 50% of original quantity at +1%; initial loss exit trigger remains -0.8%.
- After the partial sale, trail the remainder 0.75% below the monitored high,
  with an exit trigger no lower than modeled cost-adjusted break-even plus a
  small buffer. There is no early full-position trail before the partial target.
  Gaps/delays can still execute below any trigger; protection is not guaranteed.
- Maximum holding time 60 minutes.
- Stop new entries 30 minutes before the market clock's actual closing time.
- Begin closing all positions 10 minutes before close; includes half days.
- Pause entries at <= -$3 realized plus marked unrealized P&L for that session.
  Existing positions continue to be monitored and exited.
- Monitor every 15 seconds; refresh entry bars no more than once per minute.
- Use market clock and New York timezone for holidays, weekends and DST.
- If a halt, stale quote, outage or stopped process prevents a session exit,
  report the pending exit and retry at next available regular-session quote.
  Never invent a fill or silently remove the position. Previous-session positions
  exit first when the next session opens.

## Simulation and persistence

Entry uses ask plus 0.05% slippage; exit uses bid minus 0.05% slippage.
An illustrative 0.01% fee allowance applies on each side. Reported ledger P&L
already includes these assumptions, which are not a broker fee schedule.
IEX covers one exchange; fills and stop prices are not guaranteed. Neither
profitability nor always being flat by the bell is guaranteed during outages.

Atomic state persists in `stock-paper-state.json` on the existing volume.
Existing $100 cash, positions and history are preserved, never reset. Other
bots' trading modules and accounts are unchanged.

`node --test test/stock-bot.test.js`

Tests cover sizing and accounting, breakouts and pullback recovery, stale/partial
bars, duplicates, cooldown and daily entry caps, persistent trailing activation,
loss pause, regular/half-day flatten, DST, unresolved exit recovery, and restore.
This strategy is for forward testing; no profitable backtest is claimed.

## Premarket research

From 4am to 9:30am New York time on actual trading days, analyze all 60 symbols
once per minute using consolidated SIP historical 5-minute bars. End requests
16 minutes behind current time to respect the free plan's recent-data restriction.
Only completed bars before that cutoff are included; actual data age is displayed.
Cache previous daily closes once per session. Rank gaps, premarket movement and
traded value, and show session VWAP, high/low and an SPY benchmark gap in the API.
The overview displays the ten highest-ranked symbols with delayed prices and age.

This analysis is research only. It never creates premarket orders or uses delayed
prices as current execution quotes. After opening, positive premarket watch
candidates receive a small ranking preference only after all fresh intraday
entry rules qualify; no entry gate is bypassed. Research errors are explicit and
never block regular-session monitoring. Holidays/weekends skip today's research
when the market clock says the next opening is on another date. The latest
research session date remains visible; old research is not reused on a new day.

Two additional tests cover ranking, delayed cutoff, research-only behavior,
refresh throttling and holiday handling. No paid market-data upgrade is performed.

Partial exits allocate entry cost and fees proportionally. Completed-trade analytics
group both sales into one position; partial sales still appear in transactions and
realized P&L. Compounding, remaining cost basis and winner cooldown persist across
restarts. Tests also cover partial-sale accounting, total-position win/loss, size
cap/reset, six-entry cap and three-bar opening signals.

The expanded watchlist includes Ford (F), GM, airlines, cruise operators, banks,
energy stocks and sector ETFs. The live overview exposes every scan, qualified
setups, entries and per-symbol skip reasons. A setup that passes market checks
may still be skipped for cash, open slots, cooldown or the daily entry cap.
