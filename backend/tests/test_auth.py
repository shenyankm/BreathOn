import time
from unittest.mock import AsyncMock, patch

import pytest
from test_storage import database_url
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from medvisit.api.app import create_app
from medvisit.api.auth import COOKIE, hash_password
from medvisit.core.config import Settings

ORIGIN = 'https://openwook.cloud'
PASSWORD = 'a-test-only-password-2026'


@pytest.fixture
def client(tmp_path):
    settings = Settings(records=tmp_path, auth_required=True, admin_username='admin',
                        admin_password_hash=hash_password(PASSWORD), origins=(ORIGIN,))
    with TestClient(create_app(settings), base_url=ORIGIN, headers={'Origin':ORIGIN}) as client:
        yield client


def login(client, **values):
    return client.post('/api/auth/login', json={'username':'admin', 'password':PASSWORD, **values})


def test_private_routes_and_websocket_require_login_without_calling_providers(client):
    with patch('medvisit.api.app.check_services', AsyncMock()) as providers:
        for path in ('/api/sessions', '/api/health', '/api/doctor', '/api/platform/scenarios', '/docs', '/openapi.json'):
            assert client.get(path).status_code == 401
        assert client.post('/api/services/check').status_code == 401
        with pytest.raises(WebSocketDisconnect) as denied:
            with client.websocket_connect('/api/realtime', headers={'Origin':ORIGIN}):
                pytest.fail('Anonymous websocket was accepted')
        assert denied.value.code == 1008
        providers.assert_not_called()
    assert client.get('/api/live').status_code == 200
    assert client.get('/api/ready').status_code == 200
    assert client.get('/api/auth/session').json()['authenticated'] is False


def test_login_cookie_access_and_server_side_logout_revoke_copied_token(client):
    response = login(client)
    assert response.status_code == 200
    cookie = response.headers['set-cookie'].lower()
    assert all(flag in cookie for flag in ('httponly', 'secure', 'samesite=strict', 'path=/', 'max-age=28800'))
    token = client.cookies.get(COOKIE)
    assert token and PASSWORD not in response.text
    assert client.get('/api/auth/session').json()['authenticated'] is True
    assert client.get('/api/sessions').status_code == 200
    with client.websocket_connect('/api/realtime?experience=invalid', headers={'Origin':ORIGIN, 'Cookie':f'{COOKIE}={token}'}) as socket:
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()
    assert client.post('/api/auth/logout').status_code == 200
    client.cookies.set(COOKIE, token)
    assert client.get('/api/sessions').status_code == 401


def test_login_preserves_origin_checks_and_rejects_forged_or_expired_cookies(client, monkeypatch):
    assert client.post('/api/auth/login', json={'username':'admin','password':PASSWORD}, headers={'Origin':'https://evil.example'}).status_code == 403
    assert login(client, password='wrong-password').status_code == 401
    assert login(client, username='unknown').status_code == 401
    client.cookies.set(COOKIE, 'forged-token')
    assert client.get('/api/sessions').status_code == 401
    client.cookies.clear()
    assert login(client).status_code == 200
    future = time.time() + 28801
    monkeypatch.setattr('medvisit.api.auth.time.time', lambda: future)
    assert client.get('/api/sessions').status_code == 401
    assert client.get('/api/auth/session').json()['authenticated'] is False


def test_login_attempts_are_bounded_and_errors_do_not_echo_password(client):
    for _ in range(10):
        response = login(client, password='wrong-password-secret')
        assert response.status_code == 401 and 'secret' not in response.text
    assert login(client).status_code == 429
    assert client.get('/api/live').status_code == 200


def test_public_auth_configuration_fails_closed_and_hash_is_private():
    with pytest.raises(ValueError, match='ADMIN_PASSWORD_HASH'):
        Settings(auth_required=True, admin_password_hash='')
    encoded = hash_password(PASSWORD)
    with pytest.raises(ValueError, match='HTTPS'):
        Settings(auth_required=True, admin_password_hash=encoded, origins=('http://public.example',))
    assert encoded not in repr(Settings(auth_required=True, admin_password_hash=encoded))


@pytest.mark.parametrize('storage', ['file', 'postgres'])
def test_two_accounts_keep_independent_sessions_and_private_records(tmp_path, request, storage):
    from uuid import uuid4
    from medvisit.storage.records import SessionRecord
    encoded = hash_password(PASSWORD)
    url = request.getfixturevalue('database_url') if storage == 'postgres' else ''
    if url:
        from conftest import clear_test_database
        clear_test_database(url)
    app = create_app(Settings(records=tmp_path, database_url=url, auth_required=True, login_users={'admin':encoded, 'coach':encoded}, origins=(ORIGIN,)))
    with TestClient(app, base_url=ORIGIN, headers={'Origin':ORIGIN}) as client:
        def sign_in(name):
            client.cookies.clear()
            response = login(client, username=name)
            assert response.status_code == 200
            return client.cookies.get(COOKIE)
        first = sign_in('admin')
        second = sign_in('coach')
        ids = {}
        for name in ('admin', 'coach'):
            record = SessionRecord(str(uuid4()), 'assisted')
            record.data.update(workspace=app.state.local_user['workspace'], owner_id=name, team='')
            record.transcript('u1', 'trainee', f'{name} private transcript', final=True)
            app.state.records.save(record, 'completed')
            ids[name] = record.data['id']
        with app.state.platform.transaction(app.state.local_user['workspace']) as tx:
            case = tx.create(app.state.local_user['workspace'], 'case', {'created_by':'admin', 'status':'draft', 'approach':'private transcript'})
            plan = tx.create(app.state.local_user['workspace'], 'remediation', {'owner_id':'admin', 'status':'assigned', 'parent_record_id':ids['admin']})
        for name, token, other in (('admin', first, 'coach'), ('coach', second, 'admin')):
            client.cookies.clear(); client.cookies.set(COOKIE, token)
            assert client.get('/api/auth/session').json()['username'] == name
            assert [item['id'] for item in client.get('/api/sessions').json()] == [ids[name]]
            assert client.get(f'/api/sessions/{ids[name]}').status_code == 200
            for suffix in ('', '/reviews', '/remediations'):
                assert client.get(f'/api/sessions/{ids[other]}{suffix}').status_code == 404
            assert client.post(f'/api/sessions/{ids[other]}/reviews', json={'comment':'forbidden'}).status_code == 404
            assert client.post(f'/api/sessions/{ids[other]}/retrain', json={}).status_code == 404
            assert client.post(f'/api/sessions/{ids[other]}/cases', json={'message_id':'u1'}).status_code == 404
            assert client.get('/api/catalog/doctor').status_code == 200
            assert 'private transcript' not in client.get('/api/progress').text
            assert ids[other] not in client.get('/api/progress').text
        assert client.get('/api/cases').json() == []
        assert client.get('/api/remediations').json() == []
        for path in (f'/api/cases/{case["id"]}', f'/api/cases/{case["id"]}/export', f'/api/remediations/{plan["id"]}/next', f'/api/remediations/{plan["id"]}/progress'):
            assert client.get(path).status_code == 404
        assert client.post('/api/auth/logout').status_code == 200
        client.cookies.clear(); client.cookies.set(COOKIE, first)
        assert client.get('/api/sessions').status_code == 200
        assert client.get('/api/auth/session').json()['username'] == 'admin'


def test_two_authenticated_voice_sessions_coexist_and_keep_owners(tmp_path):
    from test_bridge import Provider, receive_until, settings
    from test_practice import REPLY
    encoded = hash_password(PASSWORD)
    config = settings(tmp_path)
    config.auth_required = True
    config.login_users = {'admin':encoded, 'coach':encoded}
    config.origins = (ORIGIN,)
    app = create_app(config)
    async def voice(*args, **kwargs):
        return Provider()
    with patch('medvisit.api.app.connect', voice), \
         patch('medvisit.api.app.asr_connection', side_effect=lambda *args, **kwargs: Provider(asr=True)), \
         patch('medvisit.services.final_review.generate_reply', AsyncMock(return_value=(REPLY, {}))), \
         TestClient(app, base_url=ORIGIN, headers={'Origin':ORIGIN}) as client:
        login(client, username='admin'); first = client.cookies.get(COOKIE)
        client.cookies.clear(); login(client, username='coach'); second = client.cookies.get(COOKIE)
        with client.websocket_connect('/api/realtime', headers={'Origin':ORIGIN, 'Cookie':f'{COOKIE}={first}'}) as one:
            one.send_json({'type':'start','mode':'assisted'})
            a = receive_until(one, 'ready')['session_id']
            with client.websocket_connect('/api/realtime', headers={'Origin':ORIGIN, 'Cookie':f'{COOKIE}={first}'}) as repeat:
                assert repeat.receive_json()['code'] == 'busy'
            with client.websocket_connect('/api/realtime', headers={'Origin':ORIGIN, 'Cookie':f'{COOKIE}={second}'}) as two:
                two.send_json({'type':'start','mode':'assisted'})
                b = receive_until(two, 'ready')['session_id']
                assert a != b
                two.send_json({'type':'stop'}); receive_until(two, 'ended')
            one.send_json({'type':'stop'}); receive_until(one, 'ended')
        from uuid import UUID
        assert app.state.records.get(UUID(a))['owner_id'] == 'admin'
        assert app.state.records.get(UUID(b))['owner_id'] == 'coach'
