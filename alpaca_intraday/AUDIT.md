# Source audit — October 16, 2026

Reviewed current GitHub files `solanabot14/solana-one-coin-bot/stockBot.js` and `package.json` from default branch. Stock Bot content blob SHA: `e4e9ae2de6670fddb73454054f20533945ab6688`. Findings below are from source inspection, not a claim that production incidents were reproduced. No shared-repository files were changed. The legacy file was read for review and is not included as a runnable dependency in this package.

Source: https://github.com/solanabot14/solana-one-coin-bot/blob/main/stockBot.js

## Findings

| Evidence in current source | Problem / requirement gap | Replacement behavior |
|---|---|---|
| File begins “Local paper ledger only. No broker order endpoint exists in this module.” `request()` accepts GET only. | It is a local simulation, not an Alpaca execution bot; it cannot prove broker fills or liquidate brokerage positions. This is intentional legacy behavior, not a hidden SDK bug. | Official SDK paper broker orders, broker-side stops and reconciliation. |
| `package.json` has axios/dotenv/SQLite but no Alpaca Python dependency. | Neither `alpaca-py` nor `alpaca-trade-api` is used. There is no old Python SDK to migrate in the inspected module. | New isolated Python implementation pinned to official `alpaca-py`. |
| Intraday snapshots use `feed:'iex'`, filters and strategy description explicitly reference IEX history. | No configurable consolidated feed or startup data-quality gate; volume measures cannot be interpreted as full-market volume. Existing same-time historical comparisons are a sound idea but cover a narrow feed. | IEX/SIP switch, consistent-feed history/current comparisons, minimum matching sessions, and default no-entry IEX warning. |
| `quote()` allows 120,000 ms age. | A two-minute quote is unsafe for a tight-spread intraday entry, especially after fast movement. | Three-second configurable age, rechecked after blocking API reads before submit. |
| `start()` polls with `setInterval(...,15000)`. | No real-time websocket execution/order updates. Exits depend on successful periodic work. | Bar/quote/status and trading update streams, plus authoritative broker snapshot reconciliation. |
| `tick()` obtains the clock and snapshots before managing exits; catch records connection error. | Broker/data failure can prevent even local exits. There is no independent close watchdog in this module. | Separate watchdog, date-scoped halt latch, persistent broker brackets, repeated broker flat verification. |
| Flattening calls `updatePositions(snapshots,flatten)` and pending-exit quote handling. | A stale/missing quote can leave local positions open; no close-all-positions API call exists. | Cancel/acknowledge orders, close-all endpoint, verify no positions AND no pending orders. |
| Risk rules contain `dailyLossPercent:2.5`; strategy uses capped $10–$20 entry amounts. | Conflicts with requested 2% daily trigger and 0.5–1% equity/stop-distance sizing. | 2% daily trigger, 0.5% planned risk default, notional/gross/buying-power caps. |
| Five-minute bars, first-15-minute entry delay, daily ATRP filter, breakout/recovery signals; 60-minute hold. | Different strategy from requested five-minute ORB, minute ATR/VWAP/EMA and 30-minute flat stop. These are specification changes, not proof the old rules were wrong. | Shared causal ORB logic and explicit warm-up; configurable 30-minute flat stop. |
| `sessionOpen(nextClose)` reconstructs 09:30 from close; no calendar endpoint call in module. | Does not use explicit daily calendar open/close contracts. | Broker calendar plus clock; close-relative flattening works on early closes. |
| Macro gating permits degraded BLS coverage under reduced exposure; news is context, not a required catalyst. | Does not meet “skip CPI/FOMC days” plus mandatory catalyst requirement. | Daily official calendar gate, both meeting days skipped, failure closed; required recent tagged keyword headline. |
| Local fills estimate spread, slippage and fees. | Useful simulated analytics, but not broker-confirmed execution costs. | Broker fills logged distinctly; actual posted fees remain explicitly unavailable until statement reconciliation. Replay uses configurable modeled fees. |

No deprecated PDT/daytrade/buying-power checks were found in the inspected `stockBot.js`. Removing nonexistent checks would be a false claim. The new code makes no decisions using those deprecated fields. Unrelated repository modules were not audited or modified.

## Alpaca contracts verified

1. Alpaca states PDT restrictions were replaced June 4, 2026 and directs Trading API integrations to use **`buying_power`**, not an invented `intraday_buying_power` field: https://alpaca.markets/blog/finra-retires-the-pdt-rule-introducing-alpacas-new-intraday-margin-framework/
2. Current intraday risk framework and pre-trade rejection behavior: https://docs.alpaca.markets/us/docs/the-intraday-margin-rule
3. Bracket parents activate protective children only when fully filled; exits can race in volatile markets; replace supports stop/limit prices: https://docs.alpaca.markets/us/docs/orders-at-alpaca
4. SDK stream methods include `subscribe_trading_statuses`; availability depends on entitlements: https://alpaca.markets/sdks/python/api_reference/data/stock/live.html
5. Halt/resumption codes distinguish quote resumption from trading resumption: https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data

Old versioned Alpaca docs may still contain legacy fields and restrictions. The implementation follows the newer explicit migration guidance and current buying-power/rejection behavior.

## Important implementation limits

- This is a standalone replacement package, not a migration of existing local ledger balances into a live brokerage account, and not integrated with the Node dashboard. Run on a separate service/account. Existing ledger trades must not be treated as broker holdings.
- The watchdog and engine are independent processes, but a single-host installation still has host/network common failure modes. Full closure cannot be guaranteed through halts/outages.
- The official SDK has no public TradingClient account-activities fee method in version 0.44.0. Reported live trade P&L is based on fills before separately posted fees. `fees = null` is intentional; no invented fee confirmation. Account equity P&L and eventual statements are the reconciliation source.
- Margin protection reads current buying power, account restriction flags and maintenance margin, and halts/flattens on order rejection. Equity-vs-maintenance checks are a conservative safety trigger, not a complete calculation of Alpaca's IML/IMD. Broker risk checks remain authoritative.
- The SDK lacks a public HTTP timeout parameter; a narrowly scoped pinned `_session` transport hook supplies request timeouts and disables transparent SDK retries. Reads retry with bounded backoff; non-idempotent submissions are attempted once and uncertain outcomes halt. Revalidate this hook before upgrading the SDK.
- EOD liquidation retries deliberately wait for cancellation acknowledgement and do not cancel market liquidations already in flight. Reconciliation never treats an API success response as proof of zero positions.
- The backtest trusts archived scanner decisions and cannot reconstruct an unbiased historical mover/news universe from today's results. Same strategy functions do not make minute OHLCV a full execution simulator.
- FED source returned HTTP 403 in the build environment. No embedded guessed dates were used; production connectivity must pass before automatic entries can begin. BLS download succeeded and its calendar parsing was checked.

## Verification boundary

Offline tests cover strategy confirmation, stale/incomplete bars, matching RVOL coverage, sizing/exposure caps, statistics, early closes, missing/stale heartbeat, kill/live gates, durable state, official-calendar parsers, cancellation acknowledgement, liquidation verification/outage/in-flight handling, two equal brackets, ambiguous submissions without retry, small-account skipping, per-symbol exit cancellation, replay round-trip and commission sensitivity.

Compilation and command-line entrypoints are also checked. These are deterministic offline tests, not broker integration certification. No Alpaca credentials were supplied or accessed for this task; no paper/live order was sent. No real historical strategy backtest was claimed.
