"""Check all 20 decisions and rebuild final sources solely from retained patches."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
results = json.loads((EVIDENCE/'results.json').read_text())
assert len(results) == 20 and [r['round'] for r in results] == list(range(1,21))
assert all(r['equivalent'] for r in results)
for row in results:
    for size in ['large','small']:
        assert len({r['measurement']['output_sha256'] for r in row[size+'_runs']}) == 1
    if row['accepted']:
        assert row['large']['improvement_percent'] >= 5
        assert sum(p>=5 for p in row['large']['paired_percent']) >= 2
        assert row['small']['improvement_percent'] >= -10 or row['small']['after_ms']-row['small']['before_ms'] < .001
manifest = json.loads((EVIDENCE/'manifest.json').read_text())
assert sha((EVIDENCE/'initial-sources.tar.gz').read_bytes()) == manifest['initial_sources_sha256']
with tempfile.TemporaryDirectory(prefix='evispeak-rebuild-') as folder:
    destination=Path(folder)
    with tarfile.open(EVIDENCE/'initial-sources.tar.gz') as archive:
        for member in archive.getmembers():
            parts=Path(member.name).parts
            assert parts[:2] in [('backend','src'),('frontend','src')] and '..' not in parts
            assert member.isfile() or member.isdir()
        archive.extractall(destination)
    hashes = lambda base: {str(p.relative_to(base)):sha(p.read_bytes()) for part in ['backend/src','frontend/src'] for p in (base/part).rglob('*') if p.is_file() and '/assets/' not in str(p)}
    assert hashes(destination)==manifest['source_hashes']
    for row in results:
        if row['accepted']:
            subprocess.run(['patch','--batch','--no-backup-if-mismatch','-p1','-d',str(destination)], input=(EVIDENCE/f'round-{row["round"]:02}.patch').read_bytes(), check=True, stdout=subprocess.DEVNULL)
    expected=hashes(destination); actual=hashes(ROOT)
    assert expected==actual, {p for p in expected.keys()|actual.keys() if expected.get(p)!=actual.get(p)}
    manifest['final_source_hashes']=actual
    manifest['rebuild_matches_final']=True
    changed=[p for p in actual if actual[p]!=manifest['source_hashes'].get(p)]
    manifest['changed_source_files']=changed
    print('Retained patches exactly rebuild all final source files:',changed)
for file in ['backend/benchmarks/performance-twenty.ts','backend/package-lock.json','frontend/package-lock.json']:
    manifest.setdefault('final_file_hashes',{})[file]=sha((ROOT/file).read_bytes())
for file in ['run-experiments.py','compare-final.py','check-frontend-control.py','verify-artifacts.py']:
    manifest.setdefault('script_hashes',{})[file]=sha((EVIDENCE/file).read_bytes())
(EVIDENCE/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('All 20 measurements, output hashes and retention gates verified.')
