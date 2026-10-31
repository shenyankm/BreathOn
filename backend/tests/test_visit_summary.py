from medvisit.services.visit_summary import validate_summary
from medvisit.storage.records import SessionRecord


def record():
    value=SessionRecord('synthetic','independent')
    value.data['capture_status']='completed'
    value.transcript('u1','trainee','软件测试用原话一。',final=True)
    value.transcript('u2','trainee','软件测试用原话二。',final=True)
    value.transcript('d1','doctor','这是医生的发言。',final=True)
    value.data['medical_checks']=[{'message_id':'u1','text':'软件测试用原话一。','status':'supported','statements':[{'status':'supported'}]},
        {'message_id':'u2','text':'软件测试用原话二。','status':'contradicted','statements':[{'status':'contradicted'}]}]
    return value


def model_result():
    return {'overview':'Synthetic assessment','dimensions':[
        {'key':'compliance','score':80,'weight':99,'reason':'Observed','quotes':[{'message_id':'u1','quote':'软件测试用原话一。'}]},
        {'key':'communication','score':60,'reason':'Observed','quotes':[{'message_id':'u2','quote':'软件测试用原话二。'}]}],
        'edits':[{'message_id':'d1','quote':'这是医生的发言。','category':'communication','reason':'Invalid attribution','rewrite':'Do not attribute doctor words to the trainee'}]}


def test_summary_weights_are_fixed_and_doctor_words_are_not_trainee_edits():
    summary=validate_summary(model_result(),record(),'test-model')
    assert [d['weight'] for d in summary['dimensions']]==[40,30,30]
    assert summary['dimensions'][0]['score']==50
    assert summary['total']==62
    assert summary['edits']==[]


def test_missing_medical_evidence_and_incomplete_capture_do_not_generate_full_scores():
    data=record();data.data['medical_checks'][0]['status']='insufficient'
    assert validate_summary(model_result(),data,'test')['total'] is None
    data=record();data.data['capture_status']='interrupted'
    assert validate_summary(model_result(),data,'test')['total'] is None


def test_invented_quotes_and_boolean_scores_are_not_accepted():
    raw=model_result();raw['dimensions'][0]['quotes'][0]['quote']='原话没有这个数字99%'
    raw['dimensions'][1]['score']=True
    summary=validate_summary(raw,record(),'test')
    assert all(d['score'] is None for d in summary['dimensions'][1:])
    assert summary['total'] is None


# --- build_visit_summary: the model call, its fallbacks and usage accounting -------------------------------------
import dataclasses
import json
from unittest.mock import patch

import httpx2 as httpx
import pytest
from openai import AsyncClient

from medvisit.services.visit_summary import build_visit_summary
from test_bridge import settings


def good_summary():
    return {'overview': '主要观察', 'dimensions': [
        {'key': 'compliance', 'score': 80, 'reason': '观察', 'quotes': [{'message_id': 'u1', 'quote': '软件测试用原话一。'}]},
        {'key': 'communication', 'score': 60, 'reason': '观察', 'quotes': [{'message_id': 'u2', 'quote': '软件测试用原话二。'}]}], 'edits': []}


def serve(handler):
    real = httpx.AsyncClient
    make = lambda **kw: AsyncClient(http_client=real(transport=httpx.MockTransport(handler)), **kw)
    # completion.py binds AsyncOpenAI at import time, so patch that name rather than the openai module attribute.
    return patch('medvisit.agents.completion.AsyncOpenAI', make)


def reply(content, finish='stop', usage=None):
    body = {'choices': [{'message': {'role': 'assistant', 'content': content}, 'finish_reason': finish, 'index': 0}]}
    if usage:
        body['usage'] = usage
    return httpx.Response(200, json=body)


async def test_summary_uses_the_model_and_records_usage(tmp_path):
    data = record(); data.data['usage'] = []
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        return reply(json.dumps(good_summary()), usage={'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15})
    with serve(handler):
        card = await build_visit_summary(settings(tmp_path), data)
    assert len(seen) == 1 and seen[0]['temperature'] == 0 and seen[0]['response_format'] == {'type': 'json_object'}
    assert {d['key']: d['score'] for d in card['dimensions']}['compliance'] == 80
    assert data.data['usage'] == [{'provider': 'deepseek', 'purpose': 'visit_summary', 'model': 'fake-model',
                                   'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}]


@pytest.mark.parametrize('response', [
    lambda r: httpx.Response(500, json={'error': {'message': 'down'}}),
    lambda r: reply('not json'),
    lambda r: reply(json.dumps(good_summary()), finish='length'),
])
async def test_any_model_failure_falls_back_to_an_unscored_card(tmp_path, response):
    data = record(); data.data['usage'] = []
    with serve(response):
        card = await build_visit_summary(settings(tmp_path), data)
    scores = {d['key']: d['score'] for d in card['dimensions']}
    assert scores['compliance'] is None and scores['communication'] is None and card['status'] == 'partial'


async def test_no_model_call_without_trainee_speech_or_key(tmp_path):
    calls = []
    def handler(request):
        calls.append(1); return reply('{}')
    empty = record(); empty.data['messages'] = [m for m in empty.data['messages'] if m['role'] != 'trainee']; empty.data['usage'] = []
    with serve(handler):
        await build_visit_summary(settings(tmp_path), empty)
        await build_visit_summary(dataclasses.replace(settings(tmp_path), deepseek_api_key=''), record())
    assert calls == []
