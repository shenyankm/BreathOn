from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
from threading import Thread
import time

from fastapi.responses import RedirectResponse
import pytest
import uvicorn

from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings


SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/check-auth.py'
spec = spec_from_file_location('deploy_auth_smoke', SCRIPT)
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)


@pytest.fixture
def credentials(tmp_path):
    accounts = {role: {'username':'ci-auth-' + suffix, 'password':secrets.token_urlsafe(32)}
                for role, suffix in (('admin','admin'), ('representative_a','a'), ('representative_b','b'))}
    path = tmp_path / 'credentials.json'
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as file:
        json.dump(accounts, file)
    return path, accounts


@contextmanager
def running_server(tmp_path, accounts, *, authenticated=True):
    transport = socket.socket()
    transport.bind(('127.0.0.1', 0))
    origin = f'http://127.0.0.1:{transport.getsockname()[1]}'
    config = Settings(records=tmp_path/'server', origins=(origin,), auth_required=authenticated,
        login_users={account['username']:hash_password(account['password']) for account in accounts.values()} if authenticated else {},
        admin_users=[accounts['admin']['username']] if authenticated else [])
    app = create_app(config)
    app.add_api_route('/ci-redirect-check', lambda: RedirectResponse('/api/live'))
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False))
    worker = Thread(target=lambda: server.run(sockets=[transport]), daemon=True)
    worker.start()
    try:
        for _ in range(500):
            if server.started or not worker.is_alive():
                break
            time.sleep(0.01)
        assert server.started, 'Disposable test API failed to start'
        yield origin, app
    finally:
        server.should_exit = True
        worker.join(timeout=5)
        transport.close()
        assert not worker.is_alive(), 'Disposable test API failed to stop'


def test_auth_smoke_checks_real_cookie_roles_private_visits_and_revocation(tmp_path, credentials):
    path, accounts = credentials
    with running_server(tmp_path, accounts) as (origin, app):
        result = subprocess.run([sys.executable, str(SCRIPT), origin], capture_output=True, text=True, timeout=20,
            env={**os.environ, 'DISPOSABLE_AUTH_SMOKE':'1', 'AUTH_SMOKE_CREDENTIALS_FILE':str(path)})
        assert result.returncode == 0, result.stderr
        assert 'Compose authentication checks passed' in result.stdout
        assert all(account['password'] not in result.stdout+result.stderr for account in accounts.values())
        with app.state.platform.transaction(app.state.local_user['workspace'], write=False) as tx:
            visits = tx.list(app.state.local_user['workspace'], 'visit')
        assert len(visits) == 2
        assert {visit['owner_id'] for visit in visits} == {accounts[role]['username'] for role in ('representative_a','representative_b')}
        assert all(visit['source'] == 'self_report' and visit['audio_status'] == 'none' for visit in visits)


@pytest.mark.parametrize('origin', [
    'https://production.example', 'http://127.0.0.1.example:18080', 'http://0.0.0.0:18080',
    'http://password@127.0.0.1:18080', 'http://127.0.0.1:18080/app',
    'http://127.0.0.1:18080?target=production', 'http://127.0.0.1:18080#production', 'http://[invalid',
])
def test_smoke_never_opens_a_nonlocal_or_decorated_target(origin, credentials, monkeypatch):
    monkeypatch.setattr(smoke, 'Client', lambda *_: pytest.fail('Unsafe target reached the network'))
    with pytest.raises(smoke.SmokeError):
        smoke.check_auth(origin, credentials[0], disposable=True)


def test_smoke_requires_explicit_disposable_flag_and_private_ephemeral_accounts(credentials, monkeypatch):
    path, accounts = credentials
    monkeypatch.setattr(smoke, 'Client', lambda *_: pytest.fail('Unsafe setup reached the network'))
    with pytest.raises(smoke.SmokeError, match='DISPOSABLE_AUTH_SMOKE'):
        smoke.check_auth('http://127.0.0.1:18080', path)
    path.chmod(0o644)
    with pytest.raises(smoke.SmokeError, match='private'):
        smoke.check_auth('http://127.0.0.1:18080', path, disposable=True)
    path.chmod(0o600)
    accounts['admin']['username'] = 'production-admin'
    path.write_text(json.dumps(accounts))
    with pytest.raises(smoke.SmokeError, match='ci-auth-'):
        smoke.check_auth('http://127.0.0.1:18080', path, disposable=True)
    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=5,
        env={**os.environ, 'DISPOSABLE_AUTH_SMOKE':'1', 'AUTH_SMOKE_CREDENTIALS_FILE':str(path)})
    assert result.returncode != 0
    assert all(account['password'] not in result.stdout+result.stderr for account in accounts.values())
    assert 'production-admin' not in result.stdout+result.stderr


def test_smoke_refuses_auth_disabled_before_writes_and_never_follows_redirects(tmp_path, credentials):
    path, accounts = credentials
    with running_server(tmp_path, accounts, authenticated=False) as (origin, app):
        with pytest.raises(smoke.SmokeError, match='enable authentication'):
            smoke.check_auth(origin, path, disposable=True)
        with app.state.platform.transaction(app.state.local_user['workspace'], write=False) as tx:
            assert not tx.list(app.state.local_user['workspace'], 'visit')
        smoke.Client(origin).expect('/ci-redirect-check', 307)
