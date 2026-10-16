from datetime import datetime
import pytest
from macro import parse_cpi_schedule


def test_parse_official_cpi_release_dates():
    html = """
    <table>
      <tr><th>Reference Month</th><th>Release Date</th><th>Release Time</th></tr>
      <tr><td>July 2026</td><td>Aug. 12, 2026</td><td>08:30 AM</td></tr>
      <tr><td>August 2026</td><td>Sep. 11, 2026</td><td>08:30 AM</td></tr>
      <tr><td>September 2026</td><td>Oct. 14, 2026</td><td>08:30 AM</td></tr>
      <tr><td>October 2026</td><td>Nov. 10, 2026</td><td>08:30 AM</td></tr>
      <tr><td>November 2026</td><td>Dec. 10, 2026</td><td>08:30 AM</td></tr>
      <tr><td>December 2026</td><td>Jan. 13, 2027</td><td>08:30 AM</td></tr>
    </table>
    """
    assert parse_cpi_schedule(html, 2026) == {
        "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"
    }


def test_cpi_schedule_requires_complete_year_coverage():
    with pytest.raises(ValueError, match="Incomplete BLS CPI schedule"):
        parse_cpi_schedule(
            "<table><tr><td>Consumer Price Index</td><td>Oct. 14, 2026</td></tr></table>",
            2026,
        )
