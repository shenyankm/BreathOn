"""Check measurements and rebuild final source from the fresh baseline and retained candidates."""
from pathlib import Path
import runpy,json,hashlib,tarfile,tempfile
m=runpy.run_path(str(Path(__file__).with_name('run-experiments.py')));E=m['E'];ROOT=m['ROOT'];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
rows=json.loads((E/'results.json').read_text());assert len(rows)==20 and [r['round'] for r in rows]==list(range(1,21))
manifest=json.loads((E/'manifest.json').read_text());assert sha(E/'initial-source.tar.gz')==manifest['initial_archive_sha256']
for f,h in manifest['lock_hashes'].items():assert sha(ROOT/f)==h
for r in rows:
 assert r['equivalent']
 for size in ['large','small']:assert len({v['measurement']['output_sha256'] for v in r[size+'_runs']})==1
 if r['accepted']:
  assert r['large']['improvement_percent']>=5 and sum(p>=5 for p in r['large']['paired_percent'])>=2
  s=r['small'];assert s['improvement_percent']>=-15 or s['after_ms']-s['before_ms']<.05
  if 'control' in r:assert r['control']['passed']
with tempfile.TemporaryDirectory(prefix='perf4-source-rebuild-') as temp:
 dst=Path(temp)
 with tarfile.open(E/'initial-source.tar.gz') as archive:
  for member in archive.getmembers():
   parts=Path(member.name).parts;assert parts[:2] in [('backend','src'),('frontend','src')] and '..' not in parts and member.isfile()
  archive.extractall(dst)
 hashes=lambda base:{str(p.relative_to(base)):sha(p) for part in ['backend/src','frontend/src'] for p in (base/part).rglob('*') if p.is_file() and '/assets/' not in str(p)}
 assert hashes(dst)==manifest['source_hashes']
 for r,candidate in zip(rows,m['C']):
  if not r['accepted']:continue
  for f,changes in candidate['changes'].items():
   s=(dst/f).read_text()
   for b,a in changes:s=m['transform'](s,b,a)
   (dst/f).write_text(s)
 expected=hashes(dst);actual=hashes(ROOT);assert expected==actual,{f for f in expected.keys()|actual.keys() if expected.get(f)!=actual.get(f)}
manifest.update(final_source_hashes=actual,rebuild_matches_final=True,retained=[r['round'] for r in rows if r['accepted']],changed_source_files=[f for f in actual if actual[f]!=manifest['source_hashes'].get(f)],measurement_benchmark_sha256=sha(E/'measurement-benchmark.ts'),final_benchmark_sha256=sha(m['BENCH']),script_hashes={p.name:sha(p) for p in E.glob('*.py')},test_hashes={str(p):sha(p) for p in [ROOT/'backend/tests-ts/performance-batch4.test.ts',ROOT/'frontend/tests/performance-batch4.test.ts']})
(E/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
if (E/'overall.json').exists():
 overall=json.loads((E/'overall.json').read_text());assert all(r['equivalent'] for r in overall)
print('Verified 20 candidate decisions, output hashes, unchanged dependencies and exact final source reconstruction.')
