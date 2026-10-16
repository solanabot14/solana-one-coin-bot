"""Point-in-time scanner; all volume comparisons use the selected data feed."""
from datetime import timedelta
from alpaca.data.requests import StockBarsRequest, StockLatestQuoteRequest, MarketMoversRequest, MostActivesRequest, NewsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed, Adjustment
from common import ET, now
from strategy import Bar, at, same_time_rvol


def bars_from_sdk(result):
    return {sym:[Bar(sym,b.timestamp,b.open,b.high,b.low,b.close,b.volume,b.vwap) for b in rows]
            for sym,rows in result.data.items()}

def fetch_minutes(broker, symbols, start, end, c):
    return bars_from_sdk(broker.read(broker.data.get_stock_bars,StockBarsRequest(
        symbol_or_symbols=list(symbols),start=start,end=end,timeframe=TimeFrame.Minute,
        feed=DataFeed(c['broker']['feed']),adjustment=Adjustment.RAW)))

def histories(bars, date, count):
    days = {}
    for b in bars:
        d = b.time.astimezone(ET).date()
        if d < date:
            days.setdefault(d,[]).append(b)
    return [days[d] for d in sorted(days)[-count:]]

class Scanner:
    def __init__(self,broker,c,log):
        self.b,self.c,self.log = broker,c,log
        self.cache_date = None
        self.minute_history = {}
        self.daily = {}
    def scan(self,t,opening):
        c,s = self.c,self.c['strategy']
        symbols = set(s['seed_symbols'])
        movers = self.b.read(self.b.screen.get_market_movers,MarketMoversRequest(top=s['scanner_pool']))
        active = self.b.read(self.b.screen.get_most_actives,MostActivesRequest(top=s['scanner_pool']))
        symbols.update(x.symbol for x in movers.gainers)
        symbols.update(x.symbol for x in active.most_actives)
        symbols = sorted(x for x in symbols if x.isalpha())
        if self.cache_date != t.astimezone(ET).date():
            self.minute_history,self.daily = {},{}
            self.cache_date = t.astimezone(ET).date()
        missing = [x for x in symbols if x not in self.daily]
        start = opening-timedelta(days=s['history_calendar_days'])
        if missing:
            self.minute_history.update(fetch_minutes(self.b,missing,start,opening.replace(hour=0,minute=0),c))
            daily = self.b.read(self.b.data.get_stock_bars,StockBarsRequest(
                symbol_or_symbols=missing,start=start,end=opening.replace(hour=0,minute=0),
                timeframe=TimeFrame.Day,feed=DataFeed(c['broker']['feed']),adjustment=Adjustment.RAW))
            self.daily.update(daily.data)
        # Only bars completed by scanner time. Stop at 09:25, not at a later tick.
        t = now()
        cutoff = opening.replace(hour=int(s['scanner_end'][:2]),minute=int(s['scanner_end'][3:]))
        end = min(t,cutoff)
        prestart = opening.replace(hour=int(s['scanner_start'][:2]),minute=int(s['scanner_start'][3:]))
        pre = fetch_minutes(self.b,symbols,prestart,end,c)
        ranked = []
        for sym in symbols:
            try:
                reason = None
                days = [b for b in self.daily.get(sym,[]) if b.timestamp.astimezone(ET).date()<opening.date()][-s['history_sessions']:]
                today = [b for b in pre.get(sym,[]) if b.time+timedelta(minutes=1)<=end]
                hist = histories(self.minute_history.get(sym,[]),opening.date(),s['history_sessions'])
                # Premarket baseline uses identical 08:00..current slots for each past day.
                rvol = same_time_rvol(hist,today,False,s['minimum_history_sessions'])
                if len(days)<s['minimum_history_sessions'] or len(hist)<s['minimum_history_sessions'] or not today:
                    reason = 'insufficient_history'
                else:
                    q = None
                    price = today[-1].close
                    gap = price/days[-1].close-1
                    avg = sum(b.volume for b in days)/len(days)
                    if not s['price_min']<=price<=s['price_max']: reason='price'
                    elif avg <= s['average_daily_volume_min']: reason='daily_volume'
                    elif rvol is None or rvol < s['rvol_min']: reason='premarket_rvol'
                    elif gap < s['gap_min']: reason='gap'

                if reason:
                    self.log.event('scanner_rejection',sym,reason=reason)
                    continue
                asset = self.b.read(self.b.trade.get_asset,sym)
                if not asset.tradable or str(asset.status.value)!='active' or str(asset.asset_class.value)!='us_equity':
                    self.log.event('scanner_rejection',sym,reason='ineligible_asset')
                    continue
                news = self.b.read(self.b.news.get_news,NewsRequest(symbols=sym,
                    start=t-timedelta(hours=s['catalyst_age_hours']),end=t,limit=50,sort='desc'))
                # Keyword matching establishes a news candidate, NOT a bullish causal claim.
                catalysts = [n for n in news.news if n.created_at<=t and sym in n.symbols
                             and any(word in n.headline.lower() for word in s['catalyst_terms'])]
                if not catalysts:
                    self.log.event('scanner_rejection',sym,reason='no_catalyst_headline')
                    continue
                fresh = self.b.read(self.b.data.get_stock_latest_quote,StockLatestQuoteRequest(
                    symbol_or_symbols=sym,feed=DataFeed(c['broker']['feed'])))
                q = fresh.get(sym)
                if not q or abs((now()-q.timestamp).total_seconds())>s['quote_max_age_seconds']:
                    self.log.event('scanner_rejection',sym,reason='stale_quote')
                    continue
                if q.bid_price<=0 or q.ask_price<q.bid_price or (q.ask_price-q.bid_price)/((q.ask_price+q.bid_price)/2)>=s['spread_max']:
                    self.log.event('scanner_rejection',sym,reason='spread')
                    continue
                row = dict(symbol=sym,price=price,gap=gap,rvol=rvol,average_volume=avg,
                           catalyst=catalysts[0].headline,catalyst_time=catalysts[0].created_at.isoformat(),
                           scan_time=t.isoformat(),score=rvol*gap)
                ranked.append(row)
                self.log.event('scanner_candidate',sym,**{k:v for k,v in row.items() if k!='symbol'})
            except Exception as e:
                self.log.event('scanner_error',sym,error=str(e))
        ranked.sort(key=lambda x:x['score'],reverse=True)
        return ranked[:s['scanner_top']]
