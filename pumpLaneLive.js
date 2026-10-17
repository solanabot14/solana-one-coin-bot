'use strict';
function liveEnabled() { return process.env.PUMP_LANE_LIVE === 'true'; }
function executeLive() {
  if (!liveEnabled()) throw new Error('Pump Lane live trading is disabled');
  throw new Error('Pump Lane live execution is not implemented');
}
module.exports = { liveEnabled, executeLive };
