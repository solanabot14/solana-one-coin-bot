"""Download raw bars and official sessions for an explicit historical universe."""
import argparse,csv
from datetime import datetime,timedelta
from common import load,Store,ET,atomic_json
from broker import Broker
from scanner import fetch_minutes
from alpaca.trading.requests import GetCalendarRequest

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--config',default='config.toml')
    p.add_argument('--symbols',required=True,help='Comma-separated historical universe, not today\'s winners')
    p.add_argument('--start',required=True,help='YYYY-MM-DD; first evaluated session')
    p.add_argument('--end',required=True,help='YYYY-MM-DD; inclusive')
    p.add_argument('--output',default='bars.csv')
    p.add_argument('--sessions',default='sessions.json')
    a=p.parse_args()
    c=load(a.config)
    b=Broker(c,Store(c['runtime']['state_dir']))
    start=datetime.fromisoformat(a.start).replace(tzinfo=ET)
    end=datetime.fromisoformat(a.end).replace(tzinfo=ET)+timedelta(days=1)
    data=fetch_minutes(b,a.symbols.split(','),start-timedelta(days=c['strategy']['history_calendar_days']),end,c)
    with open(a.output,'w',newline='') as f:
        w=csv.writer(f)
        w.writerow(['timestamp','symbol','open','high','low','close','volume','vwap'])
        for sym,rows in data.items():
            for x in rows: w.writerow([x.time.isoformat(),sym,x.open,x.high,x.low,x.close,x.volume,x.vwap])
    days=b.read(b.trade.get_calendar,GetCalendarRequest(start=start.date(),end=(end-timedelta(days=1)).date()))
    def local(t): return (t.replace(tzinfo=ET) if t.tzinfo is None else t).isoformat()
    atomic_json(a.sessions,{str(d.date):dict(open=local(d.open),close=local(d.close)) for d in days})
