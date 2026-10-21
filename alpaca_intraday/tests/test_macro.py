import pytest
from macro import parse_cpi


def test_parse_official_cpi_release_dates():
    raw = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20261014T083000
SUMMARY:Consumer Price Index
END:VEVENT
BEGIN:VEVENT
DTSTART:20261110T083000
SUMMARY:Consumer Price Index
END:VEVENT
BEGIN:VEVENT
DTSTART:20261210T083000
SUMMARY:Consumer Price Index
END:VEVENT
END:VCALENDAR
"""
    assert parse_cpi(raw) == {"2026-10-14", "2026-11-10", "2026-12-10"}


def test_cpi_calendar_requires_cpi_events():
    raw = b"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20261014T083000
SUMMARY:Employment Situation
END:VEVENT
END:VCALENDAR
"""
    with pytest.raises(ValueError, match="No CPI dates parsed"):
        parse_cpi(raw)
