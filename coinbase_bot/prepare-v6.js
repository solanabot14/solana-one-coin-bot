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

replace('24h USD volume below $5M', '24h USD volume below $20M', 'volume reason');
replace('24h trend below +1%', '24h trend below +1.5%', 'daily reason');
replace('24h gain above +30% chase limit', '24h gain above +18% chase limit', 'chase reason');
replace('15m relative volume below 1.5x', '15m relative volume below 2.0x', 'RVOL reason');
replace('Momentum score below 70', 'Momentum score below 82', 'score reason');
replace('TAKE PROFIT +3% (50%)', 'TAKE PROFIT +5% (60%)', 'TP1 label');
replace('TAKE PROFIT +5% (30%)', 'TAKE PROFIT +8% (25%)', 'TP2 label');
replace('RUNNER TRAILING STOP 2%', 'RUNNER TRAILING STOP 2.5%', 'runner label');
replace('MOMENTUM DECAY EXIT 10-15M', 'MOMENTUM DECAY EXIT 12-20M', 'decay label');
replace('TIME STOP 25M UNDER +1%', 'TIME STOP 60M UNDER +1%', 'time label');
replace('Coinbase Bot paper sustained momentum V5 · liquid USD/USDC · 15m/1h momentum + relative volume + VWAP + EMA + structure · spike rejection · 50% at +3%, 30% at +5%, 20% runner · ATR stop 1.5%-2.5% · momentum-decay exit · 25m max hold', 'Coinbase Bot paper selective momentum V6 · liquid USD/USDC · 15m/1h momentum + RVOL + VWAP + EMA + structure · spike rejection · 60% at +5%, 25% at +8%, 15% runner · ATR stop 1.5%-2.5% · cost-aware selective entries · 60m max hold', 'position strategy label');
replace('Paper-only sustained-momentum rotation. Liquid Coinbase USD/USDC pairs; 15m/1h trend, >=1.5x relative volume, VWAP, EMA9>EMA21, continuation/retest/reclaim, spike rejection and BTC/news/spread guards. Max 6 positions but no forced fills. Exit 50% at +3%, 30% at +5%, trail 20% by 2%; ATR stop 1.5%-2.5%; momentum-decay exit after 10-15m; 25m stale-trade exit; 30m coin cooldown.', 'Paper-only selective momentum V6. Liquid Coinbase USD/USDC pairs; 1h >=1%, 15m positive, >=2x relative volume, VWAP, EMA9>EMA21, continuation/retest/reclaim, spike rejection and BTC/news/spread guards. Max 6 positions but no forced fills. Exit 60% at +5%, 25% at +8%, trail 15% by 2.5%; ATR stop 1.5%-2.5%; momentum-decay validation after 12m; 60m stale-trade exit; 60m coin cooldown.', 'dashboard strategy label');

fs.writeFileSync(p, s);
console.log("COINBASE_V6_PREPARED", { version: "COINBASE_SELECTIVE_MOMENTUM_V6" });
