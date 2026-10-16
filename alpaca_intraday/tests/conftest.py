import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pytest
from common import load
@pytest.fixture
def c(): return load(str(Path(__file__).resolve().parents[1]/'config.toml'))
