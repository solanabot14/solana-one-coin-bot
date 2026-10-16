"""Long-only ORB execution. Requires an EXCLUSIVE Alpaca equities account."""
import argparse
import fcntl
import json
import multiprocessing as mp
import signal as signals
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from alpaca.trading.enums import OrderSide, TimeInForce, OrderClass, QueryOrderStatus
from alpaca.trading.requests import (LimitOrderRequest, TakeProfitRequest, StopLossRequest,
    ReplaceOrderRequest, GetOrdersRequest, GetCalendarRequest, GetOrderByIdRequest)
from common import ET, now, stamp, load, Store, atomic_json, statistics
from broker import Broker, walk_orders
from scanner import Scanner, fetch_minutes, histories
from macro import Macro
from strategy import Bar, signal, size, managed_exit, at
from streams import Streams

TERMINAL = {'filled','canceled','expired','rejected','replaced'}

def research_job(config,t,opening):
    log = Store(config['runtime']['state_dir'])
    try:
        b = Broker(config,log)
        allowed, reason = Macro(config,log).allowed(t)
        rows = Scanner(b,config,log).scan(t,opening) if allowed else []
        atomic_json(Path(config['runtime']['state_dir'])/'research.json',
                    dict(date=stamp(t),asof=t.isoformat(),allowed=allowed,reason=reason,rows=rows))
    except Exception as e:
        log.event('research_failed',error=str(e))

def order_status(o):
    return o.status.value

class Engine:
    def __init__(self,c):
        self.c = c
        self.log = Store(c['runtime']['state_dir'])
        self.path = self.log.path
        self.b = Broker(c,self.log)
        self.stream = Streams(self.b,c,self.log)
        self.meta = self.log.get('meta',{})
        self.day = self.log.get('day',{})
        self.quotes,self.bars,self.history,self.halts,self.seen = {},{},{},{},{}
        self.research = None
        self.last_research = 0
        self.worker = None
        self.calendar = None
        self.calendar_at = 0
        self.stop_requested = False
        self.equity_curve = self.log.get('equity_curve',[])
    def persist(self):
        self.log.put('meta',self.meta)
        self.log.put('day',self.day)
        self.log.put('equity_curve',self.equity_curve)
    def heartbeat(self,healthy):
        atomic_json(self.path/'heartbeat.json',dict(time=now().isoformat(),healthy=bool(healthy),
                    paper=self.c['broker']['paper'],date=stamp(now())))
    def halt(self,reason):
        self.day['halted'] = True
        self.day['halt_reason'] = reason
        self.persist()
        self.log.event('trading_halted',reason=reason)
    def bootstrap(self):
        self.heartbeat(False)
        self.log.event('startup',paper=self.c['broker']['paper'],feed=self.c['broker']['feed'])
        if self.c['broker']['feed']=='iex':
            self.log.event('WARNING',reason='IEX is one exchange, roughly 2% of volume; RVOL/spreads are not consolidated. SIP recommended.',
                           entries_enabled=self.c['broker']['allow_iex_entries'])
        account = self.b.read(self.b.trade.get_account)
        if self.day.get('date') != stamp(now()):
            self.reset_day(account)
        # Never infer orphan cost basis or keep inherited exposure overnight.
        if self.b.read(self.b.trade.get_all_positions) or self.b.orders() or self.meta:
            self.halt('restart_with_exposure_or_unreconciled_state')
            self.b.flatten_step('restart_recovery')
        self.stream.start(['SPY'])
    def reset_day(self,account):
        self.day = dict(date=stamp(now()),equity=float(account.equity),trades=0,losses=0,
                        cooldown_until=None,halted=False,halt_reason=None,completed=[])
        self.equity_curve = [float(account.equity)]
        self.persist()
    def session(self,t):
        if self.calendar is None or time.monotonic()-self.calendar_at>self.c['runtime']['calendar_refresh_seconds']:
            cal = self.b.read(self.b.trade.get_calendar,GetCalendarRequest(start=t.astimezone(ET).date(),end=t.astimezone(ET).date()))
            self.calendar = cal[0] if cal else False
            self.calendar_at = time.monotonic()
        if self.calendar is False:
            return None
        def local(dt):
            return dt.replace(tzinfo=ET) if dt.tzinfo is None else dt.astimezone(ET)
        return local(self.calendar.open),local(self.calendar.close)
    def research_tick(self,t,opening):
        s = self.c['strategy']
        if s['scanner_start']<=at(t)<=s['scanner_end'] and time.monotonic()-self.last_research>=s['scanner_interval_seconds']:
            if self.worker is None or not self.worker.is_alive():
                if self.worker: self.worker.join()
                self.worker = mp.get_context('spawn').Process(target=research_job,args=(self.c,t,opening),daemon=True)
                self.worker.start()
                self.last_research = time.monotonic()
        path = self.path/'research.json'
        if path.exists():
            obj = json.loads(path.read_text())
            if obj.get('date')==stamp(t) and (self.research is None or obj['asof']!=self.research['asof']):
                # A delayed scanner result is not a current premarket selection.
                if at(datetime.fromisoformat(obj['asof']))>s['scanner_end']:
                    return
                self.research = obj
                archive = self.path/'research-archive'
                archive.mkdir(exist_ok=True)
                atomic_json(archive/(obj['date']+'.json'),obj)
                symbols = [row['symbol'] for row in obj['rows']]
                self.log.event('watchlist',symbols=symbols,macro=obj['reason'])
                # Warm-up runs ONLY before market open. No blocking backfills during trading.
                if t<opening and symbols:
                    start = opening-timedelta(days=s['history_calendar_days'])
                    data = fetch_minutes(self.b,symbols,start,t,self.c)
                    for sym in symbols:
                        self.history[sym] = histories(data.get(sym,[]),opening.date(),s['history_sessions'])
                        # Includes recent prior-session bars for ATR warm-up, and today's premarket.
                        past = [b for b in data.get(sym,[]) if b.time.astimezone(ET).date()<opening.date()]
                        today = [b for b in data.get(sym,[]) if b.time.astimezone(ET).date()==opening.date()]
                        self.bars[sym] = past[-(s['volume_lookback']+s['atr_period']):]+today
                    self.stream.start(symbols)
    def drain(self):
        for kind,obj in self.stream.drain():
            if kind=='quote':
                self.quotes[obj.symbol] = obj
            elif kind=='bar':
                b = Bar(obj.symbol,obj.timestamp,obj.open,obj.high,obj.low,obj.close,obj.volume,obj.vwap)
                rows = self.bars.setdefault(b.symbol,[])
                if not rows or b.time>rows[-1].time:
                    rows.append(b)
            elif kind=='trade':
                self.log.event('trade_update',obj.order.symbol,event=obj.event.value,order=obj.order.model_dump(mode='json'))
                if obj.event.value=='rejected':
                    self.halt('broker_order_rejection')
            elif kind=='status':
                self.log.event('trading_status',obj.symbol,status=obj.status_code,reason=obj.reason_message)
                if obj.status_code in ('H','P','2','F'):
                    self.halts[obj.symbol] = float('inf')
                elif obj.status_code in ('T','3'):
                    self.halts[obj.symbol] = time.time()+self.c['strategy']['halt_resume_cooldown_seconds']
                # Q means quotes resumed, not trading resumed.
            else:
                self.log.event('stream_error',detail=obj)
    def reconcile(self,t,positions):
        """Broker snapshots are authoritative even if a trade websocket event was missed."""
        if not self.meta:
            if positions:
                self.halt('unowned_account_position')
            return
        all_orders = self.b.read(self.b.trade.get_orders,GetOrdersRequest(
            status=QueryOrderStatus.ALL,after=datetime.fromisoformat(self.day['date']).replace(tzinfo=ET),
            limit=500,nested=True))
        flat_orders = list(walk_orders(all_orders))
        by_id = {str(o.id):o for o in flat_orders}
        # A long-lived runner can generate many stop replacements. Parent orders
        # must not disappear merely because the bulk endpoint's page is full.
        for saved in self.meta.values():
            for parent_id in saved['parents']:
                if parent_id not in by_id:
                    parent = self.b.read(self.b.trade.get_order_by_id,parent_id,GetOrderByIdRequest(nested=True))
                    for order in walk_orders([parent]):
                        by_id[str(order.id)] = order
        flat_orders = list(by_id.values())
        posmap = {p.symbol:p for p in positions}
        if set(posmap)-set(self.meta):
            self.halt('unowned_account_position')
        for sym,p in list(self.meta.items()):
            clients = {o.client_order_id:o for o in flat_orders}
            for client in p.get('expected_clients',[]):
                if client in clients and str(clients[client].id) not in p['parents']:
                    p['parents'].append(str(clients[client].id))
                    p['order_ids'].append(str(clients[client].id))
            p['parents'].sort(key=lambda k: by_id[k].client_order_id if k in by_id else k)
            parents = [by_id.get(k) for k in p['parents']]
            if any(o is None for o in parents):
                self.halt('missing_parent_order_reconciliation')
                continue
            related = [o for o in flat_orders if o.symbol==sym and
                       (str(o.id) in p['order_ids'] or any(str(o.id)==str(leg.id) for parent in parents for leg in parent.legs or []))]
            for parent in parents:
                for leg in parent.legs or []:
                    if str(leg.id) not in p['order_ids']:
                        p['order_ids'].append(str(leg.id))
            for o in related:
                key = str(o.id)
                record = dict(qty=float(o.filled_qty),price=float(o.filled_avg_price or 0),
                              side=o.side.value,status=order_status(o))
                old = p['fills'].get(key)
                if old!=record:
                    self.log.event('order_snapshot',sym,order=o.model_dump(mode='json'))
                    p['fills'][key] = record
                if 0<float(o.filled_qty)<float(o.qty):
                    # Alpaca bracket children activate only on a COMPLETE parent fill.
                    self.halt('partial_fill_requires_reconciliation')
                if order_status(o)=='rejected':
                    self.halt('broker_rejection_or_margin_restriction')
            if p.get('close_id') and p['close_id'] in by_id and order_status(by_id[p['close_id']]) in ('canceled','expired','rejected'):
                self.halt('symbol_close_failed')
            buys = [o for o in related if o.side==OrderSide.BUY and float(o.filled_qty)>0]
            sells = [o for o in related if o.side==OrderSide.SELL and float(o.filled_qty)>0]
            qty = sum(float(o.filled_qty) for o in buys)
            value = sum(float(o.filled_qty)*float(o.filled_avg_price) for o in buys)
            if qty:
                p['entry'] = value/qty
            p['tp_done'] = any(o.type.value=='limit' and order_status(o)=='filled'
                               for o in (parents[0].legs or []))
            for parent in parents:
                if order_status(parent) not in TERMINAL and (t-datetime.fromisoformat(p['submitted'])).total_seconds()>self.c['strategy']['entry_expiry_seconds']:
                    self.log.event('cancel_stale_entry',sym,order_id=str(parent.id))
                    self.b.mutate(self.b.trade.cancel_order_by_id,parent.id)
            active = [o for o in related if order_status(o) not in TERMINAL and order_status(o)!='held']
            if sym not in posmap and not active and all(order_status(o) in TERMINAL for o in parents):
                # Emergency account liquidation orders are standalone. Include all sells
                # for this symbol after entry, since reentry is disabled within a session.
                sells = [o for o in flat_orders if o.symbol==sym and o.side==OrderSide.SELL
                         and float(o.filled_qty)>0 and o.created_at>=datetime.fromisoformat(p['submitted'])]
                sold = sum(float(o.filled_qty) for o in sells)
                if abs(sold-qty)>1e-6:
                    self.halt('fill_quantity_mismatch')
                    continue
                if qty:
                    proceeds = sum(float(o.filled_qty)*float(o.filled_avg_price) for o in sells)
                    trade = dict(symbol=sym,pnl=proceeds-value,risk=p['distance']*qty,
                                 entry=p['entry'],investment=value,proceeds=proceeds,quantity=qty,
                                 reason=p['reason'],exit_time=t.isoformat(),fees=None,
                                 fee_note='Broker fills exclude eventual regulatory charges; reconcile account statement.')
                    self.day['completed'].append(trade)
                    self.day['losses'] = self.day['losses']+1 if trade['pnl']<0 else 0
                    if self.day['losses']>=self.c['risk']['consecutive_losses']:
                        self.day['cooldown_until'] = (t+timedelta(minutes=self.c['risk']['cooldown_minutes'])).isoformat()
                        self.day['losses'] = 0
                    self.log.event('completed_trade',sym,**{k:v for k,v in trade.items() if k!='symbol'})
                del self.meta[sym]
        self.persist()
    def enter(self,sym,sig,account,positions,t,catalyst):
        r = self.c['risk']
        actual = {p.symbol:abs(float(p.market_value)) for p in positions}
        reserved = {sym:p['entry']*p['quantity'] for sym,p in self.meta.items()}
        gross = sum(max(actual.get(sym,0),reserved.get(sym,0)) for sym in set(actual)|set(reserved))
        qty = size(sig,float(account.equity),float(account.buying_power),gross,r)
        if qty<2:
            self.log.event('signal_rejection',sym,reason='insufficient_risk_or_cash_capacity')
            return
        # Write intent BEFORE sending. Unknown outcomes cause account halt, not retries.
        base = 'orb'+uuid.uuid4().hex[:20]
        p = dict(entry=sig.entry,stop=sig.stop,distance=sig.entry-sig.stop,quantity=qty,
                 reason=sig.reason+'; catalyst: '+catalyst,entered=t.isoformat(),submitted=t.isoformat(),
                 parents=[],order_ids=[],fills={},tp_done=False,expected_clients=[base+'a',base+'b'])
        self.meta[sym] = p
        self.day['trades'] += 1
        self.day.setdefault('used',[]).append(sym)
        self.persist()
        try:
            for part,target in [('a',self.c['strategy']['profit_r']),('b',self.c['strategy']['runner_cap_r'])]:
                req = LimitOrderRequest(symbol=sym,qty=qty//2,side=OrderSide.BUY,time_in_force=TimeInForce.DAY,
                    limit_price=sig.entry,order_class=OrderClass.BRACKET,client_order_id=base+part,
                    take_profit=TakeProfitRequest(limit_price=round(sig.entry+target*p['distance'],2)),
                    stop_loss=StopLossRequest(stop_price=sig.stop))
                self.log.event('order_intent',sym,request=req.model_dump(mode='json'))
                order = self.b.mutate(self.b.trade.submit_order,req)  # exactly one attempt
                p['parents'].append(str(order.id))
                p['order_ids'].append(str(order.id))
                self.persist()
                self.log.event('order_submitted',sym,order=order.model_dump(mode='json'))
        except Exception as e:
            self.log.event('order_submission_uncertain_or_rejected',sym,error=str(e),client_id=base)
            self.halt('submission_uncertain_or_rejected')
    def exit_symbol(self,sym,p):
        orders = [o for o in walk_orders(self.b.orders()) if o.symbol==sym]
        # Wait for a previously submitted close order instead of canceling it.
        if p.get('close_id'):
            return
        if orders:
            for o in orders:
                try: self.b.mutate(self.b.trade.cancel_order_by_id,o.id)
                except Exception as e: self.log.event('exit_cancel_pending',sym,error=str(e))
            return
        positions = self.b.read(self.b.trade.get_all_positions)
        if any(v.symbol==sym for v in positions):
            try:
                result = self.b.mutate(self.b.trade.close_position,sym)
                p['close_id'] = str(result.id)
                p['order_ids'].append(str(result.id))
                self.persist()
                self.log.event('symbol_close_submitted',sym,reason=p['exit_pending'],order_id=str(result.id))
            except Exception:
                self.halt('symbol_close_uncertain')
                raise

    def manage(self,t):
        for sym,p in self.meta.items():
            rows = self.bars.get(sym,[])
            reason,new_stop = managed_exit(p,rows,t,self.c['strategy'])
            if reason:
                p['exit_pending'] = reason
                self.persist()
            if p.get('exit_pending'):
                self.exit_symbol(sym,p)
                continue
            if not p['tp_done'] or new_stop<=p['stop']:
                continue
            q = self.quotes.get(sym)
            if not q or (t-q.timestamp).total_seconds()>self.c['strategy']['quote_max_age_seconds']:
                continue
            if new_stop>=q.bid_price-self.c['strategy']['minimum_stop_distance']:
                p['exit_pending'] = 'trail_crossed_before_replace'
                self.persist()
                self.exit_symbol(sym,p)
                continue
            # Only replace remaining active stops; no cancel-and-recreate protection gap.
            orders = self.b.orders()
            for o in walk_orders(orders):
                if o.symbol==sym and o.side==OrderSide.SELL and o.type.value=='stop' and order_status(o) not in TERMINAL:
                    result = self.b.mutate(self.b.trade.replace_order_by_id,o.id,ReplaceOrderRequest(stop_price=round(new_stop,2)))
                    p['order_ids'].append(str(result.id))
                    self.log.event('stop_replace_requested',sym,old_id=str(o.id),new_id=str(result.id),stop=new_stop)
            # Broker rejections on replacement are detected by stream / reconciliation.
            p['stop'] = new_stop
        self.persist()
    def tick(self):
        t = now()
        self.drain()
        clock = self.b.read(self.b.trade.get_clock)
        if abs((t-clock.timestamp).total_seconds())>self.c['runtime']['heartbeat_stale_seconds']:
            raise RuntimeError('Stale broker market clock')
        account = self.b.read(self.b.trade.get_account)
        positions = self.b.read(self.b.trade.get_all_positions)
        if self.day.get('date')!=stamp(t):
            if positions or self.meta or self.b.orders():
                self.halt('overnight_exposure_detected')
                self.b.flatten_step('overnight_exposure')
                return
            self.reset_day(account)
            self.calendar = None
            self.research = None
        self.equity_curve.append(float(account.equity))
        self.reconcile(t,positions)
        session = self.session(t)
        if (self.path/'KILL').exists() or (self.path/('HALT-'+stamp(t))).exists(): self.halt('kill_switch_or_watchdog')
        if account.trading_blocked or account.account_blocked or float(account.equity)<float(account.maintenance_margin):
            self.halt('account_restriction_or_maintenance_deficit')
        if float(account.equity)<=self.day['equity']*(1-self.c['risk']['daily_loss_fraction']):
            self.halt('daily_loss_limit')
        if session:
            opening,close = session
            flatten = t>=close-timedelta(minutes=self.c['risk']['flatten_minutes_before_close'])
            if flatten:
                self.halt('session_flatten')
        else:
            flatten = False
        if self.day['halted']:
            flat = self.b.flatten_step(self.day.get('halt_reason','halt'))
            self.heartbeat(self.stream.healthy())
            if flat and not self.meta:
                self.report()
            return
        if not session:
            self.heartbeat(False)
            return
        self.research_tick(t,opening)
        if clock.is_open:
            self.manage(t)
            if self.day['halted']:
                self.b.flatten_step(self.day['halt_reason'])
                return
            if not self.stream.healthy():
                self.log.event('entries_blocked',reason='stream_unhealthy')
                if positions:
                    self.halt('lost_stream_with_exposure')
                    self.b.flatten_step('lost_stream')
                elif time.monotonic()-self.stream.last_restart>self.c['runtime']['stream_restart_seconds']:
                    self.stream.start(self.stream.symbols)
                self.heartbeat(False)
                return
            r = self.c['risk']
            can_enter = (t<close-timedelta(minutes=r['no_new_entries_minutes_before_close'])
                         and self.research and self.research['allowed']
                         and (self.c['broker']['feed']=='sip' or self.c['broker']['allow_iex_entries'])
                         and self.day['trades']<r['max_trades_day']
                         and (not self.day['cooldown_until'] or t>=datetime.fromisoformat(self.day['cooldown_until'])))
            if can_enter:
                for row in self.research['rows']:
                    sym = row['symbol']
                    if len(self.meta)>=r['max_positions'] or self.day['trades']>=r['max_trades_day']: break
                    if sym in self.day.get('used',[]) or self.halts.get(sym,0)>time.time(): continue
                    q,rows = self.quotes.get(sym),self.bars.get(sym,[])
                    if not q or abs((t-q.timestamp).total_seconds())>self.c['strategy']['quote_max_age_seconds']:
                        continue
                    latest = rows[-1].time.isoformat() if rows else ''
                    if self.seen.get(sym)==latest: continue
                    sig,reason = signal(rows,self.history.get(sym,[]),opening,close,self.c['strategy'],q.bid_price,q.ask_price,t)
                    rejection_key = sym+':'+latest+':'+reason
                    if sig or rejection_key not in self.seen:
                        self.log.event('signal' if sig else 'signal_rejection',sym,reason=reason,details=str(sig))
                        self.seen[rejection_key] = True
                    if sig:
                        account = self.b.read(self.b.trade.get_account)
                        positions = self.b.read(self.b.trade.get_all_positions)
                        self.drain()
                        checked = now()
                        quote = self.quotes.get(sym)
                        if not quote or abs((checked-quote.timestamp).total_seconds())>self.c['strategy']['quote_max_age_seconds']:
                            self.log.event('signal_rejection',sym,reason='quote_expired_before_submit')
                            continue
                        refreshed,why = signal(self.bars.get(sym,[]),self.history.get(sym,[]),opening,close,
                            self.c['strategy'],quote.bid_price,quote.ask_price,checked)
                        if not refreshed or checked>=close-timedelta(minutes=r['no_new_entries_minutes_before_close']):
                            self.log.event('signal_rejection',sym,reason='expired_or_changed_signal:'+why)
                            continue
                        if float(account.equity)<=self.day['equity']*(1-r['daily_loss_fraction']) or account.trading_blocked or account.account_blocked:
                            self.halt('pre_submit_account_risk')
                            break
                        self.enter(sym,refreshed,account,positions,checked,row['catalyst'])
                        self.seen[sym] = latest
                        if self.day['halted']: break
        self.persist()
        self.heartbeat(self.stream.healthy())
    def report(self):
        report = statistics(self.day['completed'],self.equity_curve)
        report.update(date=self.day['date'],trades_taken=self.day['completed'],halt_reason=self.day.get('halt_reason'),
                      account_equity_pnl=self.equity_curve[-1]-self.day['equity'],
                      caveat='Trade P&L from broker fill prices before separately posted fees; account equity P&L includes account adjustments.')
        atomic_json(self.path/('report-'+self.day['date']+'.json'),report)
        self.log.export()
    def run(self):
        lock = open(self.path/'engine.lock','w')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        def stop(*_): self.stop_requested=True
        signals.signal(signals.SIGTERM,stop)
        signals.signal(signals.SIGINT,stop)
        try:
            self.bootstrap()
            while not self.stop_requested:
                try: self.tick()
                except Exception as e:
                    self.log.event('engine_error',error=str(e))
                    self.halt('engine_error')
                    self.b.flatten_step('engine_error')
                    self.heartbeat(False)
                time.sleep(self.c['runtime']['loop_seconds'])
        finally:
            self.halt('shutdown')
            deadline = time.monotonic()+self.c['runtime']['shutdown_retry_seconds']
            while not self.b.flatten_step('shutdown') and time.monotonic()<deadline:
                time.sleep(self.c['runtime']['loop_seconds'])
            self.heartbeat(False)
            self.report()
            self.stream.stop()
            if self.worker and self.worker.is_alive(): self.worker.terminate()
            fcntl.flock(lock,fcntl.LOCK_UN)

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config',default='config.toml')
    args = parser.parse_args()
    Engine(load(args.config)).run()
