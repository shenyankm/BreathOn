import json
import os
from uuid import UUID, uuid4
from unittest.mock import patch

import psycopg
import pytest
from conftest import LocalClient as TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from medvisit.api.app import create_app
from medvisit.core.config import Settings
from medvisit.storage.import_records import import_records
from medvisit.storage.postgres import PostgresRecords
from medvisit.storage.records import SessionRecord, FileRecords
from test_bridge import ORIGIN, receive_until, settings


@pytest.fixture(scope="module")
def database_url():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to run real PostgreSQL integration tests")
    name = "medvisit_test_" + uuid4().hex
    # All writes and cleanup target this freshly created, isolated test database.
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            yield make_conninfo(url, dbname=name)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def store(database_url):
    store = PostgresRecords(database_url)
    try:
        store.open()
        with store.pool.connection() as connection:
            connection.execute("TRUNCATE sessions")
        yield store
    finally:
        store.close()


def test_postgres_roundtrip_summary_limit_and_upsert(store, database_url):
    ids = []
    for index in range(55):
        record = SessionRecord(str(uuid4()), "assisted")
        record.data["experience"] = "practice"
        record.data.update(workspace="tests", owner_id="admin@example.test", team="")
        record.transcript("u1", "trainee", f"private transcript {index}", final=True)
        store.save(record, "completed")
        ids.append(record.data["id"])
    summaries = store.list()
    assert len(summaries) == 50
    assert [item["id"] for item in summaries] == list(reversed(ids))[:50]
    assert summaries[0]["message_count"] == 1
    assert "private transcript" not in json.dumps(summaries)
    record.data["messages"][0]["text"] = "corrected"
    store.save(record, "interrupted")
    assert store.get(UUID(ids[-1]))["messages"][0]["text"] == "corrected"
    with TestClient(create_app(Settings(database_url=database_url))) as client:
        assert client.get("/api/health").json()["storage"] == "postgresql"
        assert client.get("/api/sessions").json()[0]["id"] == ids[-1]
        assert client.get(f"/api/sessions/{ids[-1]}").json()["status"] == "interrupted"
        assert client.get(f"/api/sessions/{uuid4()}").status_code == 404
        assert client.get("/api/sessions/invalid").status_code == 422


@pytest.mark.parametrize('backend', ['file','postgres'])
def test_record_summaries_show_scene_names_and_keep_legacy_records_readable(tmp_path, request, backend):
    records = request.getfixturevalue('store') if backend=='postgres' else FileRecords(tmp_path)
    record = SessionRecord(str(uuid4()), 'assisted')
    record.data['training'] = {'scenario':{'title':'首次拜访：确认医生关注点'}}
    record.transcript('u1','trainee','只保留在详情中的原话。',final=True)
    records.save(record,'completed')
    summary = records.list()[0]
    assert summary['scenario_title']=='首次拜访：确认医生关注点'
    assert records.list(include_owner=True) == [{**summary, 'owner_id':None, 'doctor':None}]
    assert 'owner_id' not in summary
    assert '只保留在详情中的原话' not in json.dumps(summary,ensure_ascii=False)
    old = SessionRecord(str(uuid4()), 'assisted')
    records.save(old,'completed')
    assert records.list()[0]['scenario_title'] is None
    assert records.get(UUID(record.data['id']))['messages'][0]['text']=='只保留在详情中的原话。'


def test_import_is_idempotent_keeps_originals_and_validates_before_writing(store, tmp_path):
    record = SessionRecord(str(uuid4()), "independent")
    record.transcript("u1", "trainee", "original", final=True)
    record.save(tmp_path, "completed")
    path = tmp_path / f'{record.data["id"]}.json'
    original = path.read_bytes()
    assert import_records(store, tmp_path) == (1, 0)
    record.data["messages"][0]["text"] = "newer database version"
    store.save(record, "completed")
    assert import_records(store, tmp_path) == (0, 1)
    assert path.read_bytes() == original
    assert store.get(UUID(record.data["id"]))["messages"][0]["text"] == "newer database version"
    second = SessionRecord(str(uuid4()), "assisted")
    second.save(tmp_path, "completed")
    (tmp_path / "invalid.json").write_text("[]")
    with pytest.raises(ValueError):
        import_records(store, tmp_path)
    assert store.get(UUID(second.data["id"])) is None


@pytest.mark.parametrize("document", [{}, {"id": "wrong", "messages": []}, {"id": None, "messages": []}])
def test_database_rejects_invalid_record_shapes(store, document):
    with pytest.raises(psycopg.errors.CheckViolation):
        with store.pool.connection() as connection:
            connection.execute("INSERT INTO sessions (id, document) VALUES (%s, %s)", (uuid4(), Jsonb(document)))
    assert store.list() == []


@pytest.mark.parametrize('damaged', [
    {'training': ['invalid']}, {'coaching': None}, {'messages': [None]},
    {'coaching': [{'final_report': True, 'assessment': None}]},
])
def test_postgres_activity_isolates_malformed_legacy_records(store, tmp_path, damaged):
    healthy = SessionRecord(str(uuid4()), 'assisted')
    store.save(healthy, 'completed')
    broken = SessionRecord(str(uuid4()), 'assisted')
    broken.data.update(damaged)
    (tmp_path/f'{broken.data["id"]}.json').write_text(json.dumps(broken.data))
    assert import_records(store, tmp_path) == (1, 0)

    assert store.activity() == [healthy.data['activity']]
    assert store.get(UUID(broken.data['id'])) == broken.data


def test_database_unavailable_is_redacted(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        with patch.object(app.state.records, "list", side_effect=psycopg.OperationalError("secret database DSN")):
            response = client.get("/api/sessions")
        assert response.status_code == 503 and "secret" not in response.text
        with patch.object(app.state.records, "save", side_effect=psycopg.OperationalError("secret database DSN")):
            with client.websocket_connect("/api/realtime?experience=practice", headers=ORIGIN) as ws:
                ws.send_json({"type": "start", "mode": "invalid"})
                ended = receive_until(ws, "ended")
                assert ended["saved"] is False


@pytest.mark.parametrize('recovery_fails', [False, True])
def test_failed_session_save_retains_importable_recovery_copy(database_url, tmp_path, recovery_fails):
    app = create_app(settings(tmp_path, database_url=database_url))

    async def practice(client, config, record):
        record.transcript('u1', 'trainee', '软件测试：需要保留的演练原话。', final=True)
        return 'completed'

    original_save = SessionRecord.save
    def recovery(record, directory, status):
        if recovery_fails:
            raise OSError('private disk failure')
        return original_save(record, directory, status)

    with TestClient(app) as client, patch('medvisit.api.app.run_practice', side_effect=practice), \
            patch.object(app.state.records, 'save', side_effect=psycopg.OperationalError('private database address')), \
            patch.object(SessionRecord, 'save', recovery):
        with client.websocket_connect('/api/realtime?experience=practice', headers=ORIGIN) as ws:
            ws.send_json({'type':'start', 'mode':'assisted'})
            ended = receive_until(ws, 'ended')
        assert ended['saved'] is False
        assert ended['recovery_saved'] is not recovery_fails
        assert 'private' not in json.dumps(ended)
        if not recovery_fails:
            directory = tmp_path/'recovery'
            path = directory/f'{ended["session_id"]}.json'
            assert path.stat().st_mode & 0o777 == 0o600
            assert directory.stat().st_mode & 0o777 == 0o700
            original = path.read_bytes()
            assert import_records(app.state.records, directory) == (1, 0)
            assert import_records(app.state.records, directory) == (0, 1)
            assert path.read_bytes() == original
            restored = app.state.records.get(UUID(ended['session_id']))
            assert restored['messages'][0]['text'] == '软件测试：需要保留的演练原话。'
            assert restored['status'] == 'completed'
