"""Investigate the mixed paired result for the small frontend hot path."""
import importlib.util
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('rounds',Path(__file__).with_name('run-experiments.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=[]
for small,order in [(False,'ABBAABBA'),(True,'ABBA')]:
 runs=[dict(version=v,measurement=m.measure(m.RUN/('initial' if v=='A' else 'final'),'frontend_next',small)) for v in order]
 assert len({r['measurement']['output_sha256'] for r in runs})==1
 rows.append(dict(case='frontend_next',small=small,summary=m.summarize(runs),runs=runs))
(m.EVIDENCE/'frontend-control.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
print(json.dumps([{key:r[key] for key in ['small','summary']} for r in rows]))
