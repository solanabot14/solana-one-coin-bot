"""Configuration, durable audit log and performance statistics."""
from __future__ import annotations
import csv
import json
import os
import sqlite3
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
UTC = timezone.utc

def now():
    return datetime.now(UTC)

def stamp(t):
    return t.astimezone(ET).strftime('%Y-%m-%d')

def load(path='config.toml'):
    with open(path, 'rb') as f:
        c = tomllib.load(f)
    b, s, r = c['broker'], c['strategy'], c['risk']
    if not (b['feed'] in ('iex', 'sip')):
        raise ValueError('Invalid configuration constraint: '+"b['feed'] in ('iex', 'sip')")
    if not (0 < r['risk_fraction'] <= .01):
        raise ValueError('Invalid configuration constraint: '+"0 < r['risk_fraction'] <= .01")
    if not (0 < r['daily_loss_fraction'] <= .02):
        raise ValueError('Invalid configuration constraint: '+"0 < r['daily_loss_fraction'] <= .02")
    if not (1 <= r['max_positions'] <= 5):
        raise ValueError('Invalid configuration constraint: '+"1 <= r['max_positions'] <= 5")
    if not (s['trail'] in ('ema', 'vwap')):
        raise ValueError('Invalid configuration constraint: '+"s['trail'] in ('ema', 'vwap')")
    if not (0 < r['max_position_equity_fraction'] <= r['max_gross_equity_fraction'] <= 1):
        raise ValueError('Invalid configuration constraint: '+"0 < r['max_position_equity_fraction'] <= r['max_gross_equity_fraction'] <= 1")
    if not (0 < r['verify_minutes_before_close'] < r['flatten_minutes_before_close'] < r['no_new_entries_minutes_before_close']):
        raise ValueError('Invalid configuration constraint: '+"0 < r['verify_minutes_before_close'] < r['flatten_minutes_before_close'] < r['no_new_entries_minutes_before_close']")
    if not (s['profit_r'] < s['runner_cap_r']):
        raise ValueError('Invalid configuration constraint: '+"s['profit_r'] < s['runner_cap_r']")
    if not (s['minimum_history_sessions'] <= s['history_sessions']):
        raise ValueError('Invalid configuration constraint: '+"s['minimum_history_sessions'] <= s['history_sessions']")
    if not (c['runtime']['stream_stale_seconds'] < c['runtime']['stream_restart_seconds']):
        raise ValueError('Invalid configuration constraint: '+"c['runtime']['stream_stale_seconds'] < c['runtime']['stream_restart_seconds']")
    for key in ('max_trades_day','consecutive_losses','cooldown_minutes'):
        if r[key] <= 0:
            raise ValueError('Risk setting must be positive: '+key)
    for key in ('loop_seconds','heartbeat_stale_seconds','stream_stale_seconds','watchdog_poll_seconds'):
        if c['runtime'][key] <= 0:
            raise ValueError('Runtime setting must be positive: '+key)
    if not 0 <= r['buying_power_reserve_fraction'] < 1:
        raise ValueError('Invalid buying power reserve')
    # Resolve all state files relative to the config, never the caller's directory.
    c['runtime']['state_dir'] = str((Path(path).resolve().parent / c['runtime']['state_dir']).resolve())
    return c

def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

class Store:
    def __init__(self, directory):
        self.path = Path(directory)
        self.path.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path / 'audit.sqlite', timeout=30)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, t TEXT, kind TEXT, symbol TEXT, payload TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
        self.db.commit()
    def event(self, kind, symbol='', **payload):
        t = now().isoformat()
        data = json.dumps(payload, default=str)
        self.db.execute('INSERT INTO events(t,kind,symbol,payload) VALUES (?,?,?,?)', (t,kind,symbol,data))
        self.db.commit()
        print(t, kind, symbol, data, flush=True)
    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default
    def put(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)', (key,json.dumps(value,default=str)))
        self.db.commit()
    def export(self):
        with open(self.path/'events.csv', 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['id','time','kind','symbol','payload'])
            w.writerows(self.db.execute('SELECT * FROM events ORDER BY id'))

def statistics(trades, equity):
    pnls = [t['pnl'] for t in trades]
    wins = sum(x > 0 for x in pnls)
    gains, losses = sum(max(x,0) for x in pnls), -sum(min(x,0) for x in pnls)
    peak = 0.0
    dd = 0.0
    for value in equity:
        peak = max(peak, value)
        if peak:
            dd = max(dd, (peak-value)/peak)
    rs = [t['pnl']/t['risk'] for t in trades if t['risk'] > 0]
    return dict(trades=len(trades), pnl=sum(pnls), win_rate=wins/len(pnls) if pnls else None,
                average_r=sum(rs)/len(rs) if rs else None,
                expectancy=sum(pnls)/len(pnls) if pnls else None,
                profit_factor=gains/losses if losses else None,
                profit_factor_note='undefined when no losing trades' if not losses else '',
                max_drawdown=dd, best_trade=max(trades,key=lambda t:t['pnl'],default=None),
                worst_trade=min(trades,key=lambda t:t['pnl'],default=None))
