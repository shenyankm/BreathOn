from uuid import uuid4
import asyncio
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings
from medvisit.storage.records import SessionRecord
from medvisit.storage.checkpoints import SessionCheckpoint, read_checkpoint


def test_config_requires_known_admin_and_configures_capacity(monkeypatch):
    encoded = hash_password('example secure password')
    with pytest.raises(ValueError, match='ADMIN_USERS_JSON'):
        Settings(auth_required=True, login_users={'rep':encoded})
    monkeypatch.setenv('VOICE_MAX_SESSIONS', '10')
    config = Settings(auth_required=True, login_users={'rep':encoded}, admin_users=['rep'])
    assert config.max_sessions == 10
    monkeypatch.setenv('VOICE_MAX_SESSIONS', '0')
    with pytest.raises(ValueError, match='MAX_SESSIONS'):
        Settings()


def test_admin_record_access_is_audited_and_representative_cannot_manage(tmp_path):
    password = 'example secure password'
    encoded = hash_password(password)
    origin = 'https://example.test'
    app = create_app(Settings(records=tmp_path, auth_required=True,
        login_users={'admin':encoded, 'rep':encoded}, origins=(origin,)))
    if not any(getattr(route, 'path', '') == '/api/admin/sessions' for route in app.routes):
        from medvisit.api.admin_records import admin_records_router
        app.include_router(admin_records_router(app.state.records, app.state.platform, lambda: app.state.local_user))
    with TestClient(app, base_url=origin, headers={'Origin':origin}) as client:
        record = SessionRecord(str(uuid4()), 'assisted')
        record.data.update(workspace=app.state.local_user['workspace'], owner_id='rep', team='')
        app.state.records.save(record, 'completed')
        assert client.post('/api/auth/login', json={'username':'rep', 'password':password}).json()['role'] == 'representative'
        assert client.get('/api/admin/sessions').status_code == 403
        assert client.post('/api/catalog/doctor', json={}).status_code == 403
        assert client.get('/api/research').status_code == 403
        assert client.get('/api/scenarios/' + str(uuid4()) + '/export').status_code == 403
        assert client.get('/api/sessions/' + record.data['id']).status_code == 200
        client.post('/api/auth/logout')
        assert client.post('/api/auth/login', json={'username':'admin', 'password':password}).json()['role'] == 'admin'
        response = client.get('/api/admin/sessions/' + record.data['id'])
        assert response.status_code == 200 and response.json()['owner_id'] == 'rep'
        with app.state.platform.transaction(app.state.local_user['workspace'], write=False) as tx:
            assert any(row['action'] == 'session.read' and row['object_id'] == record.data['id']
                for row in tx.list(app.state.local_user['workspace'], 'audit'))


def test_checkpoint_keeps_only_confirmed_turns_and_recovers_with_owner_access(tmp_path):
    password = 'example secure password'
    encoded = hash_password(password)
    origin = 'https://example.test'
    app = create_app(Settings(records=tmp_path, auth_required=True,
        login_users={'admin':encoded, 'rep':encoded, 'other':encoded}, origins=(origin,)))
    with TestClient(app, base_url=origin, headers={'Origin':origin}) as client:
        item = SessionRecord(str(uuid4()), 'assisted')
        item.data.update(workspace=app.state.local_user['workspace'], owner_id='rep', team='', experience='practice')
        item.transcript('a', 'trainee', '已确认的转录', final=True)
        item.transcript('b', 'trainee', '尚未确认', final=False)
        checkpoint = SessionCheckpoint(tmp_path, item)
        asyncio.run(checkpoint.save())
        assert [m['text'] for m in read_checkpoint(tmp_path, item.data['id'])['messages']] == ['已确认的转录']
        assert client.get(f"/api/visits/{uuid4()}/provider-audio?token=bad").status_code == 404
        assert client.get('/api/visits').status_code == 401
        client.post('/api/auth/login', json={'username':'other','password':password})
        assert client.get(f"/api/sessions/{item.data['id']}/status").status_code == 404
        client.post('/api/auth/logout')
        client.post('/api/auth/login', json={'username':'rep','password':password})
        assert client.get(f"/api/sessions/{item.data['id']}/status").json()['state'] == 'interrupted'
        assert client.get(f"/api/sessions/{item.data['id']}").json()['messages'][0]['text'] == '已确认的转录'
        assert item.data['id'] in [row['id'] for row in client.get('/api/sessions').json()]


def test_restart_queries_existing_transcription_without_resubmission(tmp_path):
    app = create_app(Settings(records=tmp_path))
    with TestClient(app):
        workspace = app.state.local_user['workspace']
        with app.state.platform.transaction(workspace) as tx:
            tx.create(workspace, 'visit', {'owner_id':'local', 'audio_status':'transcribing',
                'transcription_job_id':str(uuid4())})
    requests = []

    class Response:
        headers = {'X-Api-Status-Code':'55000031'}

    class FakeClient:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            requests.append(url)
            return Response()

    with patch('medvisit.visits.api.httpx.AsyncClient', FakeClient):
        with TestClient(app):
            for _ in range(100):
                if requests:
                    break
                time.sleep(0.01)
    assert requests and all(url.endswith('/query') for url in requests)
