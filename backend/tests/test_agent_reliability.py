"""Reliability of the live agents: one transient retry, coach/doctor decoupling, clipping instead of failing."""
import json
from unittest.mock import patch

import httpx2 as httpx
import pytest
from openai import AsyncClient

from medvisit.agents import reliability
from medvisit.agents.coach import generate_reply, parse_reply
from medvisit.agents.reliability import classify_error
from medvisit.voice.protocol import BridgeError
from test_bridge import settings
from test_practice import REPLY

MESSAGES = [{'id': 'd1', 'role': 'doctor', 'text': '你想先讨论哪项研究？', 'final': True},
            {'id': 'u1', 'role': 'trainee', 'text': '先看研究人群。', 'final': True}]


def is_doctor(payload):
    return '本次只扮演医生' in json.dumps(payload['messages'][0], ensure_ascii=False)


def serve(handler):
    real = httpx.AsyncClient
    return patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=real(transport=httpx.MockTransport(handler)), **kw))


def ok(body):
    return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(body)}, 'finish_reason': 'stop', 'index': 0}]})


@pytest.fixture(autouse=True)
def fast_retry(monkeypatch):
    monkeypatch.setattr(reliability, 'RETRY_DELAY', 0)
    reliability.COUNTS.clear()


async def test_one_transient_provider_error_is_retried_and_the_turn_succeeds(tmp_path):
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(is_doctor(payload))
        if len(calls) == 1:
            return httpx.Response(503, json={'error': {'message': 'busy'}})
        return ok({'doctor_reply': REPLY['doctor_reply']} if is_doctor(payload) else REPLY)
    with serve(handler):
        result, _ = await generate_reply(settings(tmp_path), MESSAGES)
    assert result['doctor_reply'] == REPLY['doctor_reply'] and len(calls) == 3
    assert reliability.snapshot()['retry.agent_call'] == 1


async def test_permanent_client_errors_are_not_retried(tmp_path):
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(401, json={'error': {'message': 'bad key'}})
    with serve(handler), pytest.raises(BridgeError):
        await generate_reply(settings(tmp_path), MESSAGES)
    assert len(calls) == 2          # coach and doctor once each, no retry
    assert reliability.snapshot()['failed.practice_turn.provider_error'] == 1


async def test_a_failed_coach_does_not_discard_the_doctors_live_reply(tmp_path):
    def handler(request):
        payload = json.loads(request.content)
        if is_doctor(payload):
            return ok({'doctor_reply': REPLY['doctor_reply']})
        return ok({'coach': {'focus': ''}})          # structurally invalid coach output
    with serve(handler):
        result, _ = await generate_reply(settings(tmp_path), MESSAGES, speak=True)
    assert result['doctor_reply'] == REPLY['doctor_reply']
    assert result['coach']['degraded'] == 'invalid_output' and '暂未完成' in result['coach']['focus']
    assert reliability.snapshot()['failed.coach_degraded.invalid_output'] == 1


async def test_a_failed_doctor_still_fails_the_live_turn(tmp_path):
    def handler(request):
        payload = json.loads(request.content)
        return ok({'doctor_reply': ''}) if is_doctor(payload) else ok(REPLY)
    with serve(handler), pytest.raises(BridgeError):
        await generate_reply(settings(tmp_path), MESSAGES, speak=True)


async def test_a_failed_coach_fails_a_review_because_there_is_nothing_to_fall_back_to(tmp_path):
    with serve(lambda request: ok({'coach': {}})), pytest.raises(BridgeError):
        await generate_reply(settings(tmp_path), MESSAGES, speak=False)
    assert reliability.snapshot()['failed.review.invalid_output'] == 1


def test_overlong_text_is_clipped_not_rejected_but_structure_errors_still_raise():
    long = json.loads(json.dumps(REPLY))
    long['coach']['analysis'] = '长' * 1500
    long['coach']['points'] = ['点' * 400]
    parsed = parse_reply(json.dumps(long))
    assert len(parsed['coach']['analysis']) == 1200 and parsed['coach']['analysis'].endswith('…')
    assert len(parsed['coach']['points'][0]) == 300
    for bad in ({**REPLY, 'coach': {**REPLY['coach'], 'points': []}},
                {**REPLY, 'coach': {**REPLY['coach'], 'points': ['a'] * 5}},
                {**REPLY, 'coach': {**REPLY['coach'], 'focus': '   '}},
                {**REPLY, 'doctor_reply': ''}):
        with pytest.raises(ValueError):
            parse_reply(json.dumps(bad))


@pytest.mark.parametrize('error,kind', [
    (TimeoutError(), 'timeout'), (ValueError('x'), 'invalid_output'), (RuntimeError('x'), 'service_error'),
])
def test_failure_kinds_are_stable(error, kind):
    assert classify_error(error) == kind


def test_agent_metrics_are_admin_only_and_report_counters(tmp_path):
    from fastapi.testclient import TestClient
    from medvisit.api.app import create_app
    from medvisit.api.auth import hash_password
    from medvisit.core.config import Settings
    origin, password = 'https://example.test', 'example secure password'
    encoded = hash_password(password)
    app = create_app(Settings(records=tmp_path, auth_required=True, login_users={'admin': encoded, 'rep': encoded}, origins=(origin,)))
    reliability.count('failed.review.timeout')
    with TestClient(app, base_url=origin, headers={'Origin': origin}) as client:
        assert client.get('/api/admin/agent-metrics').status_code == 401
        client.post('/api/auth/login', json={'username': 'rep', 'password': password})
        assert client.get('/api/admin/agent-metrics').status_code == 403
        client.post('/api/auth/logout')
        client.post('/api/auth/login', json={'username': 'admin', 'password': password})
        body = client.get('/api/admin/agent-metrics').json()
    assert body['counters']['failed.review.timeout'] == 1 and body['scope'] == 'process'
