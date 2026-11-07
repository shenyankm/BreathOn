"""Compare the frozen starting and final sources, including a real local HTTP/SQLite path."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('rounds', Path(__file__).with_name('run-experiments.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
results = []
cases = ['learning_outcomes', 'learning_http', 'learning_challenges', 'learning_reviews', 'summary_quotes',
         'skills', 'interactions', 'retrieve_blank', 'frontend_next', 'assessment', 'retrieve', 'citations',
         'base64', 'records', 'activity', 'canonical']
for case, small in [(case, False) for case in cases] + [('learning_http', True)]:
    runs = [dict(version=v, measurement=m.measure(m.RUN / ('initial' if v == 'A' else 'final'), case, small)) for v in 'ABBA']
    equivalent = len({row['measurement']['output_sha256'] for row in runs}) == 1
    result = dict(case=case, small=small, equivalent=equivalent, summary=m.summarize(runs), runs=runs)
    results.append(result)
    (m.EVIDENCE / 'overall.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(f'{case} small={small}: {result["summary"]["improvement_percent"]:+.1f}% equal={equivalent}', flush=True)
    assert equivalent, case
