import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings
from medvisit.platform.management import service_enabled
from medvisit.services.final_review import review_training
from medvisit.storage.records import SessionRecord
from test_storage import database_url
from conftest import clear_test_database

PASSWORD = 'a sufficiently long test password'
ORIGIN = 'https://example.test'


@pytest.fixture(params=['sqlite', 'postgres'])
def client(tmp_path, request):
    password = hash_password(PASSWORD)
    url = request.getfixturevalue('database_url') if request.param == 'postgres' else ''
    if url:
        clear_test_database(url)
    config = Settings(records=tmp_path, database_url=url, auth_required=True, origins=(ORIGIN,),
                      login_users={name:password for name in ('admin','medical','compliance','rep','other')},
                      admin_users=['admin','medical','compliance'])
    with TestClient(create_app(config), base_url=ORIGIN, headers={'Origin':ORIGIN}) as client:
        login(client, 'admin')
        yield client


def login(client, name):
    client.post('/api/auth/logout')
    assert client.post('/api/auth/login', json={'username':name,'password':PASSWORD}).status_code == 200


def configure(client, **changes):
    config = client.get('/api/admin/settings').json()
    body = {k:config[k] for k in ('version','doctor_recommendation','training_scoring','health_sharing','review_rules','medical_reviewers','compliance_reviewers')}
    body.update(changes)
    response = client.put('/api/admin/settings', json=body)
    assert response.status_code == 200, response.text
    return response.json()


def vote(client, kind, item, role='admin', decision='approve'):
    state = client.get(f"/api/admin/catalog/{kind}/{item['id']}/approval").json()
    return client.post(f"/api/admin/catalog/{kind}/{item['id']}/approval", json={'version':item['version'],'settings_version':state['settings_version'],'role':role,'reason':'已核对本版本','decision':decision})


def test_settings_persist_validate_and_enforce_recommendations_and_scoring(client):
    before = client.get('/api/admin/settings').json()
    config = configure(client, doctor_recommendation=False, training_scoring=False)
    assert client.put('/api/admin/settings', json={k:v for k,v in before.items() if k!='administrators'}).status_code == 409
    assert client.get('/api/me/settings').json()['doctor_recommendation'] is False
    tenant = client.app.state.local_user['workspace']
    record = SessionRecord(str(uuid4()), 'assisted')
    record.scoring_enabled = lambda: service_enabled(client.app.state.platform, tenant, 'training_scoring')
    with patch('medvisit.services.final_review.generate_reply', new_callable=AsyncMock) as model:
        assert asyncio.run(review_training(None, record)) is None
        model.assert_not_called()
    assert record.data['analysis_status'] == 'disabled'
    config.pop('administrators'); config['medical_reviewers'] = ['rep']
    assert client.put('/api/admin/settings', json={k:v for k,v in config.items() if k not in ('id','created_at','updated_at')}).status_code == 422
    login(client, 'rep')
    assert client.get('/api/admin/settings').status_code == 403
    assert client.put('/api/admin/settings', json={'version':0}).status_code == 403
    assert client.get('/api/me/settings').json()['doctor_recommendation'] is False


def test_two_person_gate_rejects_duplicate_stale_votes_and_keeps_history(client):
    configure(client, review_rules={'drug':'two_admins'})
    drug = client.post('/api/catalog/drug', json={'name':'测试药品','ownership':'company'}).json()
    path = '/api/catalog/drug/' + drug['id']
    assert client.post(path+'/publish', json={'version':drug['version']}).status_code == 409
    assert vote(client, 'drug', drug).status_code == 200
    assert vote(client, 'drug', drug).json()['ready'] is False
    login(client, 'medical')
    assert vote(client, 'drug', drug).json()['ready'] is True
    updated = client.put(path, json={'name':'修改后药品','ownership':'company','version':drug['version']}).json()
    assert client.post(path+'/publish', json={'version':updated['version']}).status_code == 409
    assert vote(client, 'drug', updated).json()['ready'] is False
    login(client, 'admin')
    assert vote(client, 'drug', updated).json()['ready'] is True
    published = client.post(path+'/publish', json={'version':updated['version']}).json()
    assert published['status'] == 'published'
    draft = client.post(path+'/revision').json()
    vote(client, 'drug', draft)
    login(client, 'medical'); vote(client, 'drug', draft)
    assert client.post('/api/catalog/drug/'+draft['id']+'/publish', json={'version':draft['version']}).status_code == 200
    history = client.get('/api/admin/catalog/drug/'+drug['id']+'/history').json()
    assert any(row.get('source_version') == published['version'] for row in history)


def test_medical_compliance_gate_uses_assigned_different_people_and_rejects_bypass(client):
    configure(client, review_rules={'content':'medical_compliance'}, medical_reviewers=['medical'], compliance_reviewers=['compliance'])
    body={'title':'证据','version_label':'1','scope':'训练','pages':[{'number':1,'text':'用于测试的原文'}]}
    content=client.post('/api/catalog/content',json=body).json()
    path='/api/catalog/content/'+content['id']
    item=client.post(path+'/review',json={'version':content['version'],'action':'submit','reason':'送审'}).json()
    assert vote(client,'content',item,'medical').status_code == 403
    login(client,'medical'); assert vote(client,'content',item,'medical').json()['ready'] is False
    assert client.post(path+'/review',json={'version':item['version'],'action':'approve','reason':'确认'}).status_code == 409
    login(client,'compliance'); assert vote(client,'content',item,'compliance','reject').json()['ready'] is False
    assert client.post(path+'/review',json={'version':item['version'],'action':'approve','reason':'确认'}).status_code == 409
    assert vote(client,'content',item,'compliance').json()['ready'] is True
    assert client.post(path+'/review',json={'version':item['version'],'action':'approve','reason':'确认'}).json()['status']=='approved'


def test_lessons_publish_to_real_curriculum_and_revisions_preserve_progress(client):
    body={'title':'新课程','level':'L2','summary':'课程摘要','owner':'医学组','sections':[['来源','已核对的教学内容']],'unverified_figures':False}
    item=client.post('/api/catalog/lesson',json=body).json(); path='/api/catalog/lesson/'+item['id']
    lessons=lambda: [l for level in client.get('/api/curriculum').json()['levels'] for l in level['lessons']]
    assert not any(l['id']==item['id'] for l in lessons())
    published=client.post(path+'/publish',json={'version':item['version']}).json()
    assert any(l['id']==item['id'] and l['title']=='新课程' for l in lessons())
    assert client.put('/api/curriculum/lessons/'+item['id'],json={'state':'completed'}).status_code==200
    draft=client.post(path+'/revision').json()
    changed=client.put('/api/catalog/lesson/'+draft['id'],json={**body,'title':'修订课程','version':draft['version']}).json()
    assert client.post('/api/catalog/lesson/'+draft['id']+'/publish',json={'version':changed['version']}).status_code==200
    actual=next(l for l in lessons() if l['id']==item['id'])
    assert actual['title']=='修订课程' and actual['state']=='completed'
    assert published['id']==item['id']
    login(client,'rep')
    assert client.post('/api/catalog/lesson',json=body).status_code==403
    assert client.get('/api/admin/versions').status_code==403


def test_health_consent_review_revoke_and_global_gate(client):
    configure(client, health_sharing=True)
    login(client,'rep')
    body={'metric':'观察指标','value':1.2,'unit':'ppm','observed_at':datetime.now(timezone.utc).isoformat(),'conditions':'测试环境','limitations':'手工录入，未进行设备校准'}
    item=client.post('/api/health/observations',json=body).json(); path='/api/health/observations/'+item['id']
    assert client.get('/api/health/shared').json()['items']==[]
    assert client.post(path+'/consent',json={'version':item['version'],'consent':False}).status_code==422
    login(client,'other')
    assert client.get('/api/health/observations').json()==[]
    assert client.post(path+'/consent',json={'version':item['version'],'consent':True}).status_code==404
    login(client,'rep')
    shared=client.post(path+'/consent',json={'version':item['version'],'consent':True}).json()
    assert client.get('/api/health/shared').json()['items']==[]
    assert client.post('/api/admin/health/observations/'+item['id']+'/review',json={'version':shared['version'],'decision':'approve','reason':'核对'}).status_code==403
    login(client,'admin')
    assert len(client.get('/api/admin/health/observations').json())==1
    approved=client.post('/api/admin/health/observations/'+item['id']+'/review',json={'version':shared['version'],'decision':'approve','reason':'核对'}).json()
    feed=client.get('/api/health/shared').json()['items']
    assert len(feed)==1 and 'owner_id' not in feed[0]
    configure(client,health_sharing=False)
    assert client.get('/api/health/shared').json()['items']==[]
    configure(client,health_sharing=True)
    login(client,'rep')
    assert client.post(path+'/revoke',json={'version':shared['version']}).status_code==200
    assert client.get('/api/health/shared').json()['items']==[]
    login(client,'admin')
    assert client.get('/api/admin/health/observations').json()==[]
    assert client.post('/api/admin/health/observations/'+item['id']+'/review',json={'version':shared['version'],'decision':'approve','reason':'迟到审核'}).status_code==409


def test_health_private_record_not_visible_to_admin_and_self_review_rejected(client):
    configure(client,health_sharing=True)
    body={'metric':'测试','value':2,'unit':'单位','observed_at':datetime.now(timezone.utc).isoformat(),'conditions':'条件','limitations':'局限'}
    private=client.post('/api/health/observations',json=body).json()
    assert client.get('/api/admin/health/observations').json()==[]
    item=client.post('/api/health/observations/'+private['id']+'/consent',json={'version':private['version'],'consent':True}).json()
    assert client.post('/api/admin/health/observations/'+item['id']+'/review',json={'version':item['version'],'decision':'approve','reason':'核对'}).status_code==403
    with client.app.state.platform.transaction('other') as tx:
        tx.create('other','health_observation',{**body,'owner_id':'rep','consent':True,'status':'approved'})
    assert client.get('/api/health/shared').json()['items']==[]
    login(client,'rep')
    assert client.get('/api/health/observations').json()==[]


def test_disabled_scoring_excludes_score_schema_without_removing_training_context():
    from medvisit.agents.coach import build_coach_prompt
    prompt, schema = build_coach_prompt([], speak=True, training={'rubric':{'dimensions':[{'key':'accuracy'}]}},
        medical_checks=[], free_context=None, reference_context=None, interactions=[], history=[], visible=[], selected=[],
        remaining=100, search_enabled=False, scoring_enabled=False)
    assert 'assessment' not in schema
    assert '训练评分已关闭' in prompt
