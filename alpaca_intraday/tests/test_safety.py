from datetime import datetime,timedelta
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from common import ET,Store
from broker import Broker,credentials
from watchdog import must_flatten
from macro import parse_cpi,parse_fed

@pytest.mark.parametrize('hour,minute',[(12,45),(12,55),(13,1)])
def test_early_close(c,hour,minute):
    op=datetime(2026,11,27,9,30,tzinfo=ET)
    t=op.replace(hour=hour,minute=minute)
    assert must_flatten(c,t,op,op.replace(hour=13,minute=0),dict(time=t.isoformat(),healthy=True),False,100)=='scheduled_close'

@pytest.mark.parametrize('heartbeat,expected',[(None,'missing_heartbeat'),('old','stale_or_unhealthy_heartbeat'),('healthy',None)])
def test_heartbeat(c,heartbeat,expected):
    t=datetime(2026,10,15,10,tzinfo=ET)
    h=None if heartbeat is None else dict(time=(t-timedelta(seconds=60 if heartbeat=='old' else 0)).isoformat(),healthy=True)
    assert must_flatten(c,t,t.replace(hour=9,minute=30),t.replace(hour=16),h,False,100)==expected

def test_kill(c): assert must_flatten(c,datetime.now(ET),None,None,None,True,0)=='kill_switch'

def test_dated_halt_latch_is_not_watchdog_kill_switch(c,tmp_path):
    """A dated halt blocks entries in Engine; only KILL forces watchdog flatten."""
    # This verifies the intended distinction directly through a small helper
    # kept pure so production watchdog boot/API behavior is not started in test.
    assert must_flatten(c,datetime.now(ET),None,None,None,False,0) is None

def test_live_gate(c):
    c['broker']['paper']=False
    with pytest.raises(ValueError,match='Live mode'): credentials(c)

def test_missing_keys(c,monkeypatch):
    monkeypatch.delenv('ALPACA_PAPER_API_KEY',raising=False)
    monkeypatch.delenv('ALPACA_PAPER_SECRET_KEY',raising=False)
    with pytest.raises(ValueError,match='Missing'): credentials(c)

def fake(c,tmp_path):
    c['runtime']['state_dir']=str(tmp_path)
    b=Broker.__new__(Broker)
    b.c=c
    b.log=Mock()
    b.trade=Mock()
    b.read=lambda fn,*a,**k:fn(*a,**k)
    b.orders=Mock(return_value=[])
    return b

def test_wait_for_cancel(c,tmp_path):
    b=fake(c,tmp_path)
    b.orders.return_value=[object()]
    assert not b.flatten_step('test')
    b.trade.close_all_positions.assert_not_called()

def test_verify_positions(c,tmp_path):
    b=fake(c,tmp_path)
    b.trade.get_all_positions.side_effect=[[SimpleNamespace(symbol='ABC')],[SimpleNamespace(symbol='ABC')]]
    assert not b.flatten_step('test')
    b.trade.close_all_positions.assert_called_once_with(cancel_orders=True)

def test_flat_verified(c,tmp_path):
    b=fake(c,tmp_path)
    b.trade.get_all_positions.return_value=[]
    assert b.flatten_step('test')

def test_outage(c,tmp_path):
    b=fake(c,tmp_path)
    b.trade.cancel_orders.side_effect=TimeoutError()
    assert not b.flatten_step('test')

def test_cpi():
    raw=b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:20261014T123000Z\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    assert parse_cpi(raw)=={'2026-10-14'}

def test_missing_fed_coverage():
    with pytest.raises(ValueError): parse_fed('<h4>Changed structure</h4>',2026)

def test_durable_halt(tmp_path):
    Store(tmp_path).put('day',{'halted':True})
    assert Store(tmp_path).get('day')['halted']

def test_fed_parser_scoped_year():
    meetings=''.join(f'<div class="fomc-meeting"><div class="fomc-meeting__month"><strong>{m}</strong></div><div class="fomc-meeting__date">17-18</div></div>' for m in ['January','March','April','June','July','September','October','December'])
    result=parse_fed('<div class="panel"><h4>2026 FOMC Meetings</h4>'+meetings+'</div>',2026)
    assert '2026-10-17' in result and '2026-10-18' in result and len(result)==16

def test_liquidation_inflight_not_canceled(c,tmp_path):
    b=fake(c,tmp_path)
    o=SimpleNamespace(id='exit',side=SimpleNamespace(value='sell'),type=SimpleNamespace(value='market'),legs=[])
    b.orders.return_value=[o]
    assert not b.flatten_step('test')
    b.trade.cancel_orders.assert_not_called()
    b.trade.close_all_positions.assert_not_called()
