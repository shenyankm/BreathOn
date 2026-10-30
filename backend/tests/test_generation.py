import json
import threading
from unittest.mock import AsyncMock, patch

import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.platform.generation import GenerateScenario, Outline, generate_outline, generate_scenario
from test_bridge import settings
from test_platform import client, DOC
from test_storage import database_url


OUTLINE = {
    'title':'首次拜访中的证据边界', 'background':'模拟设定：医生希望先了解证据适用范围。',
    'opening':'你今天希望交流什么？', 'objections':['这份资料能支持哪些结论？'],
    'success_criteria':['先确认关注点，再说明证据范围，不扩大结论。'],
    'citations':[{'source_id':'D1', 'quote':'合成教学材料，不是医学结论。'}],
}


def setup_generation(client):
    document = client.post('/api/catalog/content', json=DOC).json()
    path = '/api/catalog/content/'+document['id']+'/review'
    for action in ('submit', 'approve'):
        document = client.post(path, json={'version':document['version'], 'action':action, 'reason':'核对软件测试材料'}).json()
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    if rubric['status'] == 'draft':
        rubric = client.post('/api/catalog/rubric/'+rubric['id']+'/publish', json={'version':rubric['version']}).json()
    return {'product':'教学产品', 'disease':'沟通训练', 'objective':'核对证据边界',
            'doctor_id':'li-xiaoying', 'rubric_id':rubric['id'], 'content_ids':[document['id']]}


def test_generated_scenario_is_editable_draft_with_verified_provenance(client):
    body = setup_generation(client)
    model = AsyncMock(return_value=(Outline(**OUTLINE), {'total_tokens':123}))
    with patch('medvisit.platform.generation.generate_outline', model):
        response = client.post('/api/scenarios/generate', json=body)
    assert response.status_code == 201, response.text
    scene = response.json()
    assert scene['status'] == 'draft' and scene['doctor_id'] == body['doctor_id']
    assert scene['objective'] == body['objective'] and scene['objections'] == OUTLINE['objections']
    assert scene['generation']['reviewed'] is False
    assert scene['generation']['usage']['total_tokens'] == 123
    assert scene['generation']['citations'][0]['document_id'] == body['content_ids'][0]
    assert scene['generation']['citations'][0]['page'] == 2
    assert client.get('/api/scenarios/'+scene['id']+'/preview').status_code == 200
    payload = model.call_args.args[1]
    assert payload['evidence'][0]['text'] == DOC['pages'][0]['text']
    assert 'scope' not in payload['evidence'][0]
    assert '首次拜访' in payload['situation_rule']
    editable = {key:scene[key] for key in body}
    editable.update({key:scene[key] for key in ('title','background','opening','objections','success_criteria','stages','duration_seconds','situation','difficulty')}, version=scene['version'])
    editable['title'] = '人工核对后的草稿'
    changed = client.put('/api/catalog/scenario/'+scene['id'], json=editable)
    assert changed.status_code == 200, changed.text
    assert client.post('/api/catalog/scenario/'+scene['id']+'/publish', json={'version':changed.json()['version']}).status_code == 200


async def test_generation_storage_work_stays_off_the_event_loop(client, tmp_path):
    body = GenerateScenario(**setup_generation(client))
    store = client.app.state.platform
    transaction = store.transaction
    event_thread = threading.get_ident()
    threads = []

    def tracked_transaction(*args, **kwargs):
        threads.append(threading.get_ident())
        return transaction(*args, **kwargs)

    with patch.object(store, 'transaction', tracked_transaction), \
         patch('medvisit.platform.generation.generate_outline', AsyncMock(return_value=(Outline(**OUTLINE), {}))):
        scene = await generate_scenario(store, settings(tmp_path), client.app.state.records,
                                        client.app.state.local_user, body)
    assert scene['status'] == 'draft'
    assert threads and all(thread != event_thread for thread in threads)


@pytest.mark.parametrize('citation', [
    {'source_id':'D99', 'quote':'合成教学材料，不是医学结论。'},
    {'source_id':'D1', 'quote':'所有患者都一定安全并获益。'},
    {'source_id':'D1', 'quote':DOC['scope']},
])
def test_generation_rejects_fabricated_quotes_without_saving(client, citation):
    body = setup_generation(client)
    with patch('medvisit.platform.generation.generate_outline', AsyncMock(return_value=(Outline(**{**OUTLINE, 'citations':[citation]}), {}))):
        response = client.post('/api/scenarios/generate', json=body)
    assert response.status_code == 502
    assert client.get('/api/catalog/scenario').json() == []


def test_generation_rechecks_bindings_after_model_call(client):
    body = setup_generation(client)
    async def change_doctor(_settings, _payload):
        user = client.app.state.local_user
        with client.app.state.platform.transaction(user['workspace']) as tx:
            doctor = tx.get(user['workspace'], 'doctor', body['doctor_id'])
            tx.update(user['workspace'], 'doctor', doctor['id'], {**doctor, 'mood':'busy'}, doctor['version'])
        return Outline(**OUTLINE), {}
    with patch('medvisit.platform.generation.generate_outline', change_doctor):
        response = client.post('/api/scenarios/generate', json=body)
    assert response.status_code == 409
    assert client.get('/api/catalog/scenario').json() == []


def test_unreviewed_retired_and_foreign_sources_never_reach_model(client):
    body = setup_generation(client)
    draft = client.post('/api/catalog/content', json=DOC).json()
    with patch('medvisit.platform.generation.generate_outline', AsyncMock()) as model:
        assert client.post('/api/scenarios/generate', json={**body, 'content_ids':[draft['id']]}).status_code == 409
        user = client.app.state.local_user
        with client.app.state.platform.transaction('other') as tx:
            foreign = tx.create('other', 'content', {**DOC, 'status':'approved'})
        assert client.post('/api/scenarios/generate', json={**body, 'content_ids':[foreign['id']]}).status_code == 404
        current = client.get('/api/catalog/content/'+body['content_ids'][0]).json()
        client.post('/api/catalog/content/'+current['id']+'/review', json={'version':current['version'], 'action':'retire', 'reason':'软件测试停用'})
        assert client.post('/api/scenarios/generate', json=body).status_code == 409
        assert client.post('/api/scenarios/generate', json={**body, 'content_ids':[]}).status_code == 422
        assert client.post('/api/scenarios/generate', json={**body, 'content_ids':[draft['id'],draft['id']]}).status_code == 422
        model.assert_not_awaited()


@pytest.mark.parametrize('invalid', [False, True])
async def test_outline_uses_agentscope_and_rejects_untrusted_output(tmp_path, invalid):
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        content = {**OUTLINE, 'status':'published'} if invalid else OUTLINE
        return httpx.Response(200, json={'choices':[{'message':{'role':'assistant', 'content':json.dumps(content)}, 'finish_reason':'stop', 'index':0}]})
    real_client = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kwargs: AsyncClient(http_client=real_client(transport=httpx.MockTransport(handler)), **kwargs)):
        if invalid:
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as failure:
                await generate_outline(settings(tmp_path), {'evidence':[]})
            assert failure.value.status_code == 502
        else:
            result, _ = await generate_outline(settings(tmp_path), {'evidence':[]})
            assert result.title == OUTLINE['title']
    assert len(seen) == 1 and seen[0]['response_format'] == {'type':'json_object'}


@pytest.mark.parametrize('situation', ['first_visit','follow_up','time_pressure','evidence_challenge'])
def test_situation_and_difficulty_are_preserved(client, situation):
    body = setup_generation(client)
    with patch('medvisit.platform.generation.generate_outline', AsyncMock(return_value=(Outline(**OUTLINE), {}))) as model:
        scene = client.post('/api/scenarios/generate', json={**body, 'situation':situation, 'difficulty':'advanced'}).json()
    assert scene['situation'] == situation and scene['difficulty'] == 'advanced'
    assert '进阶难度' in model.call_args.args[1]['difficulty_rule']
