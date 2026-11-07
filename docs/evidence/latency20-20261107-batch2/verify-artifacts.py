"""Rebuild source from the fresh baseline and exactly the retained candidates."""
from pathlib import Path
import runpy,json,hashlib,tarfile,tempfile,subprocess
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')))
E=m['EVIDENCE'];ROOT=m['ROOT'];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
results=json.loads((E/'results.json').read_text());assert len(results)==20
assert [r['round'] for r in results]==list(range(1,21))
for r in results:
 assert r['equivalent']
 for size in ['large','small']:assert len({v['measurement']['output_sha256'] for v in r[size+'_runs']})==1
 if r['accepted']:
  assert r['large']['improvement_percent']>=5 and sum(v>=5 for v in r['large']['paired_percent'])>=2
  assert r['small']['improvement_percent']>=-15 or r['small']['after_ms']-r['small']['before_ms']<.5
  assert r['tail']['B']<=r['tail']['A']*1.1 or r['tail']['B']-r['tail']['A']<1
  if 'control' in r:assert r['control']['passed']
with tempfile.TemporaryDirectory(prefix='latency-b2-rebuild-') as temp:
 base=Path(temp)
 with tarfile.open(E/'initial-source.tar.gz') as archive:
  for member in archive.getmembers():
   parts=Path(member.name).parts;assert parts[:2] in [('backend','src'),('frontend','src')] and '..' not in parts and member.isfile()
  archive.extractall(base)
 hashes=lambda parent:{str(p.relative_to(parent)):sha(p) for part in ['backend/src','frontend/src'] for p in (parent/part).rglob('*') if p.is_file() and '/assets/' not in str(p)}
 original=hashes(base);assert original==json.loads((E/'initial-source-sha256.json').read_text())
 for r,item in zip(results,m['C']):
  if not r['accepted']:continue
  for f,changes in item['changes'].items():
   s=(base/f).read_text()
   for before,after in changes:s=m['transform'](s,before,after)
   (base/f).write_text(s)
 expected=hashes(base);actual=hashes(ROOT);assert expected==actual,{f for f in expected.keys()|actual.keys() if expected.get(f)!=actual.get(f)}
manifest=dict(head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),initial_archive_sha256=sha(E/'initial-source.tar.gz'),starting_patch_sha256=sha(E/'starting-worktree.patch'),measurement_benchmark_sha256=sha(E/'measurement-benchmark.ts'),retained=[r['round'] for r in results if r['accepted']],rebuild_matches_final=True,source_hashes=actual,changed_source_files=[f for f in actual if original.get(f)!=actual[f]],file_hashes={str(p.relative_to(ROOT)):sha(p) for p in [m['BENCH'],ROOT/'backend/package-lock.json',ROOT/'frontend/package-lock.json',ROOT/'backend/tests-ts/latency-batch2.test.ts',ROOT/'frontend/tests/voice.test.ts']},script_hashes={p.name:sha(p) for p in E.glob('*.py')})
(E/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('Verified 20 independent candidates, output hashes, retention gates and exact source reconstruction.')
