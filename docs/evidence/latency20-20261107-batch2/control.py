"""Independent warmed controls for marginal or highly variable first-pass candidates."""
import runpy,json,subprocess
from pathlib import Path
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')))
E=m['EVIDENCE'];RUN=m['RUN'];BENCH=m['BENCH'];ROOT=m['ROOT']
rows=[]
for index,case in [(3,'med_disk'),(4,'med_evidence'),(6,'med_evidence'),(7,'med_evidence'),(19,'browser_encode'),(20,'skill')]:
 runs=[]
 for v in 'ABBAAB':
  result=subprocess.run(['node','--experimental-transform-types','--expose-gc',str(BENCH),'--root',str(RUN/f'round-{index:02}-{v}'/'backend'),'--case',case,'--samples','7','--warmup','16'],cwd=ROOT,capture_output=True,text=True,check=True,timeout=120)
  runs.append(dict(version=v,measurement=json.loads(result.stdout.strip().splitlines()[-1])))
 summary=m['summarize'](runs);equal=len({r['measurement']['output_sha256'] for r in runs})==1
 passed=equal and summary['improvement_percent']>=5 and sum(p>=5 for p in summary['paired_percent'])>=2
 row=dict(round=index,case=case,passed=passed,equivalent=equal,summary=summary,runs=runs);rows.append(row)
 (E/'controls.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
 print(index,passed,summary,flush=True)
