import time
from unittest.mock import AsyncMock, patch

import pytest
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
