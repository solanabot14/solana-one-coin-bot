from datetime import datetime,timedelta
from dataclasses import replace
import pytest
from common import ET,statistics
from strategy import Bar,Signal,signal,size,same_time_rvol,managed_exit

@pytest.fixture
def sample():
    op=datetime(2026,10,15,9,30,tzinfo=ET)
    warm=[Bar('ABC',op-timedelta(minutes=20-i),10,10.05,9.95,10,100) for i in range(20)]
    reg=[Bar('ABC',op+timedelta(minutes=i),10,10.1,9.9,10,300) for i in range(5)]
    reg += [Bar('ABC',op+timedelta(minutes=5),10,10.25,10,10.2,1000)]
    hist=[[replace(b,time=b.time-timedelta(days=d),volume=100) for b in reg] for d in range(1,11)]
    return op,warm+reg,hist

def assess(c,sample,minutes=6,bid=10.2,ask=10.21):
    op,bars,h=sample
    return signal(bars,h,op,op+timedelta(hours=6,minutes=30),c['strategy'],bid,ask,op+timedelta(minutes=minutes))

def test_breakout(c,sample):
    sig,why=assess(c,sample)
    assert why=='accepted' and sig.stop<sig.entry

@pytest.mark.parametrize('minutes,reason',[(4,'opening_range_wait'),(5.5,'stale_or_unfinished_bar'),(10,'stale_or_unfinished_bar')])
def test_timing(c,sample,minutes,reason): assert assess(c,sample,minutes)[1]==reason

def test_spread(c,sample): assert assess(c,sample,ask=10.3)[1]=='spread'

def test_missing_or(c,sample):
    op,bars,h=sample
    assert assess(c,(op,[b for b in bars if b.time!=op],h))[1]=='opening_range_incomplete'

def test_rvol(sample):
    _,bars,h=sample
    assert same_time_rvol(h,bars[-6:],True)==pytest.approx(2500/600)

def test_missing_slots(sample):
    _,bars,h=sample
    assert same_time_rvol([h[0][1:]],bars[-6:],True) is None

def test_minimum_samples(sample):
    _,bars,h=sample
    assert same_time_rvol(h[:2],bars[-6:],True,10) is None

@pytest.mark.parametrize('cash',[0,50,100,1000,25000])
def test_sizing(c,cash):
    q=size(Signal(10,9.9,3,'x'),25000,cash,0,c['risk'])
    assert q%2==0 and q*10<=cash*(1-c['risk']['buying_power_reserve_fraction'])+1e-8
    assert q*.1<=25000*c['risk']['risk_fraction']+1e-8

def test_exposure(c): assert size(Signal(10,9,3,'x'),100,100,100,c['risk'])==0

def test_stop_never_loosens(c,sample):
    op,bars,_=sample
    p=dict(entry=10,stop=10.4,distance=.1,entered=op.isoformat(),tp_done=True)
    assert managed_exit(p,bars,op+timedelta(minutes=10),c['strategy'])[1]>=10.4

def test_wait_actual_fill(c,sample):
    op,bars,_=sample
    p=dict(entry=10.2,stop=9.9,distance=.3,entered=op.isoformat(),tp_done=False)
    assert managed_exit(p,bars,op+timedelta(minutes=10),c['strategy'])[1]==9.9

def test_time_stop(c,sample):
    op,bars,_=sample
    p=dict(entry=10.2,stop=9.9,distance=.3,entered=op.isoformat(),tp_done=False)
    assert managed_exit(p,bars,op+timedelta(minutes=31),c['strategy'])[0]=='flat_time_stop'

def test_stats():
    r=statistics([dict(pnl=100,risk=100),dict(pnl=-50,risk=100)],[1000,1100,1050])
    assert r['profit_factor']==2 and r['average_r']==.25 and r['max_drawdown']==pytest.approx(50/1100)
