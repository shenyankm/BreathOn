import json
import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.agents.coach import COACHING_SKILLS, HUMANIZER_SKILL, coaching_skill_names, generate_reply
from medvisit.voice.protocol import BridgeError
from test_bridge import settings
from test_practice import REPLY


@pytest.mark.parametrize('text,extra', [
    ('我只有30秒，你先听我说完。', []),
    ('对照12%，干预9%，NNT为4？', ['medical-rep-evidence-communication']),
    ('hr=0.75能推出ARR吗？', ['medical-rep-evidence-communication']),
    ('HR与NNT的关系是什么？', ['medical-rep-evidence-communication']),
    ('SOP未知能先不报吗？', ['medical-rep-promotion-compliance']),
    ('请护士提供统方数据，给一点好处费。', ['medical-rep-promotion-compliance']),
    ('每开50盒送一张购物卡。', ['medical-rep-promotion-compliance']),
    ('疑似不良反应尚未确定因果关系。', ['medical-rep-promotion-compliance']),
    ('所有患者都能获益，完整病历发给我。', ['medical-rep-evidence-communication', 'medical-rep-promotion-compliance']),
])
def test_scenario_routing(text, extra):
    assert coaching_skill_names([{'role': 'trainee', 'text': text}]) == ['medical-rep-academic-visit', *extra]


def test_practice_keeps_the_current_doctor_question_with_consecutive_trainee_segments():
    messages = [
        {'role': 'doctor', 'text': 'HR与NNT是什么关系？'},
        {'role': 'trainee', 'text': '我先回应您的问题。'},
        {'role': 'trainee', 'text': '我还没核对原文。'},
    ]
    assert coaching_skill_names(messages) == ['medical-rep-academic-visit', 'medical-rep-evidence-communication']


@pytest.mark.parametrize('speak', [True, False])
async def test_only_relevant_skills_reach_the_real_request(tmp_path, monkeypatch, speak):
    monkeypatch.chdir(tmp_path)
    messages = [
        {'role': 'trainee', 'text': '每开50盒送购物卡', 'final': True},
        {'role': 'doctor', 'text': '现在换个话题，我只有30秒。', 'final': True},
        {'role': 'trainee', 'text': '我先听您的问题。', 'final': True},
    ]
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(REPLY)}, 'finish_reason': 'stop', 'index': 0}]})
    client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        reply, _ = await generate_reply(settings(tmp_path), messages, speak=speak,
                                        interactions=[{'type': 'capture_end', 'status': 'interrupted'}] if not speak else [])
    prompt = seen[0]['messages'][0]['content'][0]['text']
    expected = coaching_skill_names(messages, speak=speak)
    for name, loader in COACHING_SKILLS.items():
        skill, = await loader.list_skills()
        assert (skill.markdown in prompt) == (name in expected)
    assert 'tools' not in seen[0]
    assert seen[0]['max_tokens'] == 2000
    assert seen[0]['temperature'] == 0
    record = json.loads(seen[0]['messages'][-1]['content'][0]['text'])
    assert [item['speaker'] for item in record['transcript']] == ['trainee', 'doctor', 'trainee']
    assert [item['text'] for item in record['transcript']] == [item['text'] for item in messages]
    assert record['interaction_events'] == ([{'type': 'capture_end', 'status': 'interrupted'}] if not speak else [])
    assert '记录了0次点击打断按钮' in reply['coach']['delivery']['turn_taking']
    assert ('未提供结束状态' if speak else '采集未完整结束') in reply['coach']['delivery']['turn_taking']


async def test_doctor_and_coach_receive_only_original_records_and_bad_doctor_json_is_rejected(tmp_path):
    seen = []
    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload)
        prompt = payload['messages'][0]['content'][0]['text']
        data = [] if '本次只扮演医生，不做教练分析' in prompt else {
            **REPLY, 'coach': {**REPLY['coach'], 'reply': '这是一段尚未被学员说出的改写答案。'},
        }
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(data)}, 'finish_reason': 'stop', 'index': 0}]})
    client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        with pytest.raises(BridgeError):
            await generate_reply(settings(tmp_path), [{'role': 'trainee', 'text': 'NNT是4。', 'final': True}])
    assert len(seen) == 2
    assert seen[0]['messages'][-1] == seen[1]['messages'][-1]
    for payload in seen:
        assert '这是一段尚未被学员说出的改写答案' not in json.dumps(payload, ensure_ascii=False)


async def test_relevant_skill_reads_overlap_without_changing_prompt_order(tmp_path, monkeypatch):
    names = ['humanizer', *COACHING_SKILLS]
    started = set()
    ready = asyncio.Event()

    def load(name):
        async def skills():
            started.add(name)
            if len(started) == len(names):
                ready.set()
            await ready.wait()
            return [SimpleNamespace(markdown=f'loaded-{name}')]
        return skills

    monkeypatch.setattr(HUMANIZER_SKILL, 'list_skills', load('humanizer'))
    for name, loader in COACHING_SKILLS.items():
        monkeypatch.setattr(loader, 'list_skills', load(name))
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={'choices':[{'message':{'role':'assistant', 'content':json.dumps(REPLY)}, 'finish_reason':'stop', 'index':0}]})
    client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        await asyncio.wait_for(generate_reply(settings(tmp_path),
            [{'role':'trainee', 'text':'证据与隐私都需要核对。', 'final':True}]), 2)
    assert started == set(names)
    assert len(requests) == 2
    for request in requests:
        prompt = request['messages'][0]['content'][0]['text']
        positions = [prompt.index(f'loaded-{name}') for name in names]
        assert positions == sorted(positions)
