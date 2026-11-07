"""Apply only failed independent controls, preserving all original measurements."""
from pathlib import Path
import runpy,json,subprocess
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['EVIDENCE'];RUN=m['RUN']
rows=json.loads((E/'results.json').read_text());controls=json.loads((E/'controls.json').read_text())
if (E/'overall.json').exists() and rows[11]['accepted']:
 tts=next(r for r in json.loads((E/'overall.json').read_text()) if r['case']=='tts_direct')
 summary=tts['summary'];passed=tts['equivalent'] and summary['improvement_percent']>=5 and sum(p>=5 for p in summary['paired_percent'])>=2
 controls.append(dict(round=12,case='tts_direct',passed=passed,equivalent=tts['equivalent'],summary=summary,runs=tts['runs']))
changed=False
for control in sorted(controls,key=lambda r:r['round'],reverse=True):
 r=rows[control['round']-1];r['control']=control
 if r['accepted'] and not control['passed']:
  subprocess.run(['patch','--batch','--no-backup-if-mismatch','-R','-p1'],cwd=m['ROOT'],input=(E/f'round-{r["round"]:02}.patch').read_bytes(),check=True)
  r['accepted']=False;r['reason']='independent control: insufficient or unstable improvement';changed=True
for r in rows:(E/f'round-{r["round"]:02}.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
(E/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n');(E/'controls.json').write_text(json.dumps(controls,ensure_ascii=False,indent=2)+'\n')
if changed:
 archive=RUN/'final-before-independent-controls';assert not archive.exists()
 (RUN/'final').rename(archive);m['snapshot'](RUN/'final')
print('Retained:',[r['round'] for r in rows if r['accepted']])
