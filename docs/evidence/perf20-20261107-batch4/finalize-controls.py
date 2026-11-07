from pathlib import Path
import runpy,json,subprocess
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['E'];RUN=m['RUN']
rows=json.loads((E/'results.json').read_text());controls=json.loads((E/'controls.json').read_text());changed=False
if not (E/'results-before-controls.json').exists():(E/'results-before-controls.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
for control in sorted(controls,key=lambda r:r['round'],reverse=True):
 r=rows[control['round']-1];r['control']=control
 if r['accepted'] and not control['passed']:
  subprocess.run(['patch','--batch','--no-backup-if-mismatch','-R','-p1'],cwd=m['ROOT'],input=(E/f'round-{r["round"]:02}.patch').read_bytes(),check=True)
  r['accepted']=False;r['reason']='independent legal-load control: insufficient or unstable improvement';changed=True
for r in rows:(E/f'round-{r["round"]:02}.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
(E/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
if changed:(RUN/'final').rename(RUN/'final-before-controls');m['snapshot'](RUN/'final')
print('Retained', [r['round'] for r in rows if r['accepted']])
