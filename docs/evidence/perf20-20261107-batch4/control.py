"""Check real I/O, configured rate limits and independent repeats before retention."""
from pathlib import Path
import runpy,json
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['E'];RUN=m['RUN'];rows=[]
for index,case in [(1,'outcomes_multi4'),(4,'html_links4'),(5,'html_links4'),(10,'medical_sentences_real4'),(11,'medical_parts4'),(12,'cost4_bounded'),(14,'cost4_missing_bounded'),(19,'front_quotes4')]:
 runs=[dict(version=v,measurement=m['measure'](RUN/f'round-{index:02}-{v}',case,False,9)) for v in 'ABBAAB']
 s=m['summary'](runs);equal=len({r['measurement']['output_sha256'] for r in runs})==1
 passed=equal and s['improvement_percent']>=5 and sum(p>=5 for p in s['paired_percent'])>=2
 r=dict(round=index,case=case,passed=passed,equivalent=equal,summary=s,runs=runs);rows.append(r);(E/'controls.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
 print(index,case,passed,s,flush=True)
