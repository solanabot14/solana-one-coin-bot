"""Refresh official CPI/FOMC schedules; unavailable/uncovered calendar blocks entries."""
import calendar
import re
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from bs4 import BeautifulSoup
from icalendar import Calendar
from common import ET, atomic_json

def parse_fed(html, year):
    soup = BeautifulSoup(html,'html.parser')
    heading = next((h for h in soup.find_all(re.compile('^h[1-6]$'))
                    if re.search(rf'\b{year}\s+FOMC Meetings',h.get_text(' ',strip=True))),None)
    if heading is None:
        raise ValueError('FOMC year coverage missing')
    container = heading.find_parent(class_='panel')
    if container is None:
        raise ValueError('FOMC HTML structure changed')
    dates = set()
    for row in container.select('.fomc-meeting'):
        month_node, day_node = row.select_one('.fomc-meeting__month'),row.select_one('.fomc-meeting__date')
        if not month_node or not day_node:
            continue
        month_text = month_node.get_text(' ',strip=True)
        names = month_text.split('/')
        month_numbers = []
        for name in names:
            match = [i for i in range(1,13) if calendar.month_name[i].lower().startswith(name.lower())]
            if len(match)!=1:
                raise ValueError('Unknown FOMC month '+name)
            month_numbers.append(match[0])
        ds = [int(x) for x in re.findall(r'\d+',day_node.get_text())]
        if not 1<=len(ds)<=2:
            raise ValueError('Unknown FOMC date')
        first,last = date(year,month_numbers[0],ds[0]),date(year,month_numbers[-1],ds[-1])
        while first<=last:
            dates.add(first.isoformat())
            first += timedelta(days=1)
    if len(dates)<8:
        raise ValueError('Incomplete FOMC calendar')
    return dates

def parse_cpi(raw):
    dates = set()
    for event in Calendar.from_ical(raw).walk('VEVENT'):
        if 'consumer price index' not in str(event.get('summary','')).lower():
            continue
        dt = event.decoded('dtstart')
        if isinstance(dt,datetime):
            dt = dt.astimezone(ET).date() if dt.tzinfo else dt.date()
        dates.add(dt.isoformat())
    if not dates:
        raise ValueError('No CPI dates parsed')
    return dates

class Macro:
    def __init__(self,c,log):
        self.c,self.log = c,log
        self.path = Path(c['runtime']['state_dir'])/'macro.json'
    def allowed(self,t):
        if self.c['risk']['allow_macro_days']:
            return True,'macro_override'
        cfg = self.c['runtime']
        cache = json.loads(self.path.read_text()) if self.path.exists() else None
        if cache is None or (t-datetime.fromisoformat(cache['fetched'])).total_seconds()>cfg['calendar_refresh_seconds']:
            try:
                def get(url):
                    headers={
                        'User-Agent':cfg['public_http_user_agent'],
                        'Accept':'text/calendar, text/html, application/xhtml+xml, */*',
                    }
                    with urlopen(Request(url,headers=headers),timeout=cfg['public_http_timeout_seconds']) as response:
                        return response.read()
                cpi = sorted(parse_cpi(get(cfg['bls_url'])))
                fomc = sorted(parse_fed(get(cfg['fed_url']),t.astimezone(ET).year))
                cache = dict(fetched=t.isoformat(),cpi=cpi,fomc=fomc,year=t.astimezone(ET).year)
                atomic_json(self.path,cache)
                self.log.event('macro_refreshed',cpi_dates=cpi,fomc_dates=fomc)
            except Exception as e:
                self.log.event('macro_refresh_error',error=str(e))
        if cache is None or (t-datetime.fromisoformat(cache['fetched'])).total_seconds()>cfg['macro_cache_max_hours']*3600:
            return False,'macro_calendar_unavailable'
        day = t.astimezone(ET).date().isoformat()
        if cache['year']!=t.astimezone(ET).year or not cache['cpi'][0]<=day<=cache['cpi'][-1]:
            return False,'macro_calendar_uncovered'
        return (False,'CPI_or_FOMC_day') if day in cache['cpi'] or day in cache['fomc'] else (True,'macro_clear')
