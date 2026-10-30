"""Exercise native Uvicorn/Caddy against an explicitly disposable PostgreSQL container."""
from contextlib import contextmanager
from dataclasses import dataclass
from http.client import HTTPException
from ipaddress import ip_address
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


class SmokeError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SmokeError(message)


@dataclass(frozen=True)
class Options:
    database: str
    container: str
    caddy: str
    web_root: Path


def options(environ):
    require(environ.get('NATIVE_DISPOSABLE') == '1', 'Set NATIVE_DISPOSABLE=1 only for an expendable native CI stack')
    database = environ.get('NATIVE_DATABASE_URL', '')
    try:
        parsed = urlsplit(database)
        loopback = parsed.hostname == 'localhost' or ip_address(parsed.hostname or '').is_loopback
        valid = parsed.scheme in ('postgres', 'postgresql') and loopback and parsed.path not in ('', '/') and not parsed.query and not parsed.fragment
        parsed.port
    except ValueError:
        valid = False
    require(valid, 'NATIVE_DATABASE_URL must name a loopback PostgreSQL test database')
    container = environ.get('NATIVE_DB_CONTAINER', '')
    require(re.fullmatch(r'[a-f0-9]{12,64}', container) is not None, 'NATIVE_DB_CONTAINER must be the disposable PostgreSQL container ID')
    caddy = environ.get('NATIVE_CADDY_BIN') or shutil.which('caddy') or ''
    require(bool(caddy) and Path(caddy).is_file() and os.access(caddy, os.X_OK), 'NATIVE_CADDY_BIN must name an executable Caddy binary')
    web_root = Path(environ.get('NATIVE_WEB_ROOT', ROOT / 'frontend/dist')).resolve()
    require((web_root / 'index.html').is_file() and (web_root / 'assets').is_dir(), 'Build the Web management resources before running native smoke')
    return Options(database, container, str(Path(caddy).resolve()), web_root)


def free_port():
    with socket.socket() as transport:
        transport.bind(('127.0.0.1', 0))
        return transport.getsockname()[1]


def command(args, *, env=None, timeout=60):
    result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=timeout)
    require(result.returncode == 0, 'Native smoke command failed: ' + Path(args[0]).name)


def status(origin, path):
    opener = build_opener(ProxyHandler({}))
    try:
        response = opener.open(origin + path, timeout=8)
    except HTTPError as error:
        response = error
    with response:
        return response.status


def wait_ready(origin, processes, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        require(all(process.poll() is None for process in processes), 'A native process exited before becoming ready')
        try:
            if status(origin, '/api/ready') == 200:
                return
        except (OSError, URLError, HTTPException):
            pass
        time.sleep(0.2)
    raise SmokeError('The native API did not become ready through Caddy')


@contextmanager
def process(args, env, log):
    with log.open('wb') as output:
        child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output)
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)


@contextmanager
def stopped_database(container):
    # The explicit flag, loopback URL and container-ID guard are checked before this point.
    try:
        command(['docker', 'stop', '--time', '5', container], timeout=30)
        yield
    finally:
        command(['docker', 'start', container], timeout=30)


def serve_api():
    import uvicorn
    from medvisit.api.app import create_app
    from medvisit.core.config import Settings
    config = json.loads(Path(os.environ['NATIVE_API_CONFIG']).read_text())
    settings = Settings(auth_required=config['authenticated'], login_users=config['hashes'],
        admin_users=['ci-auth-admin'], origins=(config['origin'],), records=Path(config['records']),
        database_url=config['database'], api_key='', asr_api_key='', deepseek_api_key='', tts_api_key='',
        deepseek_search_enabled=False)
    uvicorn.run(create_app(settings), host='127.0.0.1', port=config['port'], access_log=False, log_level='warning',
                ws_max_size=4096, ws_max_queue=16, timeout_graceful_shutdown=10)


def check_native(config):
    from medvisit.api.auth import hash_password
    api_port, web_port = free_port(), free_port()
    while web_port == api_port:
        web_port = free_port()
    origin = f'http://127.0.0.1:{web_port}'
    with tempfile.TemporaryDirectory(prefix='medvisit-native-smoke-') as directory:
        temporary = Path(directory)
        credentials = {role: {'username': 'ci-auth-' + suffix, 'password': secrets.token_urlsafe(32)}
                       for role, suffix in (('admin', 'admin'), ('representative_a', 'a'), ('representative_b', 'b'))}
        hashes = {account['username']: hash_password(account['password']) for account in credentials.values()}
        accounts_path = temporary / 'credentials.json'
        api_config_path = temporary / 'api.json'
        for path in (accounts_path, api_config_path):
            path.touch(mode=0o600)
        accounts_path.write_text(json.dumps(credentials))
        records = temporary / 'data/sessions'
        api_config = {'authenticated': False, 'hashes': hashes, 'database': config.database,
                      'origin': origin, 'records': str(records), 'port': api_port}
        api_config_path.write_text(json.dumps(api_config))
        env = {**os.environ, 'NATIVE_API_CONFIG': str(api_config_path), 'PYTHONPATH': str(ROOT / 'backend'),
               'MEDVISIT_SITE': origin, 'MEDVISIT_WEB_ROOT': str(config.web_root),
               'MEDVISIT_API_UPSTREAM': f'127.0.0.1:{api_port}', 'MEDVISIT_CADDY_ADMIN': 'off',
               'MEDVISIT_ACCESS_LOG': str(temporary / 'access.log')}
        api = [sys.executable, str(Path(__file__).resolve()), '--serve-api']
        caddyfile = ROOT / 'deploy/Caddyfile.native'
        caddy = [config.caddy, 'run', '--config', str(caddyfile), '--adapter', 'caddyfile']
        command([config.caddy, 'validate', '--config', str(caddyfile), '--adapter', 'caddyfile'], env=env)
        with process(caddy, env, temporary / 'caddy.log') as proxy:
            with process(api, env, temporary / 'api-first.log') as first:
                wait_ready(origin, (proxy, first))
                subprocess.run([sys.executable, str(ROOT / 'deploy/check-stack.py'), origin], env=env, check=True, timeout=90)
                marker = records / 'ci-native-marker'
                marker.write_text('persistent')
            with process(api, env, temporary / 'api-restarted.log') as restarted:
                wait_ready(origin, (proxy, restarted))
                require(marker.read_text() == 'persistent', 'Native API restart lost its persistent record directory')
                subprocess.run([sys.executable, str(ROOT / 'deploy/check-stack.py'), origin], env=env, check=True, timeout=90)
                with stopped_database(config.container):
                    require(status(origin, '/api/live') == 200, 'Native API liveness failed during the database outage')
                    for path in ('/api/ready', '/api/sessions'):
                        require(status(origin, path) == 503, 'Database outage must return HTTP 503: ' + path)
                wait_ready(origin, (proxy, restarted))
            api_config['authenticated'] = True
            api_config_path.write_text(json.dumps(api_config))
            with process(api, env, temporary / 'api-auth.log') as authenticated:
                wait_ready(origin, (proxy, authenticated))
                auth_env = {**env, 'DISPOSABLE_AUTH_SMOKE': '1', 'AUTH_SMOKE_CREDENTIALS_FILE': str(accounts_path)}
                subprocess.run([sys.executable, str(ROOT / 'deploy/check-auth.py'), origin], env=auth_env, check=True, timeout=90)
    print('Native HTTP checks passed: Caddy routes, process restart, PostgreSQL outage/recovery, cookie account isolation')


def main():
    if sys.argv[1:] == ['--serve-api']:
        serve_api()
        return
    require(not sys.argv[1:], 'Usage: python deploy/check-native.py')
    def cancelled(signum, frame):
        raise SmokeError('Native smoke was interrupted')
    for event in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, cancelled)
    check_native(options(os.environ))


if __name__ == '__main__':
    try:
        main()
    except (SmokeError, OSError, subprocess.SubprocessError, ValueError) as error:
        # Do not include child logs, URLs, credentials or cookies in CI failure output.
        message = str(error) if isinstance(error, SmokeError) else 'native process or transport failure'
        raise SystemExit('Native smoke failed: ' + message) from None
