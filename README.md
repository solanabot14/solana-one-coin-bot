# Solana One Coin Bot

A one-position paper trader using DexScreener. It does not connect a wallet or execute real swaps. Birdeye is not included.

## Run locally

1. Use Node.js 24 and run `npm ci` if dependencies are not installed.
2. Run `npm test` to check reliability, reporting, and access controls with isolated test accounts.
3. Run `npm start` and open http://127.0.0.1:3000.
4. Press **Start Bot** to enable paper trading. Starting the dashboard alone does not trade.

Local access defaults to the loopback interface. Your existing `.env` is preserved; `.env.example` documents optional settings. A Helius key is no longer required. If you configure authentication, the browser prompts for your username and password.

**Stop Bot cancels pending trading actions and pauses automatic exits. It keeps the open position saved.** Press Start to resume monitoring. A process restart also leaves trading stopped. The bot pauses on an unexpected trading/storage error; consult the server logs before restarting.

## Rules

Entry filters and scoring remain in `strategy.js` and `scanner.js`. Each purchase uses at most $10, with only one open position. Exit thresholds in `bot.js` are unchanged: -10% hard stop, the existing momentum exits, 25% sale at +15%, 35% of the remainder at +30%, and an 8% trailing stop after the second target. Network timeouts and source-data outages can delay exits; displayed prices are simulated fills without fees or slippage.

## Account storage

By default, the account is `tradingData.json` beside the source files, regardless of the shell's working directory. `DATA_DIR` selects another local directory. On Railway the attached volume path takes precedence.

Every trade saves the account and profit-taking flags together using a flushed temporary file followed by replacement of the account file. Price peaks are also saved. Failed writes do not publish the proposed change in memory. Invalid accounts cause startup to fail rather than silently resetting the balance. Keep independent backups; atomic replacement is not a backup system.

Run **one application process/replica per account file**. The JSON store is not a multi-process database. Do not run either backup dashboard alongside this application or edit the live account while the application is running. Existing backup source files were left untouched.

This update does not rewrite or migrate your existing trading history. The account file is still tracked in Git for compatibility with the existing repository; avoid committing new runtime history unintentionally. Old records without an exit reason remain readable.

## Dashboard

- Completed-position statistics include fully closed positions only; open partial-sale profits remain reflected in cash and total equity.
- Exit price is the quantity-weighted average of the sales.
- Profit factor is infinity when there are profits and no losses, and a dash when neither exists.
- If an open position cannot be priced, equity and total P/L show **Unavailable**, and the position remains visibly open.
- State comes from the same in-memory account used by the bot, not a separate stale file read.

## Railway preparation

Set the start command to `npm start`, the healthcheck path to `/healthz`, and the restart policy to On Failure in Railway's service settings. Railway no longer permits new services to opt into the legacy `railway.json` configuration, so deployment settings are managed in its dashboard.

Before deploying:

1. Attach a persistent volume to the service, for example at `/data`. Railway supplies `RAILWAY_VOLUME_MOUNT_PATH`. The app refuses Railway startup without this variable.
2. Set `DASHBOARD_USER` and a unique `DASHBOARD_PASSWORD` of at least 16 characters in Railway's Variables panel. Do not commit these values.
3. Leave `HOST` unset (Railway defaults to `0.0.0.0`) or set it to `0.0.0.0`. Let Railway supply `PORT`.
4. Keep one replica and use the public HTTPS URL for browser authentication. The app itself serves HTTP behind Railway's HTTPS proxy.
5. To continue an existing account, stop the old bot and copy the intended `tradingData.json` into the volume before enabling trading. An empty volume starts a new $100 paper account; it does not import the repository's history automatically.
6. Deploy, check `/healthz`, log into the dashboard, confirm the account, then press Start.

The health endpoint checks HTTP service availability, not market-data freshness or whether trading is enabled. Account data, the dashboard, and controls require authentication when exposed to the network. Controls use POST plus a same-origin custom header. Local unauthenticated mode additionally validates the request host.

See Railway's [networking guidance](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond) and [volume documentation](https://docs.railway.com/volumes).

## Files

| File | Responsibility |
| --- | --- |
| `dashboard.js` | Server, authentication, page, startup and shutdown |
| `dashboard-client.js` | Browser rendering and controls |
| `dashboardData.js` | Account valuation and completed-position statistics |
| `bot.js` | Scheduling, cancellation, entry selection and exits |
| `scanner.js` | Candidate discovery and filters |
| `strategy.js` | Momentum scoring |
| `dexscreener.js` | Market API requests, timeouts and cancellation |
| `paperTrader.js` | Account operations and atomic persistence |
| `test/reliability.test.js` | Offline regression tests plus a local HTTP test server |
