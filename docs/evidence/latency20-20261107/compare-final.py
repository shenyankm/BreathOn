"""Independent baseline/final latency checks; do not run alongside tests/builds."""
import importlib.util,json,statistics
from pathlib import Path
spec=importlib.util.spec_from_file_location('rounds',Path(__file__).with_name('run-experiments.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
results=[]
for case,small in [('stream',False),('stream',True),('queue',False),('queue',True),('dialogue_real',False),('dialogue_real',True),
                   ('dialogue_parallel',False),('dialogue_history',False),('asr_first',False),('asr_first',True),
                   ('tts_notify',False),('tts_notify',True),('materials',False),('reference_metadata',False),('reference_parallel',False),('reference_real',False),('retrieve',False)]:
 runs=[dict(version=v,measurement=m.measure(m.RUN/('initial' if v=='A' else 'final'),case,small)) for v in 'ABBA']
 equal=len({r['measurement']['output_sha256'] for r in runs})==1
 extra={field:{v:statistics.median(statistics.median(r['measurement'][field]) for r in runs if r['version']==v) for v in 'AB'} for field in ['complete_ms','outer_ms']}
 row=dict(case=case,small=small,equivalent=equal,summary=m.summarize(runs),**extra,runs=runs)
 results.append(row)
 (m.EVIDENCE/'overall.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 print(f'{case} small={small}: {row["summary"]["before_ms"]:.4f}->{row["summary"]["after_ms"]:.4f}ms ({row["summary"]["improvement_percent"]:+.1f}%) equal={equal}',flush=True)
 assert equal,case
