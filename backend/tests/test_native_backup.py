import importlib.util
import json
import os
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location('native_backup', Path(__file__).resolve().parents[2]/'deploy/native-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
COUNTS = {'postgres_major':17, 'sessions':1, 'platform_entities':2}


def source(tmp_path):
    sessions = tmp_path/'sessions'
    (sessions/'research').mkdir(parents=True)
    (sessions/'research'/'original.html').write_text('synthetic evidence')
    audio = tmp_path/'visit-audio'
    audio.mkdir()
    (audio/'private.ogg').write_bytes(b'private recording')
    return sessions


def command_fixture(monkeypatch, state='inactive', fail=False):
    calls = []
    def command(args, **kwargs):
        calls.append(args)
        if args[0] == 'systemctl':
            return f'LoadState=loaded\nActiveState={state}\n'.encode()
        if 'psql' in args:
            return json.dumps(COUNTS).encode()
        if 'pg_dump' in args:
            if fail:
                raise RuntimeError('simulated database failure')
            kwargs['output'].write(b'PGDMPsynthetic-dump')
            return b''
        pytest.fail('Unexpected command: ' + args[0])
    monkeypatch.setattr(backup.shared, 'command', command)
    return calls


def test_native_backup_reuses_format_one_excludes_audio_and_never_manages_services(tmp_path, monkeypatch):
    sessions = source(tmp_path)
    (sessions/'visit-audio').mkdir()
    (sessions/'visit-audio'/'also-private.ogg').write_bytes(b'private recording')
    calls = command_fixture(monkeypatch)
    target = tmp_path/'snapshots'/'capture'
    backup.backup(['docker','compose'], 'medvisit-coach', target, sessions, 'medvisit-coach.service')
    manifest = backup.shared.verify(target)
    assert manifest['format'] == 1 and manifest['database'] == COUNTS
    assert manifest['files'] == {'research/original.html':backup.shared.sha256(sessions/'research'/'original.html')}
    assert manifest['excluded_directories'] == ['visit-audio']
    assert target.stat().st_mode & 0o777 == 0o700
    assert all((target/name).stat().st_mode & 0o777 == 0o600 for name in (*backup.shared.PAYLOADS, 'manifest.json'))
    assert calls[0][0:2] == ['systemctl','show']
    assert not any(any(action in call for action in ('start','stop','restart','up','run')) for call in calls)
    assert any('pg_dump' in call and '-Fc' in call for call in calls)
    assert b'private recording' not in (target/'files.tar').read_bytes()


@pytest.mark.parametrize('state', ['active', 'activating', 'deactivating', 'reloading', ''])
def test_native_backup_refuses_unstopped_api_before_database_or_output(tmp_path, monkeypatch, state):
    sessions = source(tmp_path)
    calls = command_fixture(monkeypatch, state=state)
    with pytest.raises(ValueError, match='Stop the loaded'):
        backup.backup(['docker','compose'], 'medvisit-coach', tmp_path/'capture', sessions, 'medvisit-coach.service')
    assert len(calls) == 1 and not (tmp_path/'capture').exists()


@pytest.mark.parametrize('kind', ['symlink', 'environment', 'fifo'])
def test_native_backup_rejects_unsafe_session_members_and_cleans_partial_snapshot(tmp_path, monkeypatch, kind):
    sessions = source(tmp_path)
    command_fixture(monkeypatch)
    if kind == 'symlink':
        (sessions/'external').symlink_to(tmp_path/'visit-audio')
    elif kind == 'environment':
        (sessions/'.env').write_text('NOT_A_REAL_SECRET=synthetic')
    else:
        os.mkfifo(sessions/'pipe')
    with pytest.raises(ValueError, match='links, devices, or environment'):
        backup.backup(['docker','compose'], 'medvisit-coach', tmp_path/'capture', sessions, 'medvisit-coach.service')
    assert not (tmp_path/'capture').exists() and not list(tmp_path.glob('.capture.*'))


def test_native_backup_failure_never_restarts_api_and_does_not_publish_partial_snapshot(tmp_path, monkeypatch):
    sessions = source(tmp_path)
    calls = command_fixture(monkeypatch, fail=True)
    with pytest.raises(RuntimeError, match='simulated'):
        backup.backup(['docker','compose'], 'medvisit-coach', tmp_path/'capture', sessions, 'medvisit-coach.service')
    assert not (tmp_path/'capture').exists() and not list(tmp_path.glob('.capture.*'))
    assert sum(call[0] == 'systemctl' for call in calls) == 1


def test_native_backup_rejects_recursive_destination_and_missing_service(tmp_path, monkeypatch):
    sessions = source(tmp_path)
    monkeypatch.setattr(backup.shared, 'command', lambda args, **kwargs: b'LoadState=not-found\nActiveState=inactive\n')
    with pytest.raises(ValueError, match='outside'):
        backup.backup(['docker','compose'], 'medvisit-coach', sessions/'capture', sessions, 'medvisit-coach.service')
    with pytest.raises(ValueError, match='Stop the loaded'):
        backup.backup(['docker','compose'], 'medvisit-coach', tmp_path/'capture', sessions, 'medvisit-coach.service')
