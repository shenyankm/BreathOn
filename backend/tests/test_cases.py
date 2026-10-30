from unittest.mock import AsyncMock, patch

import pytest

from medvisit.platform.generation import Outline
from test_generation import OUTLINE, setup_generation
from test_operations import platform, save_record
from test_storage import database_url


def extract(client, record):
    response = client.post('/api/sessions/'+record.data['id']+'/cases', json={'message_id':'u1'})
    assert response.status_code == 201, response.text
    return response.json()


def test_case_extract_edit_confirm_and_portable_roundtrip(platform):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会先核对研究人群和适用范围，再安排反馈。')
    record.data['coaching'][0].update(analysis='原话提出了核对范围和跟进动作。', reply='我会核对原文，并在您方便的时间通过授权渠道反馈。')
    record.data['coaching'][0]['assessment']['dimensions'] = [
        {'key':'closing','score':3,'reason':'原话提出核对范围与跟进动作。','utterances':[{'message_id':'u1'}]},
        {'key':'accuracy','score':1,'reason':'另一处医学回答需要核实。','utterances':[{'message_id':'other'}]}]
    service.records.save(record, 'completed')
    case = extract(client, record)
    assert case['status'] == 'draft' and case['origin_verified']
    assert case['quotes'][-1]['text'] == record.data['messages'][-1]['text']
    assert case['approach'] == record.data['messages'][-1]['text']
    assert case['rationale'] == '原话提出核对范围与跟进动作。'
    path = '/api/cases/'+case['id']
    body = {key:case[key] for key in ('title','situation','approach','rationale','limitations')}
    edited = client.put(path, json={**body, 'title':'确认关注点后再约定跟进', 'version':case['version']}).json()
    assert client.post(path+'/confirm', json={'version':case['version']}).status_code == 409
    confirmed = client.post(path+'/confirm', json={'version':edited['version']}).json()
    assert confirmed['status'] == 'confirmed'
    changed = client.put(path, json={**body, 'version':confirmed['version']}).json()
    assert changed['status'] == 'draft'
    response = client.get(path+'/export')
    assert response.headers['content-disposition'].startswith('attachment;')
    package = response.json()
    assert package['schema_version'] == 1 and 'status' not in package['case']
    assert 'origin_record_id' not in package['case']
    imported = client.post('/api/cases/import', json=package).json()
    assert imported['status'] == 'draft' and not imported['origin_verified']
    assert imported['quotes'] == case['quotes'] and imported['id'] != case['id']
    assert client.post('/api/cases/import', json=package).json()['id'] == imported['id']
    markdown = client.get(path+'/export?format=markdown')
    assert '回应方式' in markdown.text and case['quotes'][-1]['text'] in markdown.text
    assert markdown.headers['x-content-type-options'] == 'nosniff'


def test_only_reviewed_cases_can_guide_generation_without_becoming_medical_evidence(platform):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会先核对原文中的研究人群，再说明适用范围。')
    case = extract(client, record)
    body = setup_generation(client)
    with patch('medvisit.platform.generation.generate_outline', AsyncMock(return_value=(Outline(**OUTLINE), {}))) as model:
        assert client.post('/api/scenarios/generate', json={**body, 'case_id':case['id']}).status_code == 409
        model.assert_not_awaited()
        confirmed = client.post('/api/cases/'+case['id']+'/confirm', json={'version':case['version']}).json()
        response = client.post('/api/scenarios/generate', json={**body, 'case_id':case['id']})
        assert response.status_code == 201, response.text
        assert response.json()['generation']['case']['version'] == confirmed['version']
        reference = model.call_args.args[1]['case_reference']
        assert reference['is_medical_evidence'] is False
        assert 'sources' not in reference


@pytest.mark.parametrize('kind', ['doctor', 'missing', 'partial', 'empty'])
def test_case_requires_captured_final_trainee_text(platform, kind):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会核对后按约定时间反馈。')
    message_id = 'd1' if kind == 'doctor' else 'unknown' if kind == 'missing' else 'u1'
    if kind == 'partial':
        record.data['messages'][-1]['final'] = False
        service.records.save(record, 'interrupted')
    elif kind == 'empty':
        record.data['messages'][-1]['text'] = '   '
        service.records.save(record, 'completed')
    assert client.post('/api/sessions/'+record.data['id']+'/cases', json={'message_id':message_id}).status_code == 422
    assert client.get('/api/cases').json() == []


def test_external_case_cannot_supply_trusted_status_local_ids_or_unsafe_links(platform):
    client, service, _, scene = platform
    case = extract(client, save_record(client, service, scene, '我会先核实原文，再通过授权渠道跟进。'))
    package = client.get('/api/cases/'+case['id']+'/export').json()
    for extra in ({'status':'confirmed'}, {'documents':[{'id':'foreign'}]}, {'origin_verified':True}):
        assert client.post('/api/cases/import', json={**package, 'case':{**package['case'], **extra}}).status_code == 422
    source = {'title':'外来材料', 'version_label':'v1', 'page':1, 'quote':'仅为软件测试的合成引文', 'source_url':'javascript:alert(1)'}
    assert client.post('/api/cases/import', json={**package, 'case':{**package['case'], 'sources':[source]}}).status_code == 422
    assert len(client.get('/api/cases').json()) == 1


def test_changed_case_during_generation_is_not_used(platform):
    client, service, _, scene = platform
    case = extract(client, save_record(client, service, scene, '我会核对原文并向您确认跟进时间。'))
    case = client.post('/api/cases/'+case['id']+'/confirm', json={'version':case['version']}).json()
    body = setup_generation(client)
    async def modify(_settings, _payload):
        user = client.app.state.local_user
        with service.store.transaction(user['workspace']) as tx:
            tx.update(user['workspace'], 'case', case['id'], {**case, 'status':'draft'}, case['version'])
        return Outline(**OUTLINE), {}
    with patch('medvisit.platform.generation.generate_outline', modify):
        response = client.post('/api/scenarios/generate', json={**body, 'case_id':case['id']})
    assert response.status_code == 409
    assert len(client.get('/api/catalog/scenario').json()) == 1


@pytest.mark.parametrize('action', ['confirm', 'reuse'])
@pytest.mark.parametrize('change', ['retired', 'expired', 'modified'])
def test_case_source_must_still_match_the_effective_training_version(platform, action, change):
    client, service, _, scene = platform
    bindings = setup_generation(client)
    user = client.app.state.local_user
    with service.store.transaction(user['workspace']) as tx:
        scene = tx.update(user['workspace'], 'scenario', scene['id'],
            {**scene, 'content_ids':bindings['content_ids']}, scene['version'])
    case = extract(client, save_record(client, service, scene, '我会先核对原文范围，再与您约定反馈。'))
    path = '/api/cases/'+case['id']
    if action == 'reuse':
        case = client.post(path+'/confirm', json={'version':case['version']}).json()
    with service.store.transaction(user['workspace']) as tx:
        document = tx.get(user['workspace'], 'content', case['documents'][0]['id'])
        changed = {**document}
        if change == 'retired':changed['status'] = 'retired'
        elif change == 'expired':changed['expires_at'] = '2000-01-01T00:00:00+00:00'
        else:changed['pages'] = [{'number':1, 'text':'已修改的合成材料，不是医学结论。'}]
        tx.update(user['workspace'], 'content', document['id'], changed, document['version'])
    if action == 'confirm':
        assert client.post(path+'/confirm', json={'version':case['version']}).status_code == 409
    else:
        body = setup_generation(client)
        with patch('medvisit.platform.generation.generate_outline', AsyncMock()) as model:
            assert client.post('/api/scenarios/generate', json={**body, 'case_id':case['id']}).status_code == 409
            model.assert_not_awaited()
