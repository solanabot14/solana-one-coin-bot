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
    soup = BeautifulSoup(html, 'html.parser')
    heading = next((h for h in soup.find_all(re.compile('^h[1-6]$'))
                    if re.search(rf'\\b{year}\\s+FOMC Meetings', h.get_text(' ', strip=True))), None)
    if heading is None:
        raise ValueError('FOMC year coverage missing')
    container = heading.find_parent(class_='panel')
    if container is None:
        raise ValueError('FOMC HTML structure changed')
    dates = set()
    for row in container.select('.fomc-meeting'):
        month_node = row.select_one('.fomc-meeting__month')
        day_node = row.select_one('.fomc-meeting__date')
        if not month_node or not day_node:
            continue
        names = month_node.get_text(' ', strip=True).split('/')
        month_numbers = []
        for name in names:
            match = [i for i in range(1, 13)
                     if calendar.month_name[i].lower().startswith(name.lower())]
            if len(match) != 1:
                raise ValueError('Unknown FOMC month ' + name)
            month_numbers.append(match[0])
        ds = [int(x) for x in re.findall(r'\\d+', day_node.get_text())]
        if not 1 <= len(ds) <= 2:
            raise ValueError('Unknown FOMC date')
        first = date(year, month_numbers[0], ds[0])
        last = date(year, month_numbers[-1], ds[-1])
        while first <= last:
            dates.add(first.isoformat())
            first += timedelta(days=1)
    if len(dates) < 8:
        raise ValueError('Incomplete FOMC calendar')
    return dates


def parse_cpi(raw):
    dates = set()
    for event in Calendar.from_ical(raw).walk('VEVENT'):
        if 'consumer price index' not in str(event.get('summary', '')).lower():
            continue
        dt = event.decoded('dtstart')
        if isinstance(dt, datetime):
            dt = dt.astimezone(ET).date() if dt.tzinfo else dt.date()
        dates.add(dt.isoformat())
    if not dates:
        raise ValueError('No CPI dates parsed')
    return dates


def parse_cpi_schedule(html, year):
    """Parse BLS's official CPI schedule page as a fallback for blocked ICS."""
    soup = BeautifulSoup(html, 'html.parser')
    dates = set()
    month_names = '|'.join(calendar.month_abbr[1:])
    pattern = re.compile(rf'\\b(?:{month_names})\\.?\\s+\\d{{1,2}},?\\s+\\d{{4}}\\b', re.I)
    for table in soup.find_all('table'):
        rows = table.find_all('tr')
        header = [cell.get_text(' ', strip=True).lower()
                  for cell in rows[0].find_all(['th', 'td'])] if rows else []
        if not all(any(label in cell for cell in header)
                   for label in ('reference month', 'release date', 'release time')):
            continue
        release_idx = next(i for i, cell in enumerate(header) if 'release date' in cell)
        for row in rows[1:]:
            cells = [cell.get_text(' ', strip=True) for cell in row.find_all(['th', 'td'])]
            if release_idx >= len(cells):
                continue
            match = pattern.search(cells[release_idx])
            if not match:
                continue
            text = re.sub(r'\\s+', ' ', match.group(0)).replace('.', '')
            for fmt in ('%b %d, %Y', '%b %d %Y'):
                try:
                    parsed = datetime.strptime(text, fmt).date()
                    if parsed.year == year:
                        dates.add(parsed.isoformat())
                    break
                except ValueError:
                    pass
    if len(dates) < 6:
        raise ValueError('Incomplete BLS CPI schedule')
    return dates


class Macro:
    def __init__(self, c, log):
        self.c, self.log = c, log
        self.path = Path(c['runtime']['state_dir']) / 'macro.json'

    def allowed(self, t):
        if self.c['risk']['allow_macro_days']:
            return True, 'macro_override'
        cfg = self.c['runtime']
        cache = json.loads(self.path.read_text()) if self.path.exists() else None
        if cache is None or (t - datetime.fromisoformat(cache['fetched'])).total_seconds() > cfg['calendar_refresh_seconds']:
            try:
                def get(url):
                    # Federal Reserve and BLS serve public HTML; a normal browser
                    # user agent avoids the 403 returned for the old placeholder UA.
                    headers = {
                        'User-Agent': 'Mozilla/5.0 (compatible; AlpacaPaperBot/1.0)',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/calendar,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.8',
                    }
                    with urlopen(Request(url, headers=headers),
                                 timeout=cfg['public_http_timeout_seconds']) as response:
                        return response.read()

                try:
                    cpi = sorted(parse_cpi(get(cfg['bls_url'])))
                except Exception:
                    cpi_url = cfg.get('bls_cpi_url', 'https://www.bls.gov/schedule/news_release/cpi.htm')
                    cpi = sorted(parse_cpi_schedule(get(cpi_url), t.astimezone(ET).year))
                fomc = sorted(parse_fed(get(cfg['fed_url']), t.astimezone(ET).year))
                cache = dict(fetched=t.isoformat(), cpi=cpi, fomc=fomc,
                             year=t.astimezone(ET).year)
                atomic_json(self.path, cache)
                self.log.event('macro_refreshed', cpi_dates=cpi, fomc_dates=fomc)
            except Exception as e:
                self.log.event('macro_refresh_error', error=str(e))
        if cache is None or (t - datetime.fromisoformat(cache['fetched'])).total_seconds() > cfg['macro_cache_max_hours'] * 3600:
            return False, 'macro_calendar_unavailable'
        day = t.astimezone(ET).date().isoformat()
        if cache['year'] != t.astimezone(ET).year or not cache['cpi'][0] <= day <= cache['cpi'][-1]:
            return False, 'macro_calendar_uncovered'
        return (False, 'CPI_or_FOMC_day') if day in cache['cpi'] or day in cache['fomc'] else (True, 'macro_clear')
