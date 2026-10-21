"""Point-in-time premarket research scanner using current news, liquidity and price action."""
from datetime import timedelta
from alpaca.data.requests import StockBarsRequest, StockLatestQuoteRequest, MostActivesRequest, NewsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed, Adjustment
from common import ET, now
from strategy import Bar, same_time_rvol


def bars_from_sdk(result):
    return {sym: [Bar(sym,b.timestamp,b.open,b.high,b.low,b.close,b.volume,b.vwap) for b in rows]
            for sym,rows in result.data.items()}

def fetch_minutes(broker, symbols, start, end, c):
    if not symbols:
        return {}
    return bars_from_sdk(broker.read(broker.data.get_stock_bars, StockBarsRequest(
        symbol_or_symbols=list(symbols), start=start, end=end, timeframe=TimeFrame.Minute,
        feed=DataFeed(c['broker']['feed']), adjustment=Adjustment.RAW)))

def histories(bars, date, count):
    days = {}
    for b in bars:
        d = b.time.astimezone(ET).date()
        if d < date:
            days.setdefault(d, []).append(b)
    return [days[d] for d in sorted(days)[-count:]]

def article_text(n):
    return ((getattr(n,'headline','') or '') + ' ' + (getattr(n,'summary','') or '')).lower()

class Scanner:
    def __init__(self, broker, c, log):
        self.b,self.c,self.log = broker,c,log
        self.cache_date = None
        self.minute_history = {}
        self.daily = {}

    def scan(self, t, opening):
        c,s = self.c,self.c['strategy']
        t = now()
        cutoff = opening.replace(hour=int(s['scanner_end'][:2]), minute=int(s['scanner_end'][3:]))
        end = min(t, cutoff)
        prestart = opening.replace(hour=int(s['scanner_start'][:2]), minute=int(s['scanner_start'][3:]))

        # Do NOT use Alpaca's stock movers endpoint before the open. It resets at
        # the regular-session open, so premarket calls can still reflect yesterday.
        symbols = set(s['seed_symbols'])
        active = self.b.read(self.b.screen.get_most_actives, MostActivesRequest(top=s['scanner_pool']))
        symbols.update(x.symbol for x in active.most_actives)

        # Pull the current news tape once, then use the tagged symbols to expand
        # the universe. This catches event-driven names that are not in our seeds.
        market_news = self.b.read(self.b.news.get_news, NewsRequest(
            start=t-timedelta(hours=s['catalyst_age_hours']), end=t, limit=50, sort='desc'))
        news_by_symbol = {}
        for n in market_news.news:
            if n.created_at > t:
                continue
            for sym in (n.symbols or []):
                if isinstance(sym,str) and sym.isalpha():
                    news_by_symbol.setdefault(sym, []).append(n)
                    symbols.add(sym)

        symbols = sorted(x for x in symbols if x.isalpha())
        benchmark_symbols = {'SPY','QQQ'}
        universe = sorted(set(symbols) | benchmark_symbols)

        if self.cache_date != t.astimezone(ET).date():
            self.minute_history,self.daily = {},{}
            self.cache_date = t.astimezone(ET).date()
        missing = [x for x in universe if x not in self.daily]
        start = opening-timedelta(days=s['history_calendar_days'])
        if missing:
            self.minute_history.update(fetch_minutes(self.b, missing, start, opening.replace(hour=0,minute=0), c))
            daily = self.b.read(self.b.data.get_stock_bars, StockBarsRequest(
                symbol_or_symbols=missing, start=start, end=opening.replace(hour=0,minute=0),
                timeframe=TimeFrame.Day, feed=DataFeed(c['broker']['feed']), adjustment=Adjustment.RAW))
            self.daily.update(daily.data)

        pre = fetch_minutes(self.b, universe, prestart, end, c)
        benchmark_gaps = []
        for bench in benchmark_symbols:
            ds = [b for b in self.daily.get(bench,[]) if b.timestamp.astimezone(ET).date() < opening.date()]
            tb = [b for b in pre.get(bench,[]) if b.time+timedelta(minutes=1) <= end]
            if ds and tb and ds[-1].close:
                benchmark_gaps.append(tb[-1].close/ds[-1].close-1)
        market_gap = sum(benchmark_gaps)/len(benchmark_gaps) if benchmark_gaps else 0.0

        ranked = []
        for sym in symbols:
            if sym in benchmark_symbols:
                continue
            try:
                reason = None
                days = [b for b in self.daily.get(sym,[]) if b.timestamp.astimezone(ET).date() < opening.date()][-s['history_sessions']:]
                today = [b for b in pre.get(sym,[]) if b.time+timedelta(minutes=1) <= end]
                hist = histories(self.minute_history.get(sym,[]), opening.date(), s['history_sessions'])
                rvol = same_time_rvol(hist, today, False, s['minimum_history_sessions'])
                if len(days) < s['minimum_history_sessions'] or len(hist) < s['minimum_history_sessions'] or not today:
                    reason = 'insufficient_history'
                else:
                    price = today[-1].close
                    gap = price/days[-1].close-1
                    avg = sum(b.volume for b in days)/len(days)
                    pre_dollar = sum(b.close*b.volume for b in today)
                    pre_move = price/today[0].open-1 if today[0].open else 0
                    relative_gap = gap-market_gap
                    if not s['price_min'] <= price <= s['price_max']: reason='price'
                    elif avg <= s['average_daily_volume_min']: reason='daily_volume'
                    elif pre_dollar < s.get('premarket_dollar_volume_min',500000): reason='premarket_dollar_volume'
                    elif rvol is None or rvol < s['rvol_min']: reason='premarket_rvol'
                    elif gap < s['gap_min'] or gap > s.get('gap_max',0.15): reason='gap'
                    elif pre_move < s.get('premarket_move_min',0.003): reason='premarket_momentum'
                    elif relative_gap < s.get('relative_strength_min',0.005): reason='weak_vs_market'
                if reason:
                    self.log.event('scanner_rejection', sym, reason=reason)
                    continue

                asset = self.b.read(self.b.trade.get_asset, sym)
                if not asset.tradable or str(asset.status.value) != 'active' or str(asset.asset_class.value) != 'us_equity':
                    self.log.event('scanner_rejection', sym, reason='ineligible_asset')
                    continue

                articles = news_by_symbol.get(sym, [])
                if not articles:
                    news = self.b.read(self.b.news.get_news, NewsRequest(
                        symbols=sym, start=t-timedelta(hours=s['catalyst_age_hours']), end=t, limit=20, sort='desc'))
                    articles = [n for n in news.news if n.created_at <= t and sym in (n.symbols or [])]
                if not articles:
                    self.log.event('scanner_rejection', sym, reason='no_recent_company_news')
                    continue
                articles.sort(key=lambda n:n.created_at, reverse=True)
                catalyst = articles[0]
                catalyst_strength = 1 + int(any(term in article_text(catalyst) for term in s['catalyst_terms']))

                fresh = self.b.read(self.b.data.get_stock_latest_quote, StockLatestQuoteRequest(
                    symbol_or_symbols=sym, feed=DataFeed(c['broker']['feed'])))
                q = fresh.get(sym)
                if not q or abs((now()-q.timestamp).total_seconds()) > s['quote_max_age_seconds']:
                    self.log.event('scanner_rejection', sym, reason='stale_quote')
                    continue
                spread = (q.ask_price-q.bid_price)/((q.ask_price+q.bid_price)/2) if q.bid_price > 0 else 1
                if q.bid_price <= 0 or q.ask_price < q.bid_price or spread >= s['spread_max']:
                    self.log.event('scanner_rejection', sym, reason='spread')
                    continue

                # Rank current opportunity, not fame: relative strength, RVOL,
                # premarket liquidity and a company-specific catalyst all matter.
                liquidity_score = min(pre_dollar/5_000_000, 3.0)
                score = relative_gap*100*2.0 + min(rvol,8.0) + liquidity_score + catalyst_strength
                row = dict(symbol=sym, price=price, gap=gap, market_gap=market_gap,
                           relative_gap=relative_gap, rvol=rvol, premarket_move=pre_move,
                           premarket_dollar_volume=pre_dollar, average_volume=avg,
                           catalyst=catalyst.headline, catalyst_time=catalyst.created_at.isoformat(),
                           catalyst_strength=catalyst_strength, scan_time=t.isoformat(), score=score)
                ranked.append(row)
                self.log.event('scanner_candidate', sym, **{k:v for k,v in row.items() if k!='symbol'})
            except Exception as e:
                self.log.event('scanner_error', sym, error=str(e))
        ranked.sort(key=lambda x:x['score'], reverse=True)
        return ranked[:s['scanner_top']]
