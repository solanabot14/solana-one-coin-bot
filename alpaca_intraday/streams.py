"""Callbacks only enqueue. One engine thread owns broker mutations/state."""
import queue
import threading
import time
from alpaca.data.live import StockDataStream
from alpaca.trading.stream import TradingStream
from alpaca.data.enums import DataFeed

class Streams:
    def __init__(self,broker,c,log):
        self.b,self.c,self.log = broker,c,log
        self.events = queue.Queue()
        self.symbols = set()
        self.market = self.trading = None
        self.last_market = self.last_trade = 0.0
        self.threads = []
        self.last_restart = 0.0
    def start(self,symbols):
        self.stop()
        self.symbols = set(symbols)|{'SPY'}  # liquid heartbeat sentinel
        cfg = self.c['runtime']
        self.market = StockDataStream(self.b.key,self.b.secret,feed=DataFeed(self.c['broker']['feed']),
                                      data_timeout=cfg['stream_restart_seconds'])
        self.trading = TradingStream(self.b.key,self.b.secret,paper=self.c['broker']['paper'])
        async def quote(q):
            self.last_market = time.monotonic()
            self.events.put(('quote',q))
        async def bar(b):
            self.last_market = time.monotonic()
            self.events.put(('bar',b))
        async def status(s):
            self.events.put(('status',s))
        async def trade(u):
            self.last_trade = time.monotonic()
            self.events.put(('trade',u))
        self.market.subscribe_quotes(quote,*sorted(self.symbols))
        self.market.subscribe_bars(bar,*sorted(self.symbols))
        self.market.subscribe_trading_statuses(status,*sorted(self.symbols))
        self.trading.subscribe_trade_updates(trade)
        def run(stream,label):
            try:
                stream.run()  # SDK reconnects transport failures internally
            except Exception as e:
                self.events.put(('stream_error',(label,str(e))))
        self.threads = [threading.Thread(target=run,args=(s,n),daemon=True)
                        for s,n in ((self.market,'market'),(self.trading,'trading'))]
        self.last_market = 0
        self.last_restart = time.monotonic()
        for thread in self.threads:
            thread.start()
    def stop(self):
        for s in (self.market,self.trading):
            if s:
                try: s.stop()
                except Exception: pass
        for thread in self.threads:
            thread.join(timeout=self.c['broker']['http_timeout_seconds'])
        if any(thread.is_alive() for thread in self.threads):
            raise RuntimeError('Previous stream did not stop; refusing duplicate connection')
    def healthy(self):
        return all(t.is_alive() for t in self.threads) and self.last_market and time.monotonic()-self.last_market<self.c['runtime']['stream_stale_seconds']
    def drain(self):
        while True:
            try: yield self.events.get_nowait()
            except queue.Empty: break
