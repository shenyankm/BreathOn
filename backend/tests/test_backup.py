import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import tarfile

import pytest

spec = importlib.util.spec_from_file_location('compose_backup', Path(__file__).resolve().parents[2]/'deploy/backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def archive(path, name='research/source/original.html', kind=tarfile.REGTYPE):
    with tarfile.open(path, 'w:') as stream:
        member = tarfile.TarInfo(name)
        member.type = kind
        member.size = 4 if kind == tarfile.REGTYPE else 0
        member.linkname = '/outside' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
        stream.addfile(member, BytesIO(b'test') if member.size else None)


def snapshot(path):
    (path/'database.dump').write_bytes(b'PGDMPtest-backup')
    archive(path/'files.tar')
    manifest = {'format':1, 'source_project':'original', 'database':{'postgres_major':17,'sessions':1,'platform_entities':1},
        'sha256':{name:backup.sha256(path/name) for name in backup.PAYLOADS}, 'files':backup.archive_files(path/'files.tar')}
    (path/'manifest.json').write_text(json.dumps(manifest))
    return manifest


def test_verification_checks_dump_tar_members_and_each_file_hash(tmp_path):
    expected = snapshot(tmp_path)
    assert backup.verify(tmp_path) == expected
    (tmp_path/'database.dump').write_bytes(b'PGDMPtampered')
    with pytest.raises(ValueError, match='checksum'):
        backup.verify(tmp_path)


@pytest.mark.parametrize('invalid', [None, [], {'format':True}, {'sha256':None}, {'sha256':[]},
    {'source_project':None}, {'source_project':1}, {'database':None}, {'database':[]}, {'files':None}])
def test_restore_rejects_malformed_manifest_before_running_commands(tmp_path, monkeypatch, invalid):
    manifest = snapshot(tmp_path)
    if isinstance(invalid, dict):
        manifest.update(invalid)
    else:
        manifest = invalid
    (tmp_path/'manifest.json').write_text(json.dumps(manifest))
    monkeypatch.setattr(backup, 'command', lambda *args, **kwargs: pytest.fail('Invalid backup must not start Docker'))
    with pytest.raises(ValueError):
        backup.restore(['docker','compose'], 'new-project', tmp_path)


@pytest.mark.parametrize('name', [*backup.PAYLOADS, 'manifest.json'])
def test_verification_rejects_nonregular_files_before_opening_them(tmp_path, monkeypatch, name):
    snapshot(tmp_path)
    path = tmp_path/name
    path.unlink()
    os.mkfifo(path)
    original_open = Path.open
    def guarded_open(self, *args, **kwargs):
        if self == path:
            pytest.fail('Opening a backup FIFO can block forever')
        return original_open(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', guarded_open)
    with pytest.raises(ValueError, match='regular files'):
        backup.verify(tmp_path)


@pytest.mark.parametrize('name,kind', [('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),
    ('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE),('device',tarfile.CHRTYPE),('.env',tarfile.REGTYPE),('nested/.env.private',tarfile.REGTYPE)])
def test_archive_rejects_traversal_links_devices_and_environment_files(tmp_path, name, kind):
    path = tmp_path/'files.tar'
    archive(path, name, kind)
    with pytest.raises(ValueError):
        backup.archive_files(path)


def test_archive_rejects_compressed_or_duplicate_member_payloads(tmp_path):
    path = tmp_path/'files.tar'
    with tarfile.open(path, 'w:gz') as stream:
        stream.addfile(tarfile.TarInfo('directory/'))
    with pytest.raises(tarfile.ReadError):
        backup.archive_files(path)
    with tarfile.open(path, 'w:') as stream:
        for name in ('file','./file'):
            stream.addfile(tarfile.TarInfo(name))
    with pytest.raises(ValueError, match='Duplicate'):
        backup.archive_files(path)


@pytest.mark.parametrize('restart_fails', [False, True])
def test_backup_failure_restarts_only_previously_running_api_and_removes_partial_output(tmp_path, monkeypatch, restart_fails):
    calls = []
    def command(args, **kwargs):
        calls.append(args)
        if args[-4:] == ['ps','-a','-q','api'] or args[-5:] == ['ps','--status','running','-q','api']:
            return b'container-id'
        if 'psql' in args:
            return json.dumps({'postgres_major':17,'sessions':1,'platform_entities':1}).encode()
        if 'pg_dump' in args:
            raise RuntimeError('simulated storage failure')
        if 'up' in args and restart_fails:
            raise RuntimeError('simulated recovery failure')
        return b''
    monkeypatch.setattr(backup, 'command', command)
    target = tmp_path/'backup'
    with pytest.raises(RuntimeError, match='recovery' if restart_fails else 'storage'):
        backup.backup(['docker','compose'], 'original', target)
    assert ['docker','compose','stop','api'] in calls
    assert calls[-1] == ['docker','compose','up','-d','--no-deps','--no-recreate','--wait','--wait-timeout','90','api']
    assert not target.exists() and list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('failure', [RuntimeError('simulated API recovery failure'), KeyboardInterrupt()])
def test_backup_retains_verified_snapshot_when_api_restart_fails(tmp_path, monkeypatch, capsys, failure):
    counts = {'postgres_major':17, 'sessions':1, 'platform_entities':1}
    def command(args, **kwargs):
        if args[-4:] == ['ps','-a','-q','api'] or args[-5:] == ['ps','--status','running','-q','api']:
            return b'container-id'
        if 'psql' in args:
            return json.dumps(counts).encode()
        if 'pg_dump' in args:
            kwargs['output'].write(b'PGDMPcomplete-backup')
        if args[:2] == ['docker','cp']:
            with tarfile.open(fileobj=kwargs['output'], mode='w:') as stream:
                member = tarfile.TarInfo('research/source/original.html')
                member.size = 4
                stream.addfile(member, BytesIO(b'test'))
        if 'up' in args:
            raise failure
        return b''
    monkeypatch.setattr(backup, 'command', command)
    target = tmp_path/'backup'
    with pytest.raises(type(failure)) as caught:
        backup.backup(['docker','compose'], 'original', target)
    assert caught.value is failure
    assert backup.verify(target)['database'] == counts
    assert list(tmp_path.iterdir()) == [target]
    assert 'retained' in capsys.readouterr().err


def test_restore_refuses_source_project_and_any_existing_target_before_writing(tmp_path, monkeypatch):
    snapshot(tmp_path)
    calls = []
    def command(args, **kwargs):
        calls.append(args)
        return b'existing-volume' if args[1]=='volume' else b''
    monkeypatch.setattr(backup,'command',command)
    with pytest.raises(ValueError, match='different'):
        backup.restore(['docker','compose'], 'original', tmp_path)
    assert calls == []
    with pytest.raises(ValueError, match='already has'):
        backup.restore(['docker','compose'], 'new-project', tmp_path)
    assert len(calls) == 2 and calls[1][1:4] == ['volume','ls','-q']


def test_private_backup_files_and_project_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(backup.tempfile,'gettempdir',lambda: str(tmp_path))
    with backup.private_file(tmp_path/'private') as stream:
        stream.write(b'private-backup')
    assert (tmp_path/'private').stat().st_mode & 0o777 == 0o600
    with backup.project_lock('test'):
        with pytest.raises(ValueError, match='already'):
            with backup.project_lock('test'):
                pass
    with backup.project_lock('test'):
        pass
