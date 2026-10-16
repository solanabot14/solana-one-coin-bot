import csv,json
import pytest
from datetime import datetime,timedelta
from pathlib import Path
from common import ET
from backtest import run

def fixture(tmp_path):
    op=datetime(2026,10,15,9,30,tzinfo=ET)
    rows=[]
    for d in range(10,0,-1):
        for i in range(-20,11):
            t=op-timedelta(days=d)+timedelta(minutes=i)
            rows.append([t.isoformat(),'ABC',10,10.1,9.9,10,100,10])
    for i in range(-20,11):
        t=op+timedelta(minutes=i)
        o,h,l,cl,v=10,10.1,9.9,10,300 if i>=0 else 100
        if i==5: o,h,l,cl,v=10,10.25,10,10.2,1000
        elif i==6: o,h,l,cl,v=10.21,10.35,10.2,10.3,10000
        elif i==7: o,h,l,cl,v=10.3,10.6,10.3,10.5,10000
        elif i==8: o,h,l,cl,v=10.5,10.8,10.4,10.7,10000
        elif i==9: o,h,l,cl,v=10.7,10.8,10.2,10.4,10000
        elif i==10: o,h,l,cl,v=10.4,10.5,10.2,10.3,10000
        rows.append([t.isoformat(),'ABC',o,h,l,cl,v,cl])
    rows.append([op.replace(hour=15,minute=45).isoformat(),'ABC',10.3,10.4,10.2,10.3,10000,10.3])
    path=tmp_path/'bars.csv'
    with path.open('w',newline='') as f:
        w=csv.writer(f)
        w.writerow(['timestamp','symbol','open','high','low','close','volume','vwap'])
        w.writerows(rows)
    candidates=tmp_path/'candidates.json'
    candidates.write_text(json.dumps({'2026-10-15':{'macro_clear':True,'rows':[dict(symbol='ABC',scan_time=op.replace(hour=9,minute=24).isoformat(),catalyst='earnings')]}}))
    sessions=tmp_path/'sessions.json'
    sessions.write_text(json.dumps({'2026-10-15':dict(open=op.isoformat(),close=op.replace(hour=16,minute=0).isoformat())}))
    return path,candidates,sessions

def test_replay_roundtrip(c,tmp_path):
    paths=fixture(tmp_path)
    result=run(c,*paths)
    assert result['trades']==1
    assert result['trade_log'][0]['exits']
    assert result['final_equity']==pytest.approx(c['backtest']['initial_equity']+result['pnl'])

def test_commissions_reduce_pnl(c,tmp_path):
    paths=fixture(tmp_path)
    first=run(c,*paths)
    c['backtest']['commission_per_share']=.02
    second=run(c,*paths)
    assert second['pnl']<first['pnl']

def test_no_macro_metadata_no_entries(c,tmp_path):
    paths=fixture(tmp_path)
    data=json.loads(paths[1].read_text())
    data['2026-10-15']['macro_clear']=False
    paths[1].write_text(json.dumps(data))
    assert run(c,*paths)['trades']==0
