from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import time

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/check-native.py'
spec = spec_from_file_location('native_smoke', SCRIPT)
smoke = module_from_spec(spec)
sys.modules[spec.name] = smoke
spec.loader.exec_module(smoke)


@pytest.fixture
def environment(tmp_path):
    caddy = tmp_path / 'caddy'
    caddy.write_text('#!/bin/sh\nexit 0\n')
    caddy.chmod(0o700)
    web = tmp_path / 'web'
    (web / 'assets').mkdir(parents=True)
    (web / 'index.html').write_text('<html></html>')
    return {'NATIVE_DISPOSABLE': '1', 'NATIVE_DATABASE_URL': 'postgresql://ci:synthetic@127.0.0.1:15432/ci_native',
            'NATIVE_DB_CONTAINER': 'a' * 64, 'NATIVE_CADDY_BIN': str(caddy), 'NATIVE_WEB_ROOT': str(web)}


def test_native_smoke_requires_explicit_disposable_database_container_and_built_resources(environment):
    options = smoke.options(environment)
    assert options.container == 'a' * 64
    assert options.web_root.joinpath('index.html').is_file()
    for field, value in [('NATIVE_DISPOSABLE', '0'), ('NATIVE_DB_CONTAINER', 'container; shell'),
                         ('NATIVE_CADDY_BIN', '/missing/caddy'), ('NATIVE_WEB_ROOT', '/missing/web')]:
        with pytest.raises(smoke.SmokeError):
            smoke.options({**environment, field: value})


@pytest.mark.parametrize('database', [
    'postgresql://u:p@production.example/database', 'postgresql://u:p@0.0.0.0/database',
    'postgresql://u:p@127.0.0.1.example/database', 'postgresql://u:p@127.0.0.1/',
    'postgresql://u:p@127.0.0.1:invalid/database', 'postgresql://u:p@127.0.0.1/db?host=production.example',
    'https://127.0.0.1/database',
])
def test_native_smoke_rejects_nonlocal_or_ambiguous_databases(environment, database):
    with pytest.raises(smoke.SmokeError, match='loopback PostgreSQL'):
        smoke.options({**environment, 'NATIVE_DATABASE_URL': database})


def test_database_is_restarted_when_an_outage_assertion_fails(monkeypatch):
    calls = []
    monkeypatch.setattr(smoke, 'command', lambda args, **kwargs: calls.append(args))
    with pytest.raises(AssertionError):
        with smoke.stopped_database('a' * 64):
            raise AssertionError('Synthetic check failure')
    assert calls == [['docker', 'stop', '--time', '5', 'a' * 64], ['docker', 'start', 'a' * 64]]


def test_native_child_is_terminated_when_a_check_fails(tmp_path):
    with pytest.raises(AssertionError):
        with smoke.process([sys.executable, '-c', 'import time; time.sleep(60)'], {}, tmp_path / 'child.log') as child:
            assert child.poll() is None
            raise AssertionError('Synthetic check failure')
    assert child.poll() is not None


@pytest.mark.parametrize('faults', [1, None])
def test_native_readiness_retries_truncated_status_until_ready_or_deadline(faults):
    class Handler(BaseHTTPRequestHandler):
        calls = 0
        def log_message(self, *args): pass
        def do_GET(self):
            type(self).calls += 1
            if faults is None or type(self).calls <= faults:
                self.wfile.write(b'HTTP/1.1 20')
                self.close_connection = True
                return
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        started = time.monotonic()
        try:
            origin = f'http://127.0.0.1:{server.server_port}'
            processes = [SimpleNamespace(poll=lambda:None)]
            if faults is None:
                with pytest.raises(smoke.SmokeError, match='did not become ready'):
                    smoke.wait_ready(origin, processes, timeout=0.35)
            else:
                smoke.wait_ready(origin, processes, timeout=2)
        finally:
            server.shutdown()
            worker.join(timeout=2)
    if faults is None:
        assert Handler.calls >= 1
    else:
        assert Handler.calls == 2
    assert time.monotonic() - started < 2


def test_native_readiness_fails_immediately_if_a_process_exits(monkeypatch):
    monkeypatch.setattr(smoke, 'status', lambda *args:pytest.fail('Exited processes must fail before HTTP'))
    with pytest.raises(smoke.SmokeError, match='process exited'):
        smoke.wait_ready('http://127.0.0.1', [SimpleNamespace(poll=lambda:1)])
