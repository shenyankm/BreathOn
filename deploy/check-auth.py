"""Exercise cookie authentication and user isolation only on a disposable local stack."""
import copy
from datetime import datetime, timezone
from http.client import HTTPException
from http.cookiejar import CookieJar
from ipaddress import ip_address
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, ProxyHandler, Request, build_opener
from uuid import UUID


ROLES = {'admin': 'admin', 'representative_a': 'representative', 'representative_b': 'representative'}


class SmokeError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SmokeError(message)


def local_origin(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
    except (TypeError, ValueError):
        raise SmokeError('The authentication smoke target must be a valid loopback origin') from None
    try:
        loopback = host == 'localhost' or ip_address(host).is_loopback
    except ValueError:
        loopback = False
    require(parsed.scheme in ('http', 'https') and loopback and not parsed.username and not parsed.password
            and parsed.path in ('', '/') and not parsed.query and not parsed.fragment,
            'The authentication smoke target must be a loopback HTTP(S) origin')
    try:
        parsed.port
    except ValueError:
        raise SmokeError('The authentication smoke target has an invalid port') from None
    return value.rstrip('/')


def credentials_file(path):
    try:
        path = Path(path)
        require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, 'Smoke credentials must be private (mode 600)')
        data = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        raise SmokeError('Unable to read the temporary smoke credentials') from None
    require(isinstance(data, dict) and set(data) == set(ROLES), 'Expected three temporary smoke accounts')
    names = []
    for account in data.values():
        require(isinstance(account, dict) and set(account) == {'username', 'password'}, 'Invalid smoke account fields')
        name, password = account['username'], account['password']
        require(isinstance(name, str) and name.startswith('ci-auth-') and len(name) <= 100,
                'Only disposable ci-auth- accounts may be used')
        require(isinstance(password, str) and 16 <= len(password) <= 512, 'Smoke passwords must be randomly generated')
        names.append(name)
    require(len(set(names)) == 3, 'Smoke accounts must have distinct usernames')
    return data


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.cookies = CookieJar()
        self.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(self.cookies), NoRedirect())

    def request(self, path, body=None):
        headers = {'Origin': self.origin, 'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = Request(self.origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = self.opener.open(request, timeout=8)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read(2_000_001)
            require(len(raw) <= 2_000_000, 'Smoke response exceeded the expected limit')
            try:
                value = json.loads(raw) if raw else None
            except ValueError:
                raise SmokeError('Expected a JSON response from ' + path) from None
            return response.status, response.headers, value

    def expect(self, path, expected, body=None):
        status, headers, value = self.request(path, body)
        require(status == expected, f'{path}: expected HTTP {expected}, received {status}')
        return headers, value


def check_auth(origin, path, *, disposable=False):
    require(disposable, 'Set DISPOSABLE_AUTH_SMOKE=1 only for an expendable CI stack')
    origin = local_origin(origin)
    accounts = credentials_file(path)
    anonymous = Client(origin)
    anonymous.expect('/api/ready', 200)
    _, session = anonymous.expect('/api/auth/session', 200)
    require(isinstance(session, dict) and session.get('enabled') is True and session.get('authenticated') is False,
            'The disposable server must enable authentication before running this smoke')
    for endpoint in ('/api/sessions', '/api/visits', '/api/admin/sessions', '/api/catalog/doctor'):
        anonymous.expect(endpoint, 401)

    clients = {}
    for role, account in accounts.items():
        client = clients[role] = Client(origin)
        _, session = client.expect('/api/auth/login', 200, account)
        require(isinstance(session, dict) and session.get('enabled') is True and session.get('authenticated') is True
                and session.get('username') == account['username'] and session.get('role') == ROLES[role],
                'Login returned an unexpected smoke identity or role')
        cookie = next((cookie for cookie in client.cookies if cookie.name == 'medvisit_session'), None)
        require(cookie is not None and bool(cookie.value) and cookie.has_nonstandard_attr('HttpOnly'),
                'The proxy did not preserve the HttpOnly login cookie')
        _, confirmed = client.expect('/api/auth/session', 200)
        require(isinstance(confirmed, dict) and confirmed.get('authenticated') is True and confirmed.get('username') == account['username']
                and confirmed.get('role') == ROLES[role], 'The login cookie did not restore the expected identity')

    admin = clients['admin']
    admin.expect('/api/admin/sessions', 200)
    visits = {}
    for role in ('representative_a', 'representative_b'):
        client = clients[role]
        client.expect('/api/admin/sessions', 403)
        client.expect('/api/catalog/doctor', 403, {})
        _, initial = client.expect('/api/visits', 200)
        require(initial == [], 'Use fresh smoke accounts without existing visits')
        text = 'Synthetic authentication isolation check: ' + role
        _, visit = client.expect('/api/visits', 201, {
            'source': 'self_report', 'visited_at': datetime.now(timezone.utc).date().isoformat(), 'text': text,
        })
        try:
            identifier = str(UUID(visit['id']))
        except (ValueError, TypeError, KeyError):
            raise SmokeError('The smoke visit response did not contain a valid identifier') from None
        require(visit.get('owner_id') == accounts[role]['username'], 'The server did not assign the visit to its authenticated owner')
        _, own = client.expect('/api/visits/' + identifier, 200)
        require(own.get('text') == text and own.get('owner_id') == accounts[role]['username'], 'The owner could not read their own visit')
        visits[role] = identifier

    for role, other in (('representative_a', 'representative_b'), ('representative_b', 'representative_a')):
        client = clients[role]
        client.expect('/api/visits/' + visits[other], 404)
        _, rows = client.expect('/api/visits', 200)
        require(isinstance(rows, list) and {row['id'] for row in rows} == {visits[role]}
                and all(row.get('owner_id') == accounts[role]['username'] for row in rows),
                'A representative visit list leaked another account or lost its own record')
        admin.expect('/api/visits/' + visits[role], 200)
        client.expect('/api/sessions', 200)

    for client in clients.values():
        stale = Client(origin)
        for cookie in client.cookies:
            stale.cookies.set_cookie(copy.copy(cookie))
        client.expect('/api/auth/logout', 200, {})
        client.expect('/api/visits', 401)
        stale.expect('/api/visits', 401)


def main():
    require(len(sys.argv) <= 2, 'Usage: python deploy/check-auth.py [loopback-origin]')
    origin = sys.argv[1] if len(sys.argv) == 2 else 'http://127.0.0.1:18080'
    path = os.environ.get('AUTH_SMOKE_CREDENTIALS_FILE')
    require(bool(path), 'AUTH_SMOKE_CREDENTIALS_FILE must name the private temporary account file')
    check_auth(origin, path, disposable=os.environ.get('DISPOSABLE_AUTH_SMOKE') == '1')
    print('Compose authentication checks passed: cookies, roles, private visit isolation, logout revocation')


if __name__ == '__main__':
    try:
        main()
    except SmokeError as error:
        raise SystemExit('Compose authentication smoke failed: ' + str(error)) from None
    except (OSError, URLError, HTTPException, ValueError, TypeError, KeyError, AttributeError):
        # Never include response bodies, account credentials, or cookie values in CI logs.
        raise SystemExit('Compose authentication smoke failed: transport or response format error') from None
