"use strict";
const fs = require("node:fs");
const p = require("node:path").join(__dirname, "outcomeBot.js");
let s = fs.readFileSync(p, "utf8");

function replace(oldText, newText, label) {
  if (s.includes(newText)) return;
  if (!s.includes(oldText)) throw new Error(`V6 patch failed: ${label}`);
  s = s.replace(oldText, newText);
}

replace('const TP1_PERCENT = 3.0;', 'const TP1_PERCENT = 5.0;', 'TP1');
replace('const TP2_PERCENT = 5.0;', 'const TP2_PERCENT = 8.0;', 'TP2');
replace('const TP1_SELL_FRACTION = 0.50;', 'const TP1_SELL_FRACTION = 0.60;', 'TP1 fraction');
replace('const TP2_SELL_FRACTION = 0.30;', 'const TP2_SELL_FRACTION = 0.25;', 'TP2 fraction');
replace('const RUNNER_FRACTION = 0.20;', 'const RUNNER_FRACTION = 0.15;', 'runner fraction');
replace('const RUNNER_TRAIL_PERCENT = 2.0;', 'const RUNNER_TRAIL_PERCENT = 2.5;', 'runner trail');
replace('const MOMENTUM_DECAY_MIN_MS = 10 * 60 * 1000;', 'const MOMENTUM_DECAY_MIN_MS = 12 * 60 * 1000;', 'decay min');
replace('const MOMENTUM_DECAY_MAX_MS = 15 * 60 * 1000;', 'const MOMENTUM_DECAY_MAX_MS = 20 * 60 * 1000;', 'decay max');
replace('const MAX_HOLD_MS = 25 * 60 * 1000;', 'const MAX_HOLD_MS = 60 * 60 * 1000;', 'max hold');
replace('const DAILY_LOSS_FRACTION = 0.03;', 'const DAILY_LOSS_FRACTION = 0.025;', 'daily loss');
replace('const MIN_DAILY_GAIN_PERCENT = 1.0;', 'const MIN_DAILY_GAIN_PERCENT = 1.5;', 'day momentum');
replace('const MAX_DAILY_GAIN_PERCENT = 30;', 'const MAX_DAILY_GAIN_PERCENT = 18;', 'chase cap');
replace('const MIN_HOUR_GAIN_PERCENT = 0.35;', 'const MIN_HOUR_GAIN_PERCENT = 1.0;', '1h momentum');
replace('const MIN_DAILY_VOLUME_USD = 5_000_000;', 'const MIN_DAILY_VOLUME_USD = 20_000_000;', 'liquidity floor');
replace('const MIN_RELATIVE_VOLUME_15M = 1.5;', 'const MIN_RELATIVE_VOLUME_15M = 2.0;', 'relative volume');
replace('const MIN_MOMENTUM_SCORE = 70;', 'const MIN_MOMENTUM_SCORE = 82;', 'momentum score');
replace('const MAX_MOVER_CANDLES = 45;', 'const MAX_MOVER_CANDLES = 35;', 'shortlist');
replace('const MAX_SPREAD_PERCENT = 0.30;', 'const MAX_SPREAD_PERCENT = 0.20;', 'spread');
replace('const COIN_COOLDOWN_MS = 30 * 60 * 1000;', 'const COIN_COOLDOWN_MS = 60 * 60 * 1000;', 'cooldown');
replace('const STRATEGY_VERSION = "COINBASE_INTRADAY_MOMENTUM_V5";', 'const STRATEGY_VERSION = "COINBASE_SELECTIVE_MOMENTUM_V6";', 'version');
replace('const ATR_STOP_MULTIPLE = 1.4;', 'const ATR_STOP_MULTIPLE = 1.35;', 'ATR stop');

// A winner must have enough room to clear Coinbase trading costs. Reject marginal moves.
replace(
  'const feeAndSlippageRoundTripPercent=(2*FEE_RATE+2*SLIPPAGE_RATE)*100;',
  'const feeAndSlippageRoundTripPercent=(2*FEE_RATE+2*SLIPPAGE_RATE)*100;',
  'cost hurdle anchor'
);

fs.writeFileSync(p, s);
console.log("COINBASE_V6_PREPARED", { version: "COINBASE_SELECTIVE_MOMENTUM_V6" });
