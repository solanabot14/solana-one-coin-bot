'use strict';

module.exports = Object.freeze({
  mode: 'paper',
  chain: 'sol',
  paperTradeUsd: Number(process.env.COPY_PAPER_TRADE_USD || 10),
  startingBalanceUsd: Number(process.env.COPY_STARTING_BALANCE_USD || 100),
  takeProfitPct: Number(process.env.COPY_TAKE_PROFIT_PCT || 15),
  stopLossPct: Number(process.env.COPY_STOP_LOSS_PCT || 12),
  liquidityExitDropPct: Number(process.env.COPY_LIQUIDITY_EXIT_DROP_PCT || 35),
  maxOpenPositions: Number(process.env.COPY_MAX_OPEN_POSITIONS || 3),
  pollMs: Number(process.env.COPY_POLL_MS || 15000),
  riskCheckMs: Number(process.env.COPY_RISK_CHECK_MS || 15000),
  walletRefreshMs: Number(process.env.COPY_WALLET_REFRESH_MS || 1800000),
  smartMoneyLimit: Number(process.env.COPY_SMART_MONEY_LIMIT || 100),
  maxWallets: Number(process.env.COPY_MAX_WALLETS || 10),
  minTrades30d: Number(process.env.COPY_MIN_TRADES_30D || 10),
  minWinRate30d: Number(process.env.COPY_MIN_WIN_RATE_30D || 55),
  maxSignalAgeSec: Number(process.env.COPY_MAX_SIGNAL_AGE_SEC || 60),
  leaderSellConfirmCount: Number(process.env.COPY_LEADER_SELL_CONFIRM_COUNT || 2),
  leaderSellConfirmWindowSec: Number(process.env.COPY_LEADER_SELL_CONFIRM_WINDOW_SEC || 120),
  leaderDumpPnlPct: Number(process.env.COPY_LEADER_DUMP_PNL_PCT || -3),
  leaderDumpLiquidityDropPct: Number(process.env.COPY_LEADER_DUMP_LIQ_DROP_PCT || 12),
  copySuspendMinTrades: Number(process.env.COPY_SUSPEND_MIN_TRADES || 4),
  copySuspendLossStreak: Number(process.env.COPY_SUSPEND_LOSS_STREAK || 3),
  copySuspendWinRatePct: Number(process.env.COPY_SUSPEND_WIN_RATE_PCT || 25),
  demoReadOnlyApiKey: 'gmgn_solbscbaseethmonadtron'
});
