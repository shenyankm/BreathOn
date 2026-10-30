import json
import os
import random
import stat
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import psycopg

from medvisit.storage.records import FileRecords, SessionRecord, list_records
from medvisit.storage.import_records import import_records
from medvisit.platform.progress import personal_progress
from psycopg.types.json import Jsonb
from test_storage import database_url, store
from test_operations import platform, save_record


def test_streaming_latest_transcript_does_not_scan_prior_messages():
    class Messages(list):
        visits = 0
        def __iter__(self):
            for message in super().__iter__():
                self.visits += 1
                yield message

    record = SessionRecord('test', 'assisted')
    record.data['messages'] = messages = Messages(
        {'id':str(index), 'role':'doctor', 'text':'', 'final':False} for index in range(2000)
    )
    for _ in range(100):
        record.transcript('1999', 'doctor', '音', final=False)
    assert messages[-1]['text'] == '音'*100
    assert messages.visits == 0
    record.transcript('7', 'doctor', '修正', final=True)
    assert messages[7]['text'] == '修正' and messages[7]['final']
    record.transcript('new', 'trainee', '新话轮', final=True)
    assert messages[-1]['id'] == 'new' and len(messages) == 2001


def test_recent_record_selection_avoids_sorting_the_entire_history():
    class Time(float):
        comparisons = 0
        def __lt__(self, other):
            Time.comparisons += 1
            return super().__lt__(other)
        def __neg__(self):
            return Time(-float(self))

    class RecordPath:
        def __init__(self, index, modified):
            self.stem, self.modified = str(UUID(int=index+1)), modified
        def stat(self):
            return SimpleNamespace(st_mtime=Time(self.modified), st_mode=stat.S_IFREG)
        def read_text(self, **kwargs):
            if self.modified > 9950:
                return 'broken json'
            return json.dumps({'id':self.stem, 'messages':[], 'workspace':'local'})

    times = list(range(10000))
    random.Random(0).shuffle(times)
    paths = [RecordPath(index, modified) for index, modified in enumerate(times)]
    directory = SimpleNamespace(glob=lambda pattern: iter(paths))
    expected = [path.stem for path in sorted(paths, key=lambda path: path.modified, reverse=True)
                if path.modified <= 9950][:50]
    rows = list_records(directory, workspace='local')
    assert [row['id'] for row in rows] == expected
    assert Time.comparisons < 25000


@pytest.mark.parametrize('limit', [2, None])
def test_record_selection_keeps_directory_order_for_equal_timestamps(tmp_path, limit):
    sessions = [SessionRecord(str(uuid4()), 'assisted') for _ in range(3)]
    paths = []
    for record in sessions:
        path = tmp_path/f'{record.data["id"]}.json'
        path.write_text(json.dumps(record.data))
        os.utime(path, (10, 10))
        paths.append(path)
    directory = SimpleNamespace(glob=lambda pattern: iter(paths))
    assert [row['id'] for row in list_records(directory, limit=limit)] == [record.data['id'] for record in sessions][:limit]


@pytest.mark.parametrize('backend', ['file', 'postgres'])
def test_get_many_preserves_missing_records_and_full_documents(tmp_path, request, backend):
    records = request.getfixturevalue('store') if backend == 'postgres' else FileRecords(tmp_path)
    sessions = [SessionRecord(str(uuid4()), 'assisted') for _ in range(3)]
    for index, record in enumerate(sessions):
        record.transcript('u1', 'trainee', f'原话{index}', final=True)
        records.save(record, 'completed')
    ids = [UUID(sessions[2].data['id']), uuid4(), UUID(sessions[0].data['id'])]
    found = records.get_many(ids)
    assert set(found) == {str(ids[0]), str(ids[2])}
    assert found[str(ids[0])]['messages'][0]['text'] == '原话2'
    assert records.get_many([]) == {}


def test_record_import_batches_writes_and_counts_existing_rows(store, tmp_path, monkeypatch):
    sessions = [SessionRecord(str(uuid4()), 'assisted') for _ in range(3)]
    for record in sessions:
        (tmp_path/f'{record.data["id"]}.json').write_text(json.dumps(record.data))
    store.save(sessions[0], 'completed')
    singles, batches = [], []
    execute, executemany = psycopg.Cursor.execute, psycopg.Cursor.executemany

    def one(cursor, query, *args, **kwargs):
        if isinstance(query, str) and query.startswith('INSERT INTO sessions'):
            singles.append(query)
        return execute(cursor, query, *args, **kwargs)

    def many(cursor, query, parameters, **kwargs):
        batches.append(len(parameters))
        return executemany(cursor, query, parameters, **kwargs)

    monkeypatch.setattr(psycopg.Cursor, 'execute', one)
    monkeypatch.setattr(psycopg.Cursor, 'executemany', many)
    assert import_records(store, tmp_path) == (2, 1)
    assert singles == [] and batches == [3]
    assert all(store.get(UUID(record.data['id'])) is not None for record in sessions)
    empty = tmp_path/'empty'
    empty.mkdir()
    assert import_records(store, empty) == (0, 0)


@pytest.mark.parametrize('backend', ['file', 'postgres'])
@pytest.mark.parametrize('damage', ['assessment', 'id', 'status', 'dimensions', 'dimension', 'score'])
def test_malformed_current_activity_cache_recovers_from_original(tmp_path, request, backend, damage):
    records = request.getfixturevalue('store') if backend == 'postgres' else FileRecords(tmp_path)
    record = SessionRecord(str(uuid4()), 'assisted')
    record.data['workspace'] = 'test'
    record.transcript('one', 'trainee', 'Original transcript', final=True)
    records.save(record, 'completed')
    expected = json.loads(json.dumps(record.data['activity']))
    if damage == 'assessment':
        record.data['activity']['assessment'] = None
    elif damage in ('id', 'status'):
        record.data['activity'].pop(damage)
    else:
        record.data['activity']['assessment']['dimensions'] = {
            'dimensions': None, 'dimension': [None],
            'score': [{'key':'test', 'label':'Test', 'score':'invalid'}],
        }[damage]
    if backend == 'postgres':
        with records.pool.connection() as connection:
            connection.execute('UPDATE sessions SET document=%s WHERE id=%s', (Jsonb(record.data), UUID(record.data['id'])))
    else:
        (tmp_path/f'{record.data["id"]}.json').write_text(json.dumps(record.data))

    assert records.activity() == [expected]
    report = personal_progress(None, records, {'workspace':'test'})
    assert report['session_count'] == 1 and report['sessions'][0]['id'] == record.data['id']
    assert records.get(UUID(record.data['id'])) == record.data


def test_valid_postgres_activity_cache_needs_no_record_reread(store, monkeypatch):
    record = SessionRecord(str(uuid4()), 'assisted')
    store.save(record, 'completed')
    monkeypatch.setattr(store, 'get', lambda *_: pytest.fail('Valid cached activity must not reread the full record'))
    assert store.activity() == [record.data['activity']]


@pytest.mark.parametrize('damage', ['calibration_status', 'source_score'])
def test_progress_rebuilds_incomplete_cache_and_excludes_invalid_rebuilds(platform, damage):
    client, service, _, scene = platform
    good = save_record(client, service, scene, '我会核对资料范围，再在约定时间反馈。', score=1)
    changed = save_record(client, service, scene, '我会先确认原文，并通过授权渠道跟进。', score=2)
    if damage == 'calibration_status':
        changed.data['activity']['assessment'].pop('calibration_status')
    else:
        changed.data['coaching'][0]['assessment']['dimensions'][0]['score'] = 'bad'
        changed.data.pop('activity')
    if isinstance(service.records, FileRecords):
        (service.records.directory/f'{changed.data["id"]}.json').write_text(json.dumps(changed.data))
    else:
        with service.records.pool.connection() as connection:
            connection.execute('UPDATE sessions SET document=%s WHERE id=%s', (Jsonb(changed.data), UUID(changed.data['id'])))

    response = client.get('/api/progress')
    assert response.status_code == 200, response.text
    report = response.json()
    group = report['groups'][0]
    assert group['first_record_id'] == good.data['id']
    if damage == 'calibration_status':
        assert report['session_count'] == group['attempts'] == 2
        assert group['calibration_status'] == 'uncalibrated' and group['dimensions'][0]['delta'] == 1
    else:
        assert report['session_count'] == group['attempts'] == 1
        assert group['dimensions'][0]['delta'] is None
    assert client.get('/api/sessions/'+changed.data['id']).json() == changed.data
