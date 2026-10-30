import asyncio
import base64
import gzip
import json
import math
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from openai import AsyncClient
from websockets.asyncio.server import serve

from conftest import LocalClient
from medvisit.api.app import create_app
from medvisit.services import service_status as checks
from medvisit.voice.protocol import BridgeError
from test_bridge import ORIGIN, settings
from test_protocol import response


@pytest.mark.parametrize('recognized', ['你好', ''])
async def test_asr_requires_final_recognition_from_real_audio(tmp_path, recognized):
    received = bytearray()
    async def vendor(ws):
        assert ws.request.headers['X-Api-Key'] == 'fake-asr-key'
        async for raw in ws:
            if raw[1] >> 4 != 2:
                continue
            received.extend(gzip.decompress(raw[8:]))
            if raw[1] & 2:
                await ws.send(response({'result': {'text': recognized}}, True))
    async with serve(vendor, '127.0.0.1', 0) as server:
        config = settings(tmp_path, asr_endpoint=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}')
        if recognized:
            await checks.check_asr(config)
        else:
            with pytest.raises(ValueError, match='No recognized speech'):
                await checks.check_asr(config)
    assert received == checks.CHECK_AUDIO.read_bytes()


@pytest.mark.parametrize('outcome', ['audio', 'empty', 'refused'])
async def test_duplex_requires_audio_reply_after_input_and_closes(tmp_path, outcome):
    received = bytearray()
    closed = asyncio.Event()
    fixture = checks.CHECK_AUDIO.read_bytes()
    total_bytes = math.ceil((len(fixture) + 64000) / 640) * 640
    async def vendor(ws):
        try:
            assert ws.request.headers['X-Api-Key'] == 'fake-key'
            async for raw in ws:
                data = json.loads(raw)
                if data['type'] == 'session.create':
                    await ws.send(json.dumps({'type': 'error' if outcome == 'refused' else 'session.created'}))
                elif data['type'] == 'input_audio_buffer.append':
                    pcm = base64.b64decode(data['audio'], validate=True)
                    assert len(pcm) == 640
                    received.extend(pcm)
                    if len(received) == total_bytes:
                        if outcome == 'audio':
                            await ws.send(json.dumps({'type': 'response.output_audio.delta', 'delta': 'AAA='}))
                        await ws.send(json.dumps({'type': 'response.done'}))
                elif data['type'] == 'session.close':
                    return
        finally:
            closed.set()
    async with serve(vendor, '127.0.0.1', 0) as server:
        config = settings(tmp_path, endpoint=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}')
        if outcome == 'audio':
            await checks.check_duplex(config)
        else:
            with pytest.raises(BridgeError if outcome == 'refused' else ValueError):
                await checks.check_duplex(config)
        await asyncio.wait_for(closed.wait(), 1)
    if outcome != 'refused':
        assert received.startswith(fixture) and not any(received[len(fixture):])


@pytest.mark.parametrize('content', ['{"status":"ok"}', '{}', 'not-json'])
async def test_analysis_validates_real_completion_payload(tmp_path, content):
    def vendor(request):
        body = json.loads(request.content)
        assert request.headers['authorization'] == 'Bearer fake-deepseek-key'
        assert body['model'] == 'fake-model'
        assert body['thinking'] == {'type': 'disabled'}
        assert body['response_format'] == {'type': 'json_object'}
        return httpx.Response(200, json={'id': 'check', 'created': 0, 'model': 'fake-model', 'object': 'chat.completion',
            'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': content}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor)) as http:
        with patch.object(checks, 'AsyncClient', lambda **kwargs: AsyncClient(http_client=http, **kwargs)):
            if content == '{"status":"ok"}':
                await checks.check_analysis(settings(tmp_path))
            else:
                with pytest.raises(ValueError):
                    await checks.check_analysis(settings(tmp_path))


@pytest.mark.parametrize('failed, affected', [
    ('asr', {'asr', 'practice', 'combat'}), ('tts', {'tts', 'practice'}),
    ('analysis', {'analysis', 'practice', 'combat'}), ('duplex', {'combat'}),
])
async def test_failures_are_isolated_and_propagate_only_to_dependent_modes(tmp_path, failed, affected):
    probes = {key: AsyncMock(side_effect=ValueError('private-api-key') if key == failed else None)
              for key in ('asr', 'tts', 'analysis', 'duplex')}
    with patch.multiple(checks, **{f'check_{key}': probe for key, probe in probes.items()}):
        result = await checks.check_services(settings(tmp_path))
    assert {key for key, item in result['services'].items() if not item['ok']} == affected
    assert 'private-api-key' not in json.dumps(result)
    assert result['services']['practice']['model'] == 'fake-model'
    assert result['services']['analysis']['model'] == 'fake-model'
    assert result['services']['asr']['model'] == 'SeedASR · bigmodel'
    assert result['services']['tts']['model'] == 'seed-tts-2.0'
    assert result['services']['combat']['model'] == 'Seeduplex · 1.2.6.1'
    for probe in probes.values():
        probe.assert_awaited_once()


async def test_missing_config_and_timeouts_never_appear_healthy(tmp_path):
    config = settings(tmp_path)
    config.asr_api_key = ''
    probe = AsyncMock()
    result = await checks.check_provider(config, probe, ('asr_api_key',))
    assert not result['ok'] and '缺少' in result['message']
    probe.assert_not_awaited()
    probe.side_effect = TimeoutError()
    result = await checks.check_provider(config, probe, ('api_key',))
    assert not result['ok'] and '超时' in result['message']


async def test_deadline_cancels_stalled_provider_and_releases_resources(tmp_path):
    cancelled = asyncio.Event()
    async def stalled(config):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    with patch.object(checks, 'CHECK_TIMEOUT', 0.01):
        result = await checks.check_provider(settings(tmp_path), stalled, ('api_key',))
    assert not result['ok'] and '超时' in result['message'] and cancelled.is_set()


@pytest.mark.parametrize('status, reason', [(401, '鉴权'), (429, '额度')])
async def test_provider_http_errors_are_redacted(tmp_path, status, reason):
    def vendor(request):
        return httpx.Response(status, json={'error': {'message': 'private-api-key'}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(vendor)) as http:
        with patch.object(checks, 'AsyncClient', lambda **kwargs: AsyncClient(http_client=http, **kwargs)):
            result = await checks.check_provider(settings(tmp_path), checks.check_analysis, ('deepseek_api_key',))
    assert not result['ok'] and reason in result['message']
    assert 'private-api-key' not in json.dumps(result)


def test_check_route_requires_allowed_origin_and_health_remains_passive(tmp_path):
    result = {'services': {key: {'ok': True, 'message': ''} for key in ('asr', 'tts', 'analysis', 'practice', 'combat')}}
    probe = AsyncMock(return_value=result)
    with patch('medvisit.api.app.check_services', probe), LocalClient(create_app(settings(tmp_path))) as client:
        assert client.get('/api/health').status_code == 200
        probe.assert_not_awaited()
        assert client.post('/api/services/check', headers={'origin': 'https://evil.example'}).status_code == 403
        probe.assert_not_awaited()
        assert client.post('/api/services/check', headers=ORIGIN).json() == result
        probe.assert_awaited_once()
    assert not list(tmp_path.glob('*.json'))


async def test_concurrent_checks_share_work_and_one_cancelled_request_does_not_cancel_others(tmp_path):
    started, release = asyncio.Event(), asyncio.Event()
    async def probe(config):
        started.set()
        await release.wait()
        return {'services': {}}
    mock = AsyncMock(side_effect=probe)
    with patch('medvisit.api.app.check_services', mock):
        app = create_app(settings(tmp_path))
        endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/services/check')
        first = asyncio.create_task(endpoint())
        await started.wait()
        second = asyncio.create_task(endpoint())
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert await second == {'services': {}}
        mock.assert_awaited_once()
        await endpoint()
        assert mock.await_count == 2
