"""Convert saved premarket scans to replay inputs without today's-winner bias."""
import argparse,json
from pathlib import Path
from common import atomic_json
if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--archive',default='state/research-archive')
    p.add_argument('--output',default='candidates.json')
    a=p.parse_args()
    results={}
    for file in sorted(Path(a.archive).glob('*.json')):
        row=json.loads(file.read_text())
        results[row['date']]={'macro_clear':row['allowed'],'rows':row['rows']}
    if not results: raise SystemExit('No archived scans. Run paper scanner first; do not invent historical candidates.')
    atomic_json(a.output,results)
