"""Pure, causal signal/exit logic used by BOTH execution and replay."""
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import floor
from common import ET

@dataclass(frozen=True)
class Bar:
    symbol: str
    time: datetime  # beginning of minute, timezone-aware
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: float | None = None

@dataclass(frozen=True)
class Signal:
    entry: float
    stop: float
    rvol: float
    reason: str

def at(t):
    return t.astimezone(ET).strftime('%H:%M')

def same_time_rvol(history, bars, regular, minimum_samples=1):
    """Same feed, same minute coverage; missing history does not mean zero volume."""
    if not bars:
        return None
    slots = [at(b.time) for b in bars]
    samples = []
    for session in history:
        values = {at(b.time): b.volume for b in session
                  if ('09:30' <= at(b.time) < '16:00') == regular}
        if all(k in values for k in slots):
            samples.append(sum(values[k] for k in slots))
    if len(samples) < minimum_samples or sum(samples) <= 0:
        return None
    return sum(b.volume for b in bars) / (sum(samples) / len(samples))

def indicators(bars, s):
    if len(bars) < s['atr_period'] + 1:
        return None
    tr = [max(b.high-b.low, abs(b.high-bars[i].close), abs(b.low-bars[i].close))
          for i, b in enumerate(bars[1:])]
    n = s['atr_period']
    atr = sum(tr[:n]) / n
    for value in tr[n:]:
        atr = (atr*(n-1)+value) / n
    ema = bars[0].close
    alpha = 2 / (s['ema_period']+1)
    for b in bars[1:]:
        ema += alpha*(b.close-ema)
    regular = [b for b in bars if '09:30' <= at(b.time) < '16:00']
    volume = sum(b.volume for b in regular)
    vwap = sum((b.vwap if b.vwap is not None else (b.high+b.low+b.close)/3)*b.volume for b in regular)/volume if volume else None
    return atr, ema, vwap

def signal(bars, history, opening, close, s, bid, ask, time):
    """Momentum entry with completed-bar confirmation, anti-chase checks and breakout/retest support."""
    regular = [b for b in bars if opening <= b.time < close]
    entry_delay = s.get('entry_delay_minutes', s['range_minutes'])
    if not regular or time < opening + timedelta(minutes=entry_delay):
        return None, 'entry_delay'
    last = regular[-1]
    if last.time + timedelta(minutes=1) > time or (time-last.time).total_seconds() > s['bar_max_age_seconds']:
        return None, 'stale_or_unfinished_bar'
    if len(regular) > 1 and (last.time-regular[-2].time).total_seconds() != 60:
        return None, 'missing_bar'
    orb = [b for b in regular if b.time < opening + timedelta(minutes=s['range_minutes'])]
    if len(orb) != s['range_minutes'] or len(regular) < s['range_minutes'] + 2:
        return None, 'opening_range_incomplete'
    if bid <= 0 or ask < bid or (ask-bid)/((ask+bid)/2) >= s['spread_max']:
        return None, 'spread'
    ind = indicators(bars, s)
    if not ind or ind[2] is None:
        return None, 'indicator_warmup'
    atr, ema, vwap = ind
    if atr <= 0:
        return None, 'atr'
    rvol = same_time_rvol(history, regular, True, s['minimum_history_sessions'])
    threshold = s['late_rvol_min'] if at(time) >= s['late_start'] else s['rvol_min']
    if rvol is None or rvol < threshold:
        return None, 'rvol'

    high, low = max(b.high for b in orb), min(b.low for b in orb)
    prev = regular[-2]
    prior_after_orb = regular[s['range_minutes']:-1]
    vols = [b.volume for b in bars[:-1]][-s['volume_lookback']:]
    if not vols or last.volume <= sum(vols)/len(vols)*s['signal_volume_multiple']:
        return None, 'signal_volume'

    body = abs(last.close-last.open)
    if body > atr*s.get('max_signal_body_atr', 0.65):
        return None, 'signal_candle_overextended'
    if last.close-vwap > atr*s.get('max_vwap_extension_atr', 0.85):
        return None, 'too_far_above_vwap'
    if last.close-high > atr*s.get('max_breakout_extension_atr', 0.55):
        return None, 'breakout_chase'
    if last.close <= ema or last.close <= vwap or bid <= vwap:
        return None, 'trend_not_confirmed'

    fresh_breakout = prev.close <= high < last.close and bid > high
    had_breakout = any(b.close > high for b in prior_after_orb[:-1]) if len(prior_after_orb) > 1 else False
    tol = atr*s.get('retest_tolerance_atr', 0.20)
    retest = (had_breakout and prev.low <= high + tol and prev.close >= high - tol
              and last.close > max(high, prev.high) and bid > high)
    if not (fresh_breakout or retest):
        return None, 'no_confirmed_breakout_or_retest'

    entry = round(ask*(1+s['marketable_limit_bps']/10000), 2)
    stop_atr = s.get('stop_atr_multiple', 0.65)
    if retest:
        structural = prev.low - atr*s.get('stop_buffer_atr', 0.08)
        stop = round(max(low, structural, entry-atr*stop_atr), 2)
        setup = 'ORB_RETEST'
    else:
        stop = round(max(low, entry-atr*stop_atr), 2)
        setup = 'ORB_BREAKOUT'
    if entry-stop < s['minimum_stop_distance'] or stop >= bid-s['minimum_stop_distance']:
        return None, 'stop_distance'

    return Signal(entry, stop, rvol,
        f'{setup}; OR high {high:.2f}; VWAP {vwap:.2f}; EMA {ema:.2f}; RVOL {rvol:.2f}; ATR {atr:.3f}'), 'accepted'

def size(sig, equity, buying_power, gross, r):
    risk = equity*r['risk_fraction']
    capacity = min(equity*r['max_position_equity_fraction'],
                   max(0, equity*r['max_gross_equity_fraction']-gross),
                   max(0, buying_power*(1-r['buying_power_reserve_fraction'])))
    return max(0, floor(min(risk/(sig.entry-sig.stop), capacity/sig.entry)/2)*2)

def managed_exit(position, bars, time, s):
    """Returns (exit_reason, tightened_stop). Stops never loosen."""
    if not bars:
        return None, position['stop']
    p = position
    elapsed = (time-datetime.fromisoformat(p['entered'])).total_seconds()/60
    if elapsed >= s['time_stop_minutes'] and abs(bars[-1].close-p['entry']) <= s['flat_r']*p['distance']:
        return 'flat_time_stop', p['stop']
    stop = p['stop']
    if p.get('tp_done'):
        stop = max(stop, p['entry'])
        ind = indicators(bars, s)
        if ind:
            line = ind[1] if s['trail']=='ema' else ind[2]
            if line:
                stop = max(stop, round(line, 2))
    return None, stop
