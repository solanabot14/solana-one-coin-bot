"""All Alpaca traffic goes through the official SDK; no handwritten broker REST."""
import os
import fcntl
from contextlib import contextmanager
from pathlib import Path
import time
from requests import Session
from common import stamp,now
from dotenv import load_dotenv
from alpaca.trading.client import TradingClient
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.historical.news import NewsClient
from alpaca.data.historical.screener import ScreenerClient
from alpaca.common.exceptions import APIError
from alpaca.trading.requests import GetOrdersRequest
from alpaca.trading.enums import QueryOrderStatus

class TimeoutSession(Session):
    def __init__(self, timeout):
        super().__init__()
        self.timeout = timeout
    def request(self, method, url, **kwargs):
        kwargs.setdefault('timeout', self.timeout)
        return super().request(method,url,**kwargs)

def credentials(c):
    load_dotenv()
    paper = c['broker']['paper']
    if not paper and c['broker']['live_confirmation'] != 'I_ACCEPT_LIVE_TRADING_RISK':
        raise ValueError('Live mode requires live_confirmation=I_ACCEPT_LIVE_TRADING_RISK')
    prefix = 'ALPACA_PAPER_' if paper else 'ALPACA_LIVE_'
    key, secret = os.getenv(prefix+'API_KEY'), os.getenv(prefix+'SECRET_KEY')
    if not key or not secret:
        raise ValueError('Missing '+prefix+'API_KEY / SECRET_KEY in .env')
    return key,secret

class Broker:
    def __init__(self,c,log):
        self.c, self.log = c,log
        self.key,self.secret = credentials(c)
        self.trade = TradingClient(self.key,self.secret,paper=c['broker']['paper'])
        self.data = StockHistoricalDataClient(self.key,self.secret)
        self.news = NewsClient(self.key,self.secret)
        self.screen = ScreenerClient(self.key,self.secret)
        # alpaca-py 0.44 has no public HTTP timeout option. This narrowly scoped
        # transport hook is pinned and tested; SDK still owns every API request.
        for client in (self.trade,self.data,self.news,self.screen):
            client._session.close()
            client._session = TimeoutSession(c['broker']['http_timeout_seconds'])
            client._retry = 0  # never transparently resubmit POST on an ambiguous timeout
    def read(self, fn, *args, **kwargs):
        b = self.c['broker']
        for attempt in range(b['api_attempts']):
            try:
                return fn(*args,**kwargs)
            except Exception as e:
                code = getattr(e,'status_code',None)
                if isinstance(e,APIError) and code not in (429,500,502,503,504):
                    raise
                self.log.event('api_retry',attempt=attempt,error=str(e))
                if attempt+1 == b['api_attempts']:
                    raise
                time.sleep(min(b['retry_max_seconds'],b['retry_initial_seconds']*2**attempt))
    def orders(self):
        return self.read(self.trade.get_orders,GetOrdersRequest(status=QueryOrderStatus.OPEN,nested=True))
    @contextmanager
    def mutation_lock(self):
        with open(Path(self.c['runtime']['state_dir'])/'account-actions.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(lock,fcntl.LOCK_UN)
    def mutate(self,fn,*args,**kwargs):
        with self.mutation_lock():
            if getattr(fn,'__name__','')=='submit_order' and args and getattr(args[0],'side',None).value=='buy':
                path = Path(self.c['runtime']['state_dir'])
                if (path/'KILL').exists() or (path/('HALT-'+stamp(now()))).exists():
                    raise RuntimeError('Entry blocked by kill/watchdog latch')
            return fn(*args,**kwargs)
    def flatten_step(self,reason):
        with self.mutation_lock():
            return self._flatten_step(reason)
    def _flatten_step(self,reason):
        """One bounded attempt. Caller retries and verifies; never assumes success."""
        self.log.event('flatten_requested',reason=reason)
        try:
            existing = self.orders()
            # Do not cancel an already-submitted market liquidation on every retry.
            # Waiting avoids a cancel/recreate loop and duplicate sells.
            market_exits = [o for o in walk_orders(existing)
                            if getattr(getattr(o,'side',None),'value',None)=='sell'
                            and getattr(getattr(o,'type',None),'value',None)=='market']
            if market_exits:
                self.log.event('flatten_pending',reason='market_liquidation_in_flight')
                return False
            self.trade.cancel_orders()
            # Cancellation is asynchronous. Do NOT sell against still-live exits.
            if self.orders():
                self.log.event('flatten_pending',reason='waiting_for_order_cancellations')
                return False
            positions = self.read(self.trade.get_all_positions)
            if positions:
                result = self.trade.close_all_positions(cancel_orders=True)
                self.log.event('close_all_response',response=str(result))
            remaining = self.read(self.trade.get_all_positions)
            pending = self.orders()
            flat = not remaining and not pending
            self.log.event('flatten_verified' if flat else 'flatten_pending',
                           positions=[p.symbol for p in remaining],orders=len(pending))
            return flat
        except Exception as e:
            self.log.event('flatten_error',error=str(e))
            return False

def walk_orders(orders):
    seen = set()
    def walk(order):
        if str(order.id) in seen:
            return
        seen.add(str(order.id))
        yield order
        for leg in order.legs or []:
            yield from walk(leg)
    for o in orders:
        yield from walk(o)
