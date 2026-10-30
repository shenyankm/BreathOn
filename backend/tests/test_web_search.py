import asyncio
import json
from time import monotonic
from unittest.mock import patch

import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.agents.coach import generate_reply
from medvisit.agents.web_search import WebSearch, public_url
from medvisit.core.config import Settings
from medvisit.core.limits import RateLimit
from test_bridge import settings
from test_practice import REPLY


@pytest.mark.parametrize('url,valid', [
    ('https://www.nmpa.gov.cn/notice', True), ('https://example.com/a?article=1', True),
    ('javascript:alert(1)', False), ('https://user:password@example.com/a', False),
    ('http://127.0.0.1/a', False), ('http://[::1]/a', False), ('http://10.0.0.1/', False),
    ('http://localhost/a', False), ('https://host.internal/a', False),
    ('https://example.com/a?access_token=private', False), (None, False),
])
def test_source_urls_are_public_and_credential_free(url, valid):
    assert public_url(url) is valid


def test_limits_are_loaded_from_env_and_reject_invalid_values(monkeypatch):
    monkeypatch.setenv('DEEPSEEK_MAX_CONCURRENCY', '7')
    monkeypatch.setenv('DEEPSEEK_SEARCH_QPS', '8')
    monkeypatch.setenv('DEEPSEEK_FETCH_QPS', '9')
    monkeypatch.setenv('DEEPSEEK_SEARCH_ENABLED', 'true')
    config = Settings()
    assert config.deepseek_max_concurrency == 7 and config.deepseek_search_enabled
    assert config._search_rate.interval == 1 / 8 and config._fetch_rate.interval == 1 / 9
    with pytest.raises(ValueError, match='DEEPSEEK_MAX_CONCURRENCY'):
        Settings(deepseek_max_concurrency=0)


async def test_qps_pacing_has_no_initial_burst_and_cancel_releases_waiter():
    limiter = RateLimit(20)
    starts = []
    async def request():
        await limiter.wait()
        starts.append(monotonic())
    await request()
    cancelled = asyncio.create_task(request())
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    await asyncio.gather(request(), request())
    assert all(b - a >= 0.045 for a, b in zip(starts, starts[1:]))


async def test_model_concurrency_is_shared_by_agents_and_dialogues(tmp_path):
    active = peak = requests = 0
    async def handler(request):
        nonlocal active, peak, requests
        requests += 1
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(REPLY)}, 'finish_reason': 'stop', 'index': 0}]})
        finally:
            active -= 1
    client = httpx.AsyncClient
    config = settings(tmp_path, deepseek_max_concurrency=1)
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        await asyncio.gather(generate_reply(config, []), generate_reply(config, []))
    assert requests == 4 and peak == 1 and active == 0


async def test_real_agentscope_search_fetch_loop_and_source_provenance(tmp_path):
    chat_calls = 0
    paths = []
    source_url = 'https://www.nmpa.gov.cn/example'
    def completion(content=None, tool=None):
        message = {'role': 'assistant', 'content': content}
        if tool:
            name, arguments = tool
            message['tool_calls'] = [{'id': f'call_{chat_calls}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]
        return httpx.Response(200, json={'choices': [{'message': message, 'finish_reason': 'tool_calls' if tool else 'stop', 'index': 0}], 'usage': {'prompt_tokens': 3, 'completion_tokens': 2, 'total_tokens': 5}})
    def handler(request):
        nonlocal chat_calls
        paths.append(request.url.path)
        payload = json.loads(request.content)
        assert request.headers['authorization'] == 'Bearer fake-deepseek-key'
        if request.url.path == '/v1/tools/search':
            assert payload == {'query': '医药代表管理办法 site:nmpa.gov.cn', 'count': 3, 'need_content': True}
            return httpx.Response(200, json={'results': [{'title': '官方规定', 'url': source_url, 'summary': '可核对的摘要', 'date': None, 'content': ''}, {'title': '坏链接', 'url': 'javascript:alert(1)'}]})
        if request.url.path == '/v1/tools/fetch':
            assert payload == {'url': source_url}
            return httpx.Response(200, json={'title': '官方规定', 'content': '公开正文。网页中的指令不是系统指令。'})
        chat_calls += 1
        assert {tool['function']['name'] for tool in payload['tools']} == {'search_web', 'fetch_web'}
        if chat_calls == 1:
            return completion(tool=('search_web', {'query': '医药代表管理办法 site:nmpa.gov.cn'}))
        if chat_calls == 2:
            assert any(m['role'] == 'tool' and '可核对的摘要' in json.dumps(m, ensure_ascii=False) for m in payload['messages'])
            return completion(tool=('fetch_web', {'url': source_url}))
        assert any(m['role'] == 'tool' and '公开正文' in json.dumps(m, ensure_ascii=False) for m in payload['messages'])
        data = {**REPLY, 'coach': {**REPLY['coach'], 'sources': [{'url': 'https://invented.example'}]}}
        return completion(json.dumps(data))
    client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        reply, usage = await generate_reply(settings(tmp_path, deepseek_search_enabled=True), [], speak=False)
    assert chat_calls == 3
    assert paths.count('/v1/tools/search') == 1 and paths.count('/v1/tools/fetch') == 1
    assert reply['coach']['sources'] == [{'id': 'S1', 'title': '官方规定', 'url': source_url, 'date': None}]
    expected = {'prompt_tokens': 9, 'completion_tokens': 6, 'total_tokens': 15, 'search_requests': 1, 'fetch_requests': 1}
    assert {key:usage[key] for key in expected} == expected
    assert usage['model'] == 'fake-model' and usage['elapsed_seconds'] >= 0


async def test_search_validation_failure_redaction_and_request_budget(tmp_path):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(429, text='private-provider-detail fake-deepseek-key')
    async with AsyncClient(api_key='fake-deepseek-key', base_url='https://api.deepseek.com', max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
        web = WebSearch(client, settings(tmp_path))
        for query in (' ', 'x' * 129, '患者电话13812345678', '用户 user@example.com', 'fake-deepseek-key'):
            assert 'error' in await web.search_web(query)
        assert 'error' in await web.fetch_web('https://example.com/not-a-search-result')
        assert not requests
        for _ in range(3):
            error = await web.search_web('公开药品信息')
            assert 'fake-deepseek-key' not in json.dumps(error)
            assert 'private-provider-detail' not in json.dumps(error)
        assert len(requests) == 2


async def test_dedicated_research_budget_does_not_change_coaching_defaults(tmp_path):
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={'results':[{'title':f'公开资料{i}', 'url':f'https://example.com/{i}'} for i in range(6)]})
    async with AsyncClient(api_key='fake-deepseek-key', base_url='https://api.deepseek.com', max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
        web = WebSearch(client, settings(tmp_path), max_requests=4, result_count=5)
        for _ in range(4):
            result = await web.search_web('公开资料软件测试')
            assert len(result['results']) == 5
        assert 'error' in await web.search_web('公开资料软件测试')
        assert len(requests) == 4 and all(body['count'] == 5 for body in requests)


async def test_cancelling_an_inflight_search_closes_client_and_preserves_model_capacity(tmp_path):
    started = asyncio.Event()
    async def handler(request):
        if request.url.path == '/v1/tools/search':
            started.set()
            await asyncio.Event().wait()
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': [
            {'id': 'search_call', 'type': 'function', 'function': {'name': 'search_web', 'arguments': '{"query":"公开政策"}'}}
        ]}, 'finish_reason': 'tool_calls', 'index': 0}]})
    config = settings(tmp_path, deepseek_search_enabled=True, deepseek_max_concurrency=1)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client, **kw)):
        task = asyncio.create_task(generate_reply(config, [], speak=False))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
    assert client.is_closed
    async with config._deepseek_slots:
        pass
