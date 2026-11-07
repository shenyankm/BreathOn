"""Fresh baseline versus final source, serial synthetic-provider integration controls."""
from pathlib import Path
import runpy,json,statistics,subprocess
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['EVIDENCE'];RUN=m['RUN'];BENCH=m['BENCH'];ROOT=m['ROOT']
rows=[]
cases=[('dialogue_reference',False),('dialogue_reference',True),('dialogue_real',False),('dialogue_parallel',False),('med_reference',False),('med_reference',True),('med_evidence',False),('med_disk',False),('tts_direct',False),('tts_notify',False),('browser_open',False),('browser_encode',False),('browser_encode',True),('stream',False),('queue',False),('asr_first',False),('skill',False),('retrieve',False)]
for case,small in cases:
 runs=[]
 for v in ('ABBAAB' if case in ['dialogue_reference','med_reference','tts_direct'] else 'ABBA'):
  command=['node','--experimental-transform-types','--expose-gc',str(BENCH),'--root',str(RUN/('initial' if v=='A' else 'final')/'backend'),'--case',case,'--samples','5','--warmup','4']
  if small:command.append('--small')
  p=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=120)
  if p.returncode:raise RuntimeError(case+' '+p.stderr)
  runs.append(dict(version=v,measurement=json.loads(p.stdout.strip().splitlines()[-1])))
 equal=len({r['measurement']['output_sha256'] for r in runs})==1
 row=dict(case=case,small=small,equivalent=equal,summary=m['summarize'](runs),runs=runs)
 for field in ['outer_ms','complete_ms']:row[field]={v:statistics.median(statistics.median(r['measurement'][field]) for r in runs if r['version']==v) for v in 'AB'}
 rows.append(row);(E/'overall.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
 print(case,'small='+str(small),row['summary'],'equal='+str(equal),flush=True);assert equal
