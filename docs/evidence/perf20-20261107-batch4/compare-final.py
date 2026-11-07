"""Final cumulative version, realistic workloads plus unchanged controls; serial."""
from pathlib import Path
import runpy,json,statistics
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['E'];RUN=m['RUN'];rows=[]
cases=[(case,small) for case in ['outcomes_records4','outcomes_multi4','scope','html_links4','normalized_text','medical_sentences_real4','medical_parts4','cost4_bounded','cost4_missing_bounded','policy4_empty','policy4_cache','front_quotes4'] for small in [False,True]]+[('retrieve',False),('assessment',False),('records',False),('catalog',False)]
for case,small in cases:
 runs=[dict(version=v,measurement=m['measure'](RUN/('initial' if v=='A' else 'final'),case,small,7)) for v in 'ABBA']
 equal=len({r['measurement']['output_sha256'] for r in runs})==1
 row=dict(case=case,small=small,equivalent=equal,summary=m['summary'](runs),cpu_us={v:statistics.median(statistics.median(r['measurement']['cpu_us']) for r in runs if r['version']==v) for v in 'AB'},runs=runs)
 rows.append(row);(E/'overall.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
 print(case,small,row['summary'],'equal='+str(equal),flush=True);assert equal
