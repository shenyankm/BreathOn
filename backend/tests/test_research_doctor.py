import asyncio
from copy import deepcopy
import json
from unittest.mock import AsyncMock, patch

import pytest

from medvisit.research import archive
from medvisit.research.agents import PROFILES, validate_result
from medvisit.research.doctor import doctor_draft
from medvisit.research.models import DoctorResearchRequest, ResearchResult
from test_platform import client
from test_research_archive import page
from test_research_service import configured
from test_storage import database_url

IDENTITY = {'name':'陈明', 'hospital':'教学大学附属医院', 'department':'内分泌科'}
URL = 'https://hospital.example.edu/doctors/chen'
TEXT = '陈明，教学大学附属医院内分泌科主任医师，公开研究方向为糖代谢相关临床研究。仅为软件测试的合成资料。' * 8


def evidence(service, monkeypatch):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(TEXT), URL, {'content-type':'text/html'})))
    source, _ = asyncio.run(archive.archive_source(service.archives, URL))
    block = archive.evidence_blocks(archive.read_source(service.archives, source['id'], source['raw_sha256'])[1], source['raw_sha256'])[0]
    captured = {'queries':['陈明医院公开资料', '陈明科室公开资料'], 'search_results':[], 'archives':[source], 'errors':[],
        'evidence_seen':{source['id']:[block['id']]}}
    facts = {'姓名':'陈明', '医院':IDENTITY['hospital'], '科室':IDENTITY['department'], '专业职称':'主任医师', '专业方向':'糖代谢相关临床研究'}
    raw = {'findings':[{'title':'陈明公开专业背景', 'details':[
        {'label':label, 'value':value, 'source_id':source['id'], 'evidence_id':block['id']} for label, value in facts.items()
    ], 'caveats':['医院页面未标注更新日期。']}], 'further_checks':['正式使用前请核对当前任职。']}
    report = validate_result(ResearchResult.model_validate(raw), PROFILES['doctor'], service.archives, captured)
    return source, captured, report


def test_research_draft_requires_review_save_and_publish_before_training(client, monkeypatch):
    service = configured(client)
    source, captured, report = evidence(service, monkeypatch)
    original = client.get('/api/catalog/doctor').json()

    async def provider(_settings, kind, query, _root, job_dir, _seeds):
        assert kind == 'doctor' and query == '陈明 教学大学附属医院 内分泌科'
        archive.write_private(job_dir/'observations.json', json.dumps(captured).encode())
        return report, {'total_tokens':12}

    async def finished():
        await asyncio.gather(*list(service.tasks))

    with patch('medvisit.research.service.run_agent', side_effect=provider) as model:
        response = client.post('/api/research/doctor-jobs', json={**IDENTITY, 'name':' 陈明 '})
        assert response.status_code == 201, response.text
        client.portal.call(finished)
        job = client.get('/api/research/jobs/'+response.json()['id']).json()
        model.assert_awaited_once()
    assert job['status'] == 'completed' and job['reviewed'] is False
    assert job['doctor_identity'] == IDENTITY
    assert job['result']['further_checks'] == report['further_checks']
    assert client.get('/api/catalog/doctor').json() == original
    draft = job['doctor_draft']
    assert draft['name'] == '陈明' and draft['background_type'] == 'public'
    assert draft['sources'] == [URL] and '医院：'+IDENTITY['hospital'] in draft['public_facts']
    assert '待核对说明（不作为已确认事实）' in draft['public_facts'] and draft['mood'] == 'neutral'
    assert '医院页面未标注更新日期。' in draft['public_facts']
    assert report['further_checks'][0] in draft['public_facts']
    assert client.get(f'/api/research/sources/{source["id"]}/{source["raw_sha256"]}/html').status_code == 200

    saved = client.post('/api/catalog/doctor', json={**draft, 'training_style':'已人工调整：每轮确认一个沟通问题。'})
    assert saved.status_code == 201, saved.text
    doctor = saved.json()
    assert doctor['status'] == 'draft' and doctor['training_style'].startswith('已人工调整')
    assert doctor['research_job_id'] == job['id']
    assert client.get('/api/research/jobs/'+job['id']).json()['doctor_id'] == doctor['id']
    assert client.post('/api/catalog/doctor', json=draft).status_code == 409
    edited = client.put('/api/catalog/doctor/'+doctor['id'], json={**draft, 'version':doctor['version'], 'research_job_id':None})
    assert edited.status_code == 200 and edited.json()['research_job_id'] == job['id']
    doctor = edited.json()
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    client.post(f'/api/catalog/rubric/{rubric["id"]}/publish', json={'version':rubric['version']})
    scene = client.post('/api/catalog/scenario', json={'title':'检索医生画像演练', 'product':'教学产品', 'disease':'沟通训练',
        'objective':'核对证据边界', 'doctor_id':doctor['id'], 'rubric_id':rubric['id'], 'stages':['evidence']}).json()
    scene_path = '/api/catalog/scenario/'+scene['id']
    assert client.post(scene_path+'/publish', json={'version':scene['version']}).status_code == 409
    published = client.post(f'/api/catalog/doctor/{doctor["id"]}/publish', json={'version':doctor['version']})
    assert published.status_code == 200
    assert client.post(scene_path+'/publish', json={'version':scene['version']}).status_code == 200
    snapshot = client.get('/api/scenarios/'+scene['id']+'/preview').json()
    assert snapshot['doctor']['id'] == doctor['id'] and snapshot['doctor']['sources'] == [URL]
    assert snapshot['doctor']['training_style'] == doctor['training_style']


@pytest.mark.parametrize('field,value', [('name',''), ('hospital',' '), ('department',''), ('department','科'*51), ('hospital','联系 13812345678')])
def test_doctor_identity_validation_runs_before_search(client, field, value):
    configured(client)
    with patch('medvisit.research.service.run_agent', AsyncMock()) as model:
        response = client.post('/api/research/doctor-jobs', json={**IDENTITY, field:value})
        assert response.status_code == 422
        model.assert_not_awaited()
    assert client.app.state.research.list('research_job') == []


@pytest.mark.parametrize('change', ['other_name', 'other_hospital', 'missing_department', 'multiple_candidates', 'conflicting_field', 'missing_quote', 'unknown_version'])
def test_ambiguous_or_unbacked_identity_never_creates_a_role(client, monkeypatch, change):
    service = configured(client)
    _, captured, report = evidence(service, monkeypatch)
    finding = report['findings'][0]
    if change == 'other_name':
        finding['details'][0]['value'] = '另一位陈明'
    elif change == 'other_hospital':
        finding['details'][1]['value'] = '另一所医院'
    elif change == 'missing_department':
        finding['details'] = [detail for detail in finding['details'] if detail['label'] != '科室']
    elif change == 'multiple_candidates':
        report['findings'].append(deepcopy(finding))
    elif change == 'conflicting_field':
        finding['details'].append({**finding['details'][1], 'value':'另一所医院'})
    elif change == 'missing_quote':
        finding['details'][0].pop('quote')
    else:
        finding['details'][0]['source_version'] = 'b'*64
    with pytest.raises(ValueError):
        doctor_draft(IDENTITY, report, captured['archives'])
    job = service._create_job(DoctorResearchRequest(**IDENTITY))
    service._finish(job, report, {}, '', False, captured)
    finished = service.get_job(job['id'])
    assert 'doctor_draft' not in finished and finished['doctor_draft_error']
    assert len(client.get('/api/catalog/doctor').json()) == 1


def test_doctor_checkpoint_recovers_draft_without_searching_again(client, monkeypatch):
    service = configured(client)
    _, captured, report = evidence(service, monkeypatch)
    job = service._create_job(DoctorResearchRequest(**IDENTITY))
    archive.write_private(service.base/'jobs'/job['id']/'observations.json', json.dumps(captured).encode())
    service._save_result(job, report, {'total_tokens':12})
    with patch('medvisit.research.service.run_agent', AsyncMock()) as model:
        service.recover()
        recovered = service.get_job(job['id'])
        model.assert_not_awaited()
    assert recovered['doctor_draft']['name'] == IDENTITY['name'] and recovered['reviewed'] is False
    assert recovered['status'] == 'completed'


def test_multiple_academic_facts_and_explanatory_department_notes_are_preserved(client, monkeypatch):
    service = configured(client)
    _, captured, report = evidence(service, monkeypatch)
    details = report['findings'][0]['details']
    details[2]['value'] += '；医院官网旧公告中的科室，当前任职仍需核对。'
    details.extend([{**details[4], 'label':'公开学术背景', 'value':value} for value in ('公开经历一', '公开经历二')])
    draft = doctor_draft(IDENTITY, report, captured['archives'])
    assert draft['specialty'] == IDENTITY['department']
    assert '公开经历一' in draft['public_facts'] and '公开经历二' in draft['public_facts']
    assert '当前任职仍需核对' in draft['public_facts']


def test_partial_research_keeps_warnings_but_cancellation_never_has_a_draft(client, monkeypatch):
    service = configured(client)
    _, captured, report = evidence(service, monkeypatch)
    captured['errors'] = [{'operation':'archive', 'message':'部分来源无法访问。'}]
    job = service._create_job(DoctorResearchRequest(**IDENTITY))
    service._finish(job, report, {}, '', False, captured)
    partial = service.get_job(job['id'])
    assert partial['status'] == 'partial' and partial['doctor_draft']['name'] == IDENTITY['name']
    assert partial['source_errors'] == captured['errors'] and partial['result']['findings'][0]['caveats']
    stopped = service._create_job(DoctorResearchRequest(**IDENTITY))
    service._finish(stopped, report, {}, '', True, captured)
    assert 'doctor_draft' not in service.get_job(stopped['id'])


def test_doctor_search_uses_existing_origin_and_service_configuration_checks(client):
    assert client.post('/api/research/doctor-jobs', json=IDENTITY).status_code == 503
    configured(client)
    assert client.post('/api/research/doctor-jobs', json=IDENTITY, headers={'origin':'https://evil.test'}).status_code == 403


def test_doctor_draft_link_cannot_reference_pending_or_foreign_research(client):
    from test_platform import DOCTOR
    service = configured(client)
    pending = service._create_job(DoctorResearchRequest(**IDENTITY))
    assert client.post('/api/catalog/doctor', json={**DOCTOR, 'research_job_id':pending['id']}).status_code == 409
    with service.store.transaction('other') as tx:
        foreign = tx.create('other', 'research_job', {'kind':'doctor', 'status':'completed', 'doctor_draft':{}})
    assert client.post('/api/catalog/doctor', json={**DOCTOR, 'research_job_id':foreign['id']}).status_code == 404
    assert len(client.get('/api/catalog/doctor').json()) == 1


def test_deleting_an_unused_researched_role_preserves_the_original_draft(client, monkeypatch):
    service = configured(client)
    _, captured, report = evidence(service, monkeypatch)
    job = service._create_job(DoctorResearchRequest(**IDENTITY))
    service._finish(job, report, {}, '', False, captured)
    draft = service.get_job(job['id'])['doctor_draft']
    saved = client.post('/api/catalog/doctor', json=draft).json()
    response = client.delete(f'/api/catalog/doctor/{saved["id"]}?version={saved["version"]}')
    assert response.status_code == 200
    job = service.get_job(job['id'])
    assert job['doctor_id'] is None and job['doctor_draft'] == draft
    assert client.post('/api/catalog/doctor', json=draft).status_code == 201
