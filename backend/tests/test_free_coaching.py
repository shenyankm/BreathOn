import copy
import json
from unittest.mock import AsyncMock, patch

import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.agents.coach import generate_reply
from medvisit.services.final_review import review_training
from medvisit.storage.records import SessionRecord
from test_bridge import settings
from test_practice import REPLY


FREE_CONTEXT = {
    'drug': {'id': 'drug-a', 'version': 2, 'name': '测试药品甲', 'brand': '测试商品名'},
    'doctor': {
        'id': 'doctor-a', 'version': 3, 'name': '陈医生', 'display_name': '陈医生（训练模拟）',
        'specialty': '心内科', 'background_type': 'fictional', 'public_facts': '', 'sources': [],
        'population': '虚构训练人群', 'focus': '先确认交流目标', 'training_style': '每次追问一个问题',
        'mood': 'neutral', 'opening': '今天你想先交流哪个问题？',
    },
}


@pytest.mark.parametrize('speak', [True, False])
async def test_free_choice_reaches_doctor_and_coach_without_a_scored_assessment(tmp_path, speak):
    seen = []
    response = {**copy.deepcopy(REPLY), 'assessment': {'total': 100}}
    response['coach']['assessment'] = {'total': 100}

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={
            'choices': [{'message': {'role': 'assistant', 'content': json.dumps(response)}, 'finish_reason': 'stop', 'index': 0}],
        })

    client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        reply, _ = await generate_reply(settings(tmp_path), [
            {'role': 'doctor', 'text': '请先说明交流目标。', 'final': True},
            {'role': 'trainee', 'text': '我先确认您的问题，医学数据需要核对原文。', 'final': True},
        ], speak=speak, free_context=FREE_CONTEXT)

    assert len(seen) == (2 if speak else 1)
    assert 'assessment' not in reply['coach']
    prompts = [payload['messages'][0]['content'][0]['text'] for payload in seen]
    coach_prompt = next(prompt for prompt in prompts if '本次只扮演医生，不做教练分析' not in prompt)
    assert '不评分的自由演练' in coach_prompt and '不是已审核的医学依据' in coach_prompt
    for payload in seen:
        prompt = payload['messages'][0]['content'][0]['text']
        assert FREE_CONTEXT['doctor']['display_name'] in prompt
        assert FREE_CONTEXT['drug']['name'] in prompt
        assert '李小英' not in prompt and '玛仕度肽' not in prompt
        record = json.loads(payload['messages'][-1]['content'][0]['text'])
        assert record['free_context'] == FREE_CONTEXT and 'training' not in record
    if speak:
        assert any('本次只扮演医生，不做教练分析' in prompt for prompt in prompts)
    else:
        assert reply['doctor_reply'] == ''


async def test_final_free_review_forwards_the_saved_choice_without_enabling_training(tmp_path, monkeypatch):
    record = SessionRecord('free-session', 'assisted')
    record.data['free_context'] = copy.deepcopy(FREE_CONTEXT)
    record.data['capture_status'] = 'completed'
    record.transcript('trainee', 'trainee', '我会核对原文后回应您的问题。', final=True)
    model = AsyncMock(return_value=(copy.deepcopy(REPLY), {}))
    monkeypatch.setattr('medvisit.services.final_review.generate_reply', model)

    result = await review_training(settings(tmp_path), record)

    assert record.training is None
    assert model.await_args.kwargs['free_context'] == FREE_CONTEXT
    assert model.await_args.kwargs['training'] is None
    assert model.await_args.kwargs['speak'] is False
    assert result['final_report'] and 'assessment' not in result


async def test_reference_originals_reach_coach_only_and_keep_transcript_separate(tmp_path):
    seen=[]
    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'role':'assistant','content':json.dumps(REPLY)},'finish_reason':'stop','index':0}]})
    reference={'version':'test','evidence':[{'text':'Synthetic approved original, not a learner statement.','source':{'jurisdiction':'US'}}],'gaps':[]}
    client=httpx.AsyncClient
    with patch('openai.AsyncClient',lambda **kw:AsyncClient(http_client=client(transport=httpx.MockTransport(handler)),**kw)):
        await generate_reply(settings(tmp_path),[{'role':'trainee','text':'我需要核对原文。','final':True}],
                             free_context=FREE_CONTEXT,reference_context=reference)
    assert len(seen)==2
    for payload in seen:
        prompt=payload['messages'][0]['content'][0]['text']
        record=json.loads(payload['messages'][-1]['content'][0]['text'])
        assert record['transcript'][0]['text']=='我需要核对原文。'
        if '本次只扮演医生，不做教练分析' in prompt:
            assert 'reference_context' not in record
        else:
            assert record['reference_context']==reference
            assert '国外说明书不能证明中国批准' in prompt
            assert '没有提供任何已审核的研究原文' not in prompt
