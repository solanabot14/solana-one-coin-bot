"""Portfolio minute replay; same pure signals/exits as engine. Not a fill simulator.
Inputs are point-in-time archived candidate decisions, bars, and broker sessions.
A synthetic minute fixture is included for smoke testing ONLY.
"""
import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime,timedelta
from pathlib import Path
from common import ET,load,statistics,atomic_json
from strategy import Bar,signal,size,managed_exit
from scanner import histories

def read_bars(path):
    data = defaultdict(list)
    with open(path,newline='') as f:
        for row in csv.DictReader(f):
            t = datetime.fromisoformat(row['timestamp'])
            if t.tzinfo is None: raise ValueError('CSV timestamps require timezone offsets')
            vals = [float(row[k]) for k in ('open','high','low','close','volume')]
            if vals[1]<max(vals[0],vals[3]) or vals[2]>min(vals[0],vals[3]) or vals[4]<0:
                raise ValueError('Invalid OHLCV')
            data[t].append(Bar(row['symbol'],t,*vals,float(row['vwap']) if row.get('vwap') else None))
    return data

def run(c,bars_path,candidates_path,sessions_path):
    s,r,b = c['strategy'],c['risk'],c['backtest']
    sessions = json.loads(Path(sessions_path).read_text())
    candidates = json.loads(Path(candidates_path).read_text())
    data = read_bars(bars_path)
    by_symbol = defaultdict(list)
    for t in sorted(data):
        for bar in data[t]: by_symbol[bar.symbol].append(bar)
    cash = b['initial_equity']
    positions,trades,curve,seen = {},[],[cash],defaultdict(list)
    day=None
    daily_trades=losses=0
    cooldown=None
    halted=False
    used=set()
    warnings=[]
    def cost(q,price,sell=False):
        return max(b['minimum_commission'],q*b['commission_per_share'])+ (q*price*b['sell_fee_bps']/10000 if sell else 0)
    def sell(sym,p,qty,price,t,why):
        nonlocal cash,losses,cooldown
        # Stop gaps and liquidation use adverse slippage; TP limit never fills below limit.
        fill = price if why in ('take_profit','runner_cap') else price*(1-b['slippage_bps']/10000)
        fee=cost(qty,fill,True)
        cash += qty*fill-fee
        p['proceeds'] += qty*fill-fee
        p['remaining'] -= qty
        p['exits'].append(dict(time=t.isoformat(),qty=qty,price=fill,reason=why,fee=fee))
        if p['remaining']==0:
            pnl=p['proceeds']-p['investment']
            trades.append(dict(symbol=sym,pnl=pnl,risk=p['distance']*p['quantity'],entry=p['entry'],
                               investment=p['investment'],reason=p['reason'],exits=p['exits'],exit_time=t.isoformat()))
            losses=losses+1 if pnl<0 else 0
            if losses>=r['consecutive_losses']:
                cooldown=t+timedelta(minutes=r['cooldown_minutes'])
                losses=0
            del positions[sym]
    for t in sorted(data):
        current_day=t.astimezone(ET).date().isoformat()
        if current_day not in sessions:
            for bar in data[t]: seen[bar.symbol].append(bar)
            continue
        opening,close=[datetime.fromisoformat(sessions[current_day][k]) for k in ('open','close')]
        if day!=current_day:
            if positions: raise ValueError('Prior session unresolved: missing close data')
            day=current_day
            daily_equity=cash
            daily_trades=losses=0
            cooldown=None
            halted=False
            used=set()
        current={bar.symbol:bar for bar in data[t]}
        # Evaluate already-held orders first; stops win ambiguous intrabar conflicts.
        for sym,p in list(positions.items()):
            bar=current.get(sym)
            if bar is None: continue
            if t>=close-timedelta(minutes=r['flatten_minutes_before_close']):
                sell(sym,p,p['remaining'],bar.open,t,'session_close')
            elif bar.low<=p['stop']:
                sell(sym,p,p['remaining'],min(bar.open,p['stop']),t,'stop')
            else:
                tp=p['entry_limit']+s['profit_r']*p['distance']
                cap=p['entry_limit']+s['runner_cap_r']*p['distance']
                if not p['tp_done'] and bar.high>=tp:
                    sell(sym,p,p['quantity']//2,tp,t,'take_profit')
                    p['tp_done']=True
                    # Assume a new BE stop can be hit in this minute, conservatively.
                    p['stop']=max(p['stop'],p['entry'])
                    if bar.low<=p['stop']:
                        sell(sym,p,p['remaining'],min(bar.open,p['stop']),t,'same_bar_breakeven')
                        continue
                if sym in positions and bar.high>=cap:
                    sell(sym,p,p['remaining'],cap,t,'runner_cap')
        # Signals from t-1 and earlier enter at t's open, not the known closing price.
        equity=cash+sum(p['remaining']*current.get(sym,seen[sym][-1]).open for sym,p in positions.items())
        curve.append(equity)
        if equity<=daily_equity*(1-r['daily_loss_fraction']): halted=True
        day_candidates=candidates.get(day,{})
        macro_ok=day_candidates.get('macro_clear',False) or r['allow_macro_days']
        if halted:
            for sym,p in list(positions.items()):
                if sym in current: sell(sym,p,p['remaining'],current[sym].open,t,'daily_limit')
        elif opening<=t<close-timedelta(minutes=r['no_new_entries_minutes_before_close']) and macro_ok and (cooldown is None or t>=cooldown):
            for candidate in day_candidates.get('rows',[]):
                sym=candidate['symbol']
                if sym in used or sym not in current or len(positions)>=r['max_positions'] or daily_trades>=r['max_trades_day']: continue
                asof=datetime.fromisoformat(candidate['scan_time'])
                if asof>t or not candidate.get('catalyst') or asof>=opening:
                    raise ValueError('Candidate metadata missing catalyst or contains lookahead')
                bar=current[sym]
                half=b['assumed_spread_bps']/20000
                bid,ask=bar.open*(1-half),bar.open*(1+half)
                history=histories(by_symbol[sym],t.astimezone(ET).date(),s['history_sessions'])
                prior=seen[sym]
                sig,_=signal(prior,history,opening,close,s,bid,ask,t)
                if not sig: continue
                expected=ask*(1+b['slippage_bps']/10000)
                if expected>sig.entry or sig.stop>=expected: continue  # unfilled limit
                gross=sum(p['remaining']*current.get(key,seen[key][-1]).open for key,p in positions.items())
                qty=size(sig,equity,cash,gross,r)
                # Simulation uses future bar volume only as a fill-capacity bound,
                # never to select the signal. It can reject unrealistically large fills.
                qty=min(qty,int(bar.volume*b['participation_max'])//2*2)
                while qty>=2 and qty*expected+cost(qty,expected)>cash: qty-=2
                if qty<2: continue
                fee=cost(qty,expected)
                cash-=qty*expected+fee
                p=dict(entry=expected,entry_limit=sig.entry,stop=sig.stop,distance=sig.entry-sig.stop,quantity=qty,remaining=qty,
                       entered=t.isoformat(),tp_done=False,investment=qty*expected+fee,proceeds=0,exits=[],
                       reason=sig.reason+'; catalyst: '+candidate['catalyst'])
                positions[sym]=p
                daily_trades+=1
                used.add(sym)
                # Entry minute may stop out; never award a TP in the entry minute.
                if bar.low<=p['stop']:
                    sell(sym,p,qty,min(bar.open,p['stop']),t,'entry_minute_stop')
        for bar in data[t]: seen[bar.symbol].append(bar)
        for sym,p in list(positions.items()):
            if sym not in current: continue
            reason,new_stop=managed_exit(p,seen[sym],t+timedelta(minutes=1),s)
            if reason or new_stop>=current[sym].close:
                sell(sym,p,p['remaining'],current[sym].close,t,reason or 'trail_crossed')
            else: p['stop']=new_stop
        marked=cash+sum(p['remaining']*seen[sym][-1].close for sym,p in positions.items())
        curve.append(marked)
        if marked<=daily_equity*(1-r['daily_loss_fraction']):
            halted=True  # flatten on next executable bar, never erase a gap
    if positions:
        raise ValueError('Unresolved positions: dataset must include flatten window for every traded symbol')
    result=statistics(trades,curve)
    result.update(final_equity=cash,trade_log=trades,warnings=warnings,
                  assumptions='Archived point-in-time universe; assumed spread; adverse slippage; stop-first intrabar ordering; no queue, halt or broker latency model.')
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--config',default='config.toml')
    p.add_argument('--bars',required=True)
    p.add_argument('--candidates',required=True)
    p.add_argument('--sessions',required=True)
    p.add_argument('--output',default='backtest-report.json')
    a=p.parse_args()
    result=run(load(a.config),a.bars,a.candidates,a.sessions)
    atomic_json(a.output,result)
    print(json.dumps({k:v for k,v in result.items() if k!='trade_log'},indent=2))
