from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from medvisit.research.archive import write_private
from medvisit.storage import records
from medvisit.storage.import_records import import_records


def test_concurrent_private_writes_publish_whole_files_with_separate_staging(tmp_path, monkeypatch):
    destination = tmp_path/'job'/'observations.json'
    barrier = Barrier(2)
    replace = os.replace
    staged = []
    def publish(source, target):
        staged.append(source)
        barrier.wait(timeout=5)
        return replace(source, target)
    monkeypatch.setattr(os, 'replace', publish)
    payloads = [json.dumps({'value':letter*100_000}).encode() for letter in ('a', 'b')]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda data:write_private(destination, data), payloads))
    assert len(set(staged)) == 2
    assert destination.read_bytes() in payloads
    assert destination.stat().st_mode & 0o777 == 0o600
    assert list(destination.parent.iterdir()) == [destination]


def test_failed_sync_preserves_previous_session_and_removes_staging(tmp_path, monkeypatch):
    record = records.SessionRecord(str(uuid4()), 'assisted')
    record.save(tmp_path, 'completed')
    destination = tmp_path/f'{record.data["id"]}.json'
    previous = destination.read_bytes()
    def full_disk(fd):
        raise OSError('software-test full disk')
    monkeypatch.setattr(os, 'fsync', full_disk)
    record.transcript('new', 'trainee', 'not committed', final=True)
    with pytest.raises(OSError, match='full disk'):
        record.save(tmp_path, 'interrupted')
    assert destination.read_bytes() == previous
    assert list(tmp_path.iterdir()) == [destination]


def test_file_store_creates_private_directory_without_changing_existing_permissions(tmp_path):
    directory = tmp_path/'sessions'
    records.FileRecords(directory).open()
    assert directory.stat().st_mode & 0o777 == 0o700
    directory.chmod(0o755)
    records.FileRecords(directory).open()
    assert directory.stat().st_mode & 0o777 == 0o755


def test_new_directory_entries_are_synced_with_the_file(tmp_path, monkeypatch):
    opened = []
    original = os.open
    def track(path, *args, **kwargs):
        fd = original(path, *args, **kwargs)
        if Path(path).is_dir():
            opened.append(Path(path))
        return fd
    monkeypatch.setattr(os, 'open', track)
    destination = tmp_path/'new'/'nested'/'record.json'
    write_private(destination, b'{}')
    assert opened == [destination.parent, destination.parent.parent, tmp_path]


@pytest.mark.parametrize('failure', [FileNotFoundError, PermissionError])
@pytest.mark.parametrize('activity', [False, True])
def test_record_listing_skips_unavailable_metadata_without_losing_healthy_records(tmp_path, monkeypatch, failure, activity):
    saved = []
    for index in range(3):
        record = records.SessionRecord(str(uuid4()), 'assisted')
        record.save(tmp_path, 'completed')
        path = tmp_path / f'{record.data["id"]}.json'
        os.utime(path, (index + 1, index + 1))
        saved.append(record.data['id'])
    broken = tmp_path / f'{saved[1]}.json'
    original = Path.stat

    def stat(path, *args, **kwargs):
        if path == broken:
            raise failure('unavailable record')
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'stat', stat)
    assert [row['id'] for row in records.list_records(tmp_path, activity=activity)] == [saved[2], saved[0]]


@pytest.mark.parametrize('activity, damaged', [
    (False, {'training': ['invalid']}),
    (False, {'training': {'scenario': None}}),
    (True, {'training': ['invalid']}),
    (True, {'coaching': None}),
    (True, {'messages': [None]}),
    (True, {'coaching': [{'final_report': True, 'assessment': None}]}),
])
def test_record_listing_isolates_malformed_nested_data(tmp_path, activity, damaged):
    healthy = records.SessionRecord(str(uuid4()), 'assisted')
    healthy.save(tmp_path, 'completed')
    broken = records.SessionRecord(str(uuid4()), 'assisted')
    broken.data.update(damaged)
    path = tmp_path/f'{broken.data["id"]}.json'
    original = json.dumps(broken.data)
    path.write_text(original)

    assert [row['id'] for row in records.list_records(tmp_path, activity=activity)] == [healthy.data['id']]
    assert path.read_text() == original


@pytest.mark.parametrize('cache', [None, [], 'damaged'])
def test_invalid_activity_cache_is_rebuilt_from_original_record(tmp_path, cache):
    record = records.SessionRecord(str(uuid4()), 'assisted')
    record.transcript('one', 'trainee', 'Original transcript', final=True)
    record.save(tmp_path, 'completed')
    expected = record.data['activity']
    record.data['activity'] = cache
    path = tmp_path/f'{record.data["id"]}.json'
    original = json.dumps(record.data)
    path.write_text(original)

    assert records.FileRecords(tmp_path).activity() == [expected]
    assert path.read_text() == original


@pytest.mark.parametrize('operation', ['list', 'import'])
def test_session_files_must_be_regular_before_opening(tmp_path, monkeypatch, operation):
    healthy = records.SessionRecord(str(uuid4()), 'assisted')
    healthy.save(tmp_path, 'completed')
    blocked = tmp_path/f'{uuid4()}.json'
    os.mkfifo(blocked)
    original_read = Path.read_text

    def read(path, *args, **kwargs):
        if path == blocked:
            pytest.fail('Reading a record FIFO would block the request indefinitely')
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'read_text', read)
    if operation == 'list':
        assert [row['id'] for row in records.list_records(tmp_path)] == [healthy.data['id']]
    else:
        with pytest.raises(ValueError, match='普通文件'):
            import_records(SimpleNamespace(), tmp_path)
    assert blocked.exists()


def test_batch_read_keeps_available_records_when_one_disappears(tmp_path, monkeypatch):
    sessions = [records.SessionRecord(str(uuid4()), 'assisted') for _ in range(2)]
    for record in sessions:
        record.save(tmp_path, 'completed')
    missing = tmp_path/f'{sessions[0].data["id"]}.json'
    original_read = Path.read_text

    def read(path, *args, **kwargs):
        if path == missing:
            path.unlink()
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'read_text', read)
    found = records.FileRecords(tmp_path).get_many([UUID(record.data['id']) for record in sessions])
    assert found == {sessions[1].data['id']: sessions[1].data}
