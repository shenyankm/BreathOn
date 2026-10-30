"""Independent account cookie sessions; credentials stay in server configuration."""
import asyncio
from collections import deque
import hashlib
import hmac
import secrets
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
from ..core.identity import current_actor

COOKIE = 'medvisit_session'
SESSION_SECONDS = 8 * 60 * 60
SCRYPT = {'n':131072, 'r':8, 'p':1, 'dklen':32, 'maxmem':256 * 1024 * 1024}


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return f'scrypt:{salt.hex()}:{digest.hex()}'


def password_parts(encoded):
    try:
        algorithm, salt, digest = encoded.split(':')
        salt, digest = bytes.fromhex(salt), bytes.fromhex(digest)
        if algorithm != 'scrypt' or len(salt) != 16 or len(digest) != 32:
            raise ValueError
        return salt, digest
    except (ValueError, TypeError, AttributeError):
        raise ValueError('ADMIN_PASSWORD_HASH must be a valid scrypt password hash') from None


class Login(BaseModel):
    model_config = ConfigDict(extra='forbid')
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=512)


class Authentication:
    def __init__(self, settings):
        self.settings = settings
        self.sessions = {}
        self.attempts = deque()
        self.verifying = asyncio.Semaphore(1)
        self.router = APIRouter(prefix='/api/auth')
        self.router.add_api_route('/session', self.session, methods=['GET'])
        self.router.add_api_route('/login', self.login, methods=['POST'])
        self.router.add_api_route('/logout', self.logout, methods=['POST'])

    def token_key(self, token):
        return hashlib.sha256(token.encode()).hexdigest()

    def expires(self, connection):
        now = time.time()
        self.sessions = {key: session for key, session in self.sessions.items() if session['expires_at'] > now}
        return self.sessions.get(self.token_key(connection.cookies.get(COOKIE, '')), {}).get('expires_at', 0)

    def username(self, connection):
        return self.sessions.get(self.token_key(connection.cookies.get(COOKIE, '')), {}).get('username')

    async def session(self, request: Request):
        expires = self.expires(request)
        return {'enabled':self.settings.auth_required, 'authenticated':bool(expires),
                'username':self.username(request) if expires else None, 'expires_at':expires or None}

    async def login(self, body: Login, response: Response):
        if not self.settings.auth_required:
            raise HTTPException(400, '本地免登录模式未启用账号登录。')
        now = time.time()
        while self.attempts and self.attempts[0] <= now - 60:
            self.attempts.popleft()
        if len(self.attempts) >= 10:
            raise HTTPException(429, '登录尝试过多，请一分钟后重试。', headers={'Retry-After':'60'})
        self.attempts.append(now)
        users = self.settings.login_users
        salt, expected = password_parts(users.get(body.username, next(iter(users.values()))))
        async with self.verifying:
            actual = await asyncio.to_thread(hashlib.scrypt, body.password.encode(), salt=salt,
                                             **SCRYPT)
        username_ok = body.username in users
        if not hmac.compare_digest(actual, expected) or not username_ok:
            raise HTTPException(401, '账号或密码不正确。')
        token, expires = secrets.token_urlsafe(32), time.time() + SESSION_SECONDS
        self.sessions = {key: session for key, session in self.sessions.items() if session['expires_at'] > time.time()}
        if len(self.sessions) >= 32:
            del self.sessions[next(iter(self.sessions))]
        self.sessions[self.token_key(token)] = {'username':body.username, 'expires_at':expires}
        response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite='strict',
                            secure=all(origin.startswith('https://') for origin in self.settings.origins), path='/')
        return {'enabled':True, 'authenticated':True, 'username':body.username, 'expires_at':expires}

    async def logout(self, request: Request, response: Response):
        self.sessions.pop(self.token_key(request.cookies.get(COOKIE, '')), None)
        response.delete_cookie(COOKIE, path='/', httponly=True, samesite='strict',
                               secure=all(origin.startswith('https://') for origin in self.settings.origins))
        return {'ok':True}


class AuthenticationMiddleware:
    def __init__(self, app, auth):
        self.app, self.auth = app, auth

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket') or not self.auth.settings.auth_required:
            return await self.app(scope, receive, send)
        public = ('/api/live', '/api/ready', '/api/auth/session', '/api/auth/login', '/api/auth/logout')
        if scope['type'] == 'http' and scope['path'] in public:
            return await self.app(scope, receive, send)
        connection = HTTPConnection(scope)
        if not self.auth.expires(connection):
            if scope['type'] == 'websocket':
                return await send({'type':'websocket.close', 'code':1008})
            return await JSONResponse({'detail':'请先登录。'}, status_code=401, headers={'Cache-Control':'no-store'})(scope, receive, send)
        identity = current_actor.set(self.auth.username(connection))
        try:
            if scope['type'] == 'websocket':
                async def authenticated_receive():
                    message = await receive()
                    if message['type'] != 'websocket.disconnect' and not self.auth.expires(connection):
                        await send({'type':'websocket.close', 'code':1008})
                        return {'type':'websocket.disconnect', 'code':1008}
                    return message
                return await self.app(scope, authenticated_receive, send)
            return await self.app(scope, receive, send)
        finally:
            current_actor.reset(identity)


if __name__ == '__main__':
    import getpass
    password = getpass.getpass('Administrator password (at least 12 characters): ')
    if len(password) < 12:
        raise SystemExit('Use a password with at least 12 characters.')
    print(hash_password(password))
