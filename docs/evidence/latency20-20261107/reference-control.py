"""Check whether reference parallelism helps real SQLite/corpus work, rather than delayed stubs."""
import importlib.util,json
from pathlib import Path
s=importlib.util.spec_from_file_location('rounds',Path(__file__).with_name('run-experiments.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
runs=[dict(version=v,measurement=m.measure(m.RUN/('round-14-A' if v=='A' else 'round-14-B'),'reference_real')) for v in 'ABBAAB']
assert len({r['measurement']['output_sha256'] for r in runs})==1
result=dict(case='reference_real',comparison='round-14 candidate only; actual SQLite and corpus operations',summary=m.summarize(runs),runs=runs)
(m.EVIDENCE/'reference-control.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result['summary']))
