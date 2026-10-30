"""Bound API input and correlate requests without logging private URLs or payloads."""
import asyncio
import json
import logging
import re
from time import monotonic
import traceback
from uuid import uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.exceptions import HTTPException

logger = logging.getLogger('medvisit.http')
JSON_LIMIT = 8_000_000
PDF_LIMIT = 20_000_000
BODY_TIMEOUT_SECONDS = 15


class ApiMiddleware:
    def __init__(self, app, origins):
        self.app, self.origins = app, origins

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/api/'):
            return await self.app(scope, receive, send)
        request_id, started, status, sent = uuid4().hex, monotonic(), 500, False
        scope.setdefault('state', {})['request_id'] = request_id

        async def response_send(message):
            nonlocal status, sent
            if message['type'] == 'http.response.start':
                status, sent = message['status'], True
                headers = MutableHeaders(scope=message)
                headers['X-Request-ID'] = request_id
                headers['Cache-Control'] = 'no-store'
                headers['X-Content-Type-Options'] = 'nosniff'
            await send(message)

        async def reject(code, detail):
            await JSONResponse({'detail':detail}, status_code=code)(scope, receive, response_send)

        try:
            if scope['method'] not in ('GET', 'HEAD', 'OPTIONS'):
                headers = Headers(scope=scope)
                if headers.get('origin') not in self.origins:
                    return await reject(403, '请求来源未获授权。')
                size = headers.get('content-length', '')
                content_type = headers.get('content-type', '').split(';')[0].strip().lower()
                if len(headers.getlist('content-length')) > 1:
                    return await reject(400, '请求长度不明确。')
                if scope['method'] == 'POST' and re.fullmatch(r'/api/visits/[^/]+/audio', scope['path']):
                    if headers.get('transfer-encoding') or not size or not size.isdecimal():
                        return await reject(411, '请使用包含 Content-Length 的请求。')
                    if int(size) > 100_000_000:
                        return await reject(413, '录音超过100MB。')
                    count = 0
                    deadline = monotonic() + 900
                    async def audio_receive():
                        nonlocal count
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise HTTPException(408, '录音上传超时。')
                        try:
                            message = await asyncio.wait_for(receive(), min(60, remaining))
                        except TimeoutError:
                            raise HTTPException(408, '录音上传超时。') from None
                        count += len(message.get('body', b''))
                        if count > 100_000_000:
                            raise HTTPException(413, '录音超过100MB。')
                        return message
                    await self.app(scope, audio_receive, response_send)
                    return
                if headers.get('transfer-encoding') or (not size and content_type in ('application/json', 'application/pdf')):
                    return await reject(411, '请使用包含 Content-Length 的请求。')
                limit = PDF_LIMIT if content_type == 'application/pdf' or scope['path'] == '/api/research/policy-file' else JSON_LIMIT
                if size and (not size.isdecimal() or int(size) > limit):
                    return await reject(413, '请求内容过大。')
                # Count actual bytes before parsing, including an understated Content-Length.
                body = bytearray()
                try:
                    async with asyncio.timeout(BODY_TIMEOUT_SECONDS):
                        while True:
                            message = await receive()
                            if message['type'] == 'http.disconnect':
                                status = 499
                                return
                            chunk = message.get('body', b'')
                            if len(body)+len(chunk) > limit:
                                return await reject(413, '请求内容过大。')
                            body.extend(chunk)
                            if not message.get('more_body', False):
                                break
                except TimeoutError:
                    return await reject(408, '请求接收超时，请稍后重试。')
                payload, delivered = bytes(body), False
                del body

                async def buffered_receive():
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {'type':'http.request', 'body':payload, 'more_body':False}
                    return await receive()

                await self.app(scope, buffered_receive, response_send)
            else:
                await self.app(scope, receive, response_send)
        except Exception as exc:
            logger.error(json.dumps({'event':'http_error', 'request_id':request_id,
                'error_type':type(exc).__name__, 'frames':[
                    {'file':frame.filename.rsplit('/', 1)[-1], 'line':frame.lineno, 'function':frame.name}
                    for frame in traceback.extract_tb(exc.__traceback__)]}))
            if sent:
                raise RuntimeError(f'Response interrupted; request_id={request_id}') from None
            await reject(500, '服务暂时无法完成请求，请稍后重试。')
        finally:
            logger.info(json.dumps({'event':'http_request', 'request_id':request_id, 'method':scope['method'],
                'route':getattr(scope.get('route'), 'path', 'unmatched'), 'status':status,
                'duration_ms':round((monotonic()-started)*1000, 2)}))
