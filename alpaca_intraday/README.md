# Alpaca Intraday ORB — paper-first standalone replacement

This is an isolated, runnable Python implementation for US equities. It does not alter or deploy the existing JavaScript dashboard or any other bot. It places actual orders in an Alpaca **paper brokerage account**, rather than recording simulated trades only in a local ledger. All broker and Alpaca market-data operations use official `alpaca-py` 0.44.0.

**Status:** source reviewed; offline tests and synthetic replay provided. Not authenticated against your Alpaca account, not deployed, and not validated with real fills. No profitability claim. See AUDIT.md for findings in the original bot and limitations of this replacement.

## 1. What you need

- Python 3.12+ on Linux/macOS, or Docker on Windows. `fcntl` process locks require Unix.
- An **exclusive Alpaca equities paper account**. Do not share it with other bots or discretionary positions: kill/daily-loss/EOD actions cancel and liquidate the ENTIRE account.
- Paper API key and secret. Live credentials are separate and unused by default.
- SIP real-time data entitlement for dependable consolidated volume and spreads. IEX is selectable, but is one exchange and volume/RVOL is not market-wide. Default IEX configuration prints a warning and deliberately disables entries.
- News and trading-status stream access on the account. Permission failures block entries; they are never silently ignored.
- A continuously running computer/server with working internet, a synchronized clock and persistent `state/` storage. Start before **08:00 New York time** each session. Market calendar handles holidays, daylight-saving time and early closes.

## 2. Install, in simple steps

1. Unzip this folder and open a terminal inside it.
2. Create and activate an environment:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   ```

3. Copy `.env.example` to `.env`. Enter only your **paper** keys initially:

   ```text
   ALPACA_PAPER_API_KEY=your_paper_key
   ALPACA_PAPER_SECRET_KEY=your_paper_secret
   ```

   Do not upload `.env` to GitHub. No credentials are included in this package.

4. Open `config.toml`. Leave `paper = true`. With SIP entitlement, set `feed = "sip"`. For an explicitly limited IEX experiment only, set `allow_iex_entries = true`; performance and volume measurements will not be comparable to SIP. Set Alpaca paper equity to the capital you actually plan to evaluate. The backtest's $25,000 default is a simulation balance, **not an account requirement**. With a $100 account, the whole-share, two-bracket and 25%-per-position caps can prevent trades.
5. Check the installation:

   ```bash
   python -m pytest tests -q
   ```

6. Start the engine **and** independent watchdog together before 08:00 ET:

   ```bash
   python start.py --config config.toml
   ```

   Leave the process running. It scans on market days 08:00–09:25 ET, waits through the five-minute opening range, monitors positions, and starts flattening 15 minutes before the broker's session close. It continues verification through the close. Starting after the opening range intentionally does not reconstruct a missed live session or buy late.

7. For unattended hosting, Docker supplies restart and persistent storage:

   ```bash
   docker compose up --build -d
   docker compose logs -f
   ```

   This is not installed in Railway by this deliverable. Do not replace the shared dashboard's start command with this service. Host it separately to keep the other bots untouched.

## 3. Behavior and assumptions

- **Long only**, exchange-tradable US equities; a positive gap and a recent company-tagged catalyst headline are required. Keyword matching is transparent evidence of a headline, not proof of a bullish catalyst. Dynamic movers/most-active results plus seed symbols form a bounded scanner universe. It does not scan every US listing, and never forces 5–10 selections when fewer qualify.
- Historical and current volume use the SAME configured feed, comparable completed minute slots and at least 10 valid history sessions. Missing data is not filled with zero. Daily average volume excludes the current session. Raw, unadjusted data can be distorted by splits; inspect corporate-action dates before interpreting results.
- Confirmation uses a **completed one-minute close above the first five-minute opening high**, previous close at/below that high, above VWAP, fresh bid above both levels, and above-average signal volume. Earliest entry is roughly 09:36 ET, which is intentionally stricter than trading immediately at 09:35.
- ATR(14) is Wilder-smoothed; EMA(9) uses completed one-minute bars, with premarket/prior-session warm-up. VWAP includes regular-session volume only. Default trail is EMA; switch `trail = "vwap"` if desired.
- Entry price is a marketable **limit** based on the fresh ask plus configurable price tolerance. Size uses the worst permitted entry limit and closer of opening-range-low or one ATR below entry. Size is rounded DOWN to an even whole-share quantity. R and initial bracket targets use the planned entry-limit-to-stop distance, which is known at submission. Actual fills may reduce risk below that budget; breakeven uses actual average fill price. A better entry fill therefore makes the original target slightly greater than 1.5 times actual-fill risk.
- One symbol per day (stricter than one concurrent position per symbol). Three slots, 12 entries/day, 0.5% planned risk/trade, 25% per-symbol notional and 90% total gross exposure caps. No intentional leverage. Buying power reserve and exposure caps can reduce risk below 0.5%. No deprecated day-trade fields/checks exist in the implementation.
- **Two half-size brackets:** first half exits at 1.5R; second half has an initial broker stop and a configurable distant 20R safety target, allowing trailing management. A native Alpaca bracket cannot express the requested partial target by itself. The additional runner target is an explicit bounded adaptation; both orders count as one strategy trade. A two-order entry is not atomic: if either submission is rejected/uncertain, trading halts and the account is flattened.
- Breakeven/trailing changes start only after the first half's take-profit leg is fully filled. Stop replacements use PATCH through SDK and never intentionally loosen stops. Breakeven is entry price, before eventual regulatory fees. Broker stop-market exits can gap beyond the intended risk.
- Flat after 30 minutes means within ±0.25R of entry, configurable. Normal time/trail exits cancel that symbol's orders, wait for cancellation, use the SDK close-position endpoint, and reconcile. Other symbols continue. Emergency/EOD exits use close-all-positions. Those close endpoints use broker liquidation orders; the no-blind-market constraint applies to **entries**.
- Partial fills are logged and trigger a session safety halt/flatten, rather than assuming broker protection exists. This conservative rule can interrupt otherwise viable trades.
- After 11:30 ET, minimum same-time RVOL increases to 3. No new trades in the final 30 minutes. Closing starts at 15:45 on a normal day and 12:45 on a 13:00 early close. Positions and orders must both be zero; a successful endpoint response alone is not success.
- The daily 2% loss threshold uses account equity including unrealized losses against the stored session baseline. Gaps, slippage and polling latency can exceed the threshold; it is an exit trigger, not a guaranteed loss cap. Two completed losses cause a 30-minute entry cooldown. Open trades remain managed.
- Official BLS CPI and Fed FOMC calendars refresh automatically; both FOMC meeting days are skipped. A failed parser, unavailable source, stale cache or uncovered date blocks entries. Exits remain active. Fed returned HTTP 403 in this build environment; do not assume calendar access works on your host. Review `macro_refresh_error` before expecting trades. `allow_macro_days = true` is an explicit risk override that bypasses both skips and unavailable-calendar protection.
- Halt/status messages freeze entries for the affected symbol until trading resumes plus five minutes. Quote resumption alone is insufficient. Missing/stale quotes also block entries. Stops and liquidation cannot execute while a security is halted.

## 4. Kill switch, recovery and heartbeat

Create the `state/KILL` file to stop new trades and liquidate:

```bash
touch state/KILL
```

The watchdog is a separate OS process, independent of the strategy loop. It uses broker calendar times and checks heartbeat age/health. It flattens on stale/unhealthy heartbeat during the session, on KILL, on out-of-session exposure, and at the closing window even if no heartbeat exists. It writes a date-scoped `HALT-YYYY-MM-DD` latch so a recovered engine cannot reopen positions after a watchdog incident. Mutation locks serialize engine/watchdog order changes on the same state folder.

After a crash with positions/orders/unreconciled trade state, the engine **halts for the session and flattens**; it does not resume trading with guessed cost basis. Check broker positions/orders directly and inspect the audit log. Do not delete state to get around an unresolved discrepancy. A fresh session can reset the day only after exposure and metadata reconcile. Manual reconciliation is needed if a broker order cannot be recovered or fill quantities disagree.

KILL persists until you remove it. The current day's safety halt remains after removing KILL. Restarting is not a bypass. To resume normally, resolve the incident and allow the next session reset. Logs explain the blocker.

**The watchdog cannot act if its host, network or Alpaca is unavailable.** Broker stops remain at the broker, but no system can promise zero overnight holdings during a prolonged halt/outage. For resilience against complete host loss, run a second independently hosted watchdog with secure shared heartbeat/state access and the same exclusive account. This package's included launcher protects against a process crash, not a whole-site failure.

## 5. Logs and reports

- `state/audit.sqlite`: signals, rejection reasons, submissions, websocket trade updates, broker order snapshots (including cumulative fills), status messages and liquidation verification. SQLite WAL and durable intent writes support crash review.
- `state/events.csv`: export at report/shutdown; SQLite remains authoritative during a session.
- `state/report-YYYY-MM-DD.json`: P&L, win rate, average R, peak-to-trough equity drawdown, best/worst trade, trade reasons, equity P&L and closed-trade details.
- `state/research-archive/YYYY-MM-DD.json`: latest observed point-in-time premarket selection and macro decision for replay.
- `state/heartbeat.json`: strategy health and timestamp. `macro.json`: bounded official-calendar cache.

Live trade P&L uses broker fill prices, including actual spread/slippage in those fills. Fees are explicitly `null` pending statement reconciliation: this SDK version's TradingClient has no public account-activities fee endpoint. Do not represent modeled fees as broker-confirmed fees. Backtest fees are fully configurable. If all trades win, profit factor is undefined and reported as null, not infinity.

## 6. Backtest: run the same signal and trailing functions

First collect point-in-time scanner archives in paper mode. Convert them:

```bash
python archive_candidates.py --archive state/research-archive --output candidates.json
```

Download minute bars and official sessions for the symbols that appeared in those archived scans, covering the evaluation dates. A SIP subscription/history entitlement may be required:

```bash
python download.py --symbols F,SOFI,INTC --start 2026-10-01 --end 2026-10-15 --output bars.csv --sessions sessions.json
python backtest.py --bars bars.csv --candidates candidates.json --sessions sessions.json --output backtest-report.json
```

Substitute symbols and dates from your real archive. The downloader includes prior history for RVOL warm-up. It does NOT invent historical mover rankings or news selections from today's winners. For older research, obtain a genuine point-in-time universe/catalyst archive and supply equivalent metadata. Dates without a candidate record do not trade.

`bars.csv` columns: `timestamp,symbol,open,high,low,close,volume,vwap`; timestamp must include UTC offset, is the start of a minute, and volume must use one consistent feed. `sessions.json` maps each session date to timezone-aware `open` and `close`. `candidates.json` maps each date to `macro_clear` and `rows`; each candidate requires `symbol`, a premarket `scan_time`, and nonempty `catalyst`. These records are trusted historical scanner evidence; the replay does not independently prove the premarket filters from those three fields. Do not hand-pick winners.

Replay includes portfolio concurrency, sizing/exposure, same signals, RVOL, stops, partial targets, EMA/VWAP trail, time stop, loss limit, cooldown, end-of-day exits, commissions, sell fees, slippage and assumed spread. It fills at the next minute's open if the limit is executable under cost assumptions. Stop-first ordering and no entry-minute target reward are conservative assumptions. It rejects datasets with unresolved end-of-test positions.

Limitations: minute bars cannot reproduce bid/ask history, order queues, partial execution, intraminute sequencing, disconnects or halt fills. Historical commission schedules must be entered in config. Paper/live have broker-specific asynchronous order handling; replay shares strategy functions but is not identical execution. Use detailed trade logs and real paper fills to investigate differences.

A deterministic synthetic replay fixture is in the tests. Its artificial profits are a code test, not strategy evidence. No historical performance results are claimed.

## 7. Tuning plan

1. Freeze an initial configuration and point-in-time universe. Gather 6–12 months spanning trends, chop, high-volatility and low-volatility sessions. Include delisted symbols where data permits; document coverage and corporate actions.
2. Split chronologically into training (50%), validation (25%), untouched final test (25%). Never optimize on the final segment. Refit only with rolling walk-forward windows.
3. Vary a small grid: opening range 5/10/15 min; RVOL 2/2.5/3; signal volume 1/1.2/1.5; target 1.25/1.5/2R; EMA vs VWAP; flat time 20/30/45 min. Keep fixed account risk and hard limits while comparing. No parameter should be selected from one profitable day.
4. Compare net expectancy/trade, profit factor, drawdown, average R, trade count, worst loss/day, exposure and cost sensitivity. Inspect each symbol/day contribution. Avoid results dependent on a handful of outliers or hundreds of trials. Require enough trades across regimes; a few dozen trades are insufficient evidence.
5. Stress slippage at 2x/3x assumptions, wider spreads, missing bars, late fills and liquidity limits. The minute replay cannot simulate halts faithfully; use failure-injection/paper drills for those risks.
6. Select stable parameter regions that survive validation and costs, then run the untouched test once. Set prospective acceptance thresholds BEFORE paper evaluation; do not lower them after a bad result.

## 8. Thirty market-session paper checklist

Use **30 market sessions**, which usually exceeds 30 calendar days. No live switch merely because the count was reached.

| Sessions | Required checks |
|---|---|
| 1–5 | SIP/news/status entitlements; calendars and ET schedule; scanner reasons; RVOL against matching SIP history; risk math; correct two-bracket quantities; statements vs logged fills. |
| 6–10 | Kill switch and process-kill drill; stale stream; rejected entry; partial fill; ambiguous response; duplicate-process lock; zero accidental duplicate entries. Resolve discrepancies before continuing. |
| 11–15 | TP1 partial/full fills, stop-to-BE acknowledgement, trailing monotonicity, time exits, per-symbol close, cooldown and max trades/slots. Review every fill. |
| 16–20 | Daily loss halt including unrealized loss, account restriction/margin rejection, restart with exposure, and forced early-close fixture. No safety override to obtain more trades. |
| 21–25 | Full unattended sessions, EOD zero-position AND zero-order evidence each day, watchdog restart, durable-volume recovery, broker-vs-replay reconciliation. |
| 26–30 | Freeze parameters. Evaluate net expectancy/costs, drawdown, tail losses, rejected setups and scanner coverage against predeclared thresholds. Independently inspect the logs. |

Minimum gates: zero unresolved safety incidents; every EOD position/order check passes; every fill reconciles; risk/exposure limits respected apart from documented market gaps; sufficient trades and multiple regimes; costs and performance survive stress tests. Failed gates extend paper evaluation. Thirty sessions do not demonstrate long-term profitability.

Live mode is a separate decision. If justified after review, use separate live keys, `paper = false`, and `live_confirmation = "I_ACCEPT_LIVE_TRADING_RISK"`. Start with materially smaller notional/risk; revalidate entitlements, fees and execution. The code is not being switched live or deployed by this delivery.

## 9. Where ORB fails

False breakouts in range-bound markets; opening auction distortions; high-RVOL exhaustion moves; negative/misclassified news; spreads that widen after selection; crowded breakouts; halts; stop gaps; correlated positions; low-liquidity names hidden by average volume; split-contaminated history; delayed/stale feeds; and transaction costs that consume a small edge. A positive gap/news headline is not evidence that price must keep rising. A 50% target can cut winners early; a distant runner target is not a profit prediction. The bot should stay flat when its inputs or setup quality are inadequate.

## Files

`strategy.py` causal shared logic; `scanner.py` discovery/history/news; `engine.py` execution/reconciliation; `broker.py` SDK adapter/timeouts/liquidation; `streams.py` websocket callbacks; `macro.py` official calendars; `watchdog.py` independent risk process; `start.py` process launcher; `backtest.py` replay; `download.py` historical data; `archive_candidates.py` archive converter; `common.py` config/audit/statistics; `tests/` offline behavior checks.
