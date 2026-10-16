"""Run independently of engine.py. Uses broker calendar even without heartbeat."""
import argparse
import fcntl
import json
import time
from datetime import datetime,timedelta
from pathlib import Path
from alpaca.trading.requests import GetCalendarRequest
from common import load,Store,now,ET,stamp
from broker import Broker

def must_flatten(c,t,opening,close,heartbeat,kill,boot_elapsed):
    if kill:
        return 'kill_switch'
    if close and t>=close-timedelta(minutes=c['risk']['flatten_minutes_before_close']):
        return 'scheduled_close'
    if opening and opening<=t<close:
        if heartbeat is None:
            if boot_elapsed>c['runtime']['bootstrap_grace_seconds']:
                return 'missing_heartbeat'
        elif (t-datetime.fromisoformat(heartbeat['time'])).total_seconds()>c['runtime']['heartbeat_stale_seconds'] or not heartbeat.get('healthy'):
            return 'stale_or_unhealthy_heartbeat'
    return None

def run(c):
    log = Store(c['runtime']['state_dir'])
    path = log.path
    lock = open(path/'watchdog.lock','w')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    b = Broker(c,log)
    boot = time.monotonic()
    while True:
        try:
            t = now()
            cal = b.read(b.trade.get_calendar,GetCalendarRequest(start=t.astimezone(ET).date(),end=t.astimezone(ET).date()))
            opening=close=None
            if cal:
                opening,close = cal[0].open,cal[0].close
                opening = opening.replace(tzinfo=ET) if opening.tzinfo is None else opening
                close = close.replace(tzinfo=ET) if close.tzinfo is None else close
            hbpath = path/'heartbeat.json'
            heartbeat = json.loads(hbpath.read_text()) if hbpath.exists() else None
            # KILL is an operator latch. HALT-YYYY-MM-DD is a durable incident
            # record used to block entries, but must not itself retrigger
            # liquidation every poll after the account is already flat.
            kill = (path/'KILL').exists()
            reason = must_flatten(c,t,opening,close,heartbeat,kill,time.monotonic()-boot)
            # Positions outside regular hours are always an incident, never accepted.
            if not reason and (not cal or t<opening or t>=close):
                if b.read(b.trade.get_all_positions): reason='outside_session_exposure'
            if reason:
                (path/('HALT-'+stamp(t))).touch()
                log.event('watchdog_alarm',reason=reason)
                b.flatten_step('watchdog:'+reason)
        except Exception as e:
            log.event('watchdog_error',error=str(e))
        time.sleep(c['runtime']['watchdog_poll_seconds'])

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--config',default='config.toml')
    run(load(p.parse_args().config))
