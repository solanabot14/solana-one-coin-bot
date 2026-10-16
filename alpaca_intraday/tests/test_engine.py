from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from common import Store,ET
from strategy import Signal
from engine import Engine

def engine(c,tmp_path):
    e=Engine.__new__(Engine)
    c['runtime']['state_dir']=str(tmp_path)
    e.c=c
    e.log=Store(tmp_path)
    e.path=tmp_path
    e.meta={}
    e.day=dict(date='2026-10-15',trades=0,completed=[],losses=0,halted=False)
    e.equity_curve=[25000]
    e.b=Mock()
    e.b.mutate.side_effect=lambda fn,*a,**k:fn(*a,**k)
    return e

def test_two_equal_brackets(c,tmp_path):
    e=engine(c,tmp_path)
    def submitted(req):
        return SimpleNamespace(id=req.client_order_id,model_dump=lambda **_: {'client_order_id':req.client_order_id})
    e.b.trade.submit_order.side_effect=submitted
    e.enter('ABC',Signal(10,9.9,3,'orb'),SimpleNamespace(equity='25000',buying_power='25000'),[],datetime(2026,10,15,10,tzinfo=ET),'earnings')
    calls=e.b.trade.submit_order.call_args_list
    assert len(calls)==2
    a,b=[x.args[0] for x in calls]
    assert a.qty==b.qty and a.order_class.value=='bracket'
    assert a.take_profit.limit_price==10.15
    assert b.take_profit.limit_price==12
    assert a.stop_loss.stop_price==9.9 and e.day['trades']==1

def test_ambiguous_submit_is_not_retried(c,tmp_path):
    e=engine(c,tmp_path)
    e.b.trade.submit_order.side_effect=TimeoutError('unknown broker outcome')
    e.enter('ABC',Signal(10,9.9,3,'orb'),SimpleNamespace(equity='25000',buying_power='25000'),[],datetime(2026,10,15,10,tzinfo=ET),'earnings')
    assert e.b.trade.submit_order.call_count==1
    assert e.day['halted']
    assert 'ABC' in Store(tmp_path).get('meta')

def test_small_account_skips(c,tmp_path):
    e=engine(c,tmp_path)
    e.enter('ABC',Signal(150,149,3,'orb'),SimpleNamespace(equity='100',buying_power='100'),[],datetime(2026,10,15,10,tzinfo=ET),'earnings')
    e.b.trade.submit_order.assert_not_called()
    assert e.day['trades']==0

def test_symbol_exit_waits_for_cancellation(c,tmp_path):
    e=engine(c,tmp_path)
    o=SimpleNamespace(id='x',symbol='ABC',legs=[])
    e.b.orders.return_value=[o]
    e.exit_symbol('ABC',{'exit_pending':'time'})
    e.b.trade.cancel_order_by_id.assert_called_once_with('x')
    e.b.trade.close_position.assert_not_called()
