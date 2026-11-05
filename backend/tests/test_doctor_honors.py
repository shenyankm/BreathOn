from copy import deepcopy

import pytest
from pydantic import ValidationError

from medvisit.research.agents import PROFILES, EvidenceNotReturned, validate_result
from medvisit.research.models import DoctorResearchRequest, ResearchRequest, ResearchResult
from test_platform import DOCTOR, client
import test_research_doctor
from test_research_service import configured
from test_storage import database_url

HONOR = {'name':'合成教学奖', 'organization':'测试机构', 'year':2025,
         'source_url':'https://example.org/honor', 'quote':'2025 年测试机构授予陈明合成教学奖。'}


def research_honor(service, monkeypatch):
    monkeypatch.setattr(test_research_doctor, 'TEXT', HONOR['quote'] + test_research_doctor.TEXT)
    source, captured, report = test_research_doctor.evidence(service, monkeypatch)
    for detail in report['findings'][0]['details']:
        detail.pop('quote')
        detail.pop('source_version')
    honor = {key:HONOR[key] for key in ('name', 'organization', 'year')}
    report['findings'][0]['details'].append({**report['findings'][0]['details'][0],
        'label':'荣誉与奖项', 'value':HONOR['name'], 'honor':honor})
    return source, captured, report


def test_doctor_honors_roundtrip_legacy_edits_clear_and_training_snapshot(client):
    legacy = client.post('/api/catalog/doctor', json=DOCTOR).json()
    assert legacy['honors'] == []
    saved = client.post('/api/catalog/doctor', json={**DOCTOR, 'honors':[HONOR]}).json()
    path = '/api/catalog/doctor/' + saved['id']
    assert client.get(path).json()['honors'] == [HONOR]
    edited = client.put(path, json={**DOCTOR, 'version':saved['version']}).json()
    assert edited['honors'] == [HONOR]
    published = client.post(path+'/publish', json={'version':edited['version']}).json()
    assert published['honors'] == [HONOR]
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    assert client.post(f'/api/catalog/rubric/{rubric["id"]}/publish', json={'version':rubric['version']}).status_code == 200
    scene = client.post('/api/catalog/scenario', json={'title':'荣誉快照测试', 'product':'合成产品',
        'disease':'测试', 'objective':'测试', 'doctor_id':saved['id'], 'rubric_id':rubric['id'], 'stages':['opening']}).json()
    assert client.post(f'/api/catalog/scenario/{scene["id"]}/publish', json={'version':scene['version']}).status_code == 200
    snapshot = client.get(f'/api/scenarios/{scene["id"]}/preview').json()
    assert snapshot['doctor']['honors'] == [HONOR]
    revision = client.post(path+'/revision').json()
    assert revision['honors'] == [HONOR]
    cleared = client.put('/api/catalog/doctor/'+revision['id'], json={**DOCTOR,
        'version':revision['version'], 'honors':[]})
    assert cleared.status_code == 200 and cleared.json()['honors'] == []
    assert snapshot['doctor']['honors'] == [HONOR]


@pytest.mark.parametrize('field,value', [('name',' '), ('source_url','http://127.0.0.1/private'),
    ('source_url','javascript:alert(1)'), ('quote',''), ('year',True), ('year',2025.5), ('year',999)])
def test_honor_validation_rejects_invalid_fields(client, field, value):
    response = client.post('/api/catalog/doctor', json={**DOCTOR, 'honors':[{**HONOR, field:value}]})
    assert response.status_code == 422


def test_research_honors_reach_both_draft_paths_and_trigger_review_when_edited(client, monkeypatch):
    service = configured(client)
    source, captured, raw = research_honor(service, monkeypatch)
    report = validate_result(ResearchResult.model_validate(raw), PROFILES['doctor'], service.archives, captured)
    monkeypatch.setattr(service, '_observations', lambda _: captured)
    automatic = service._create_job(DoctorResearchRequest(**test_research_doctor.IDENTITY))
    service._finish(automatic, report, {}, '', False, captured)
    draft = service.get_job(automatic['id'])['doctor_draft']
    saved = client.post('/api/catalog/doctor', json=draft).json()
    general = service._create_job(ResearchRequest(kind='doctor', query='陈明 教学大学附属医院'))
    service._finish(general, report, {}, '', False, captured)
    candidate = client.post(f'/api/research/jobs/{general["id"]}/doctor-draft', json={
        'finding_index':0, 'confirmed_identity':True, 'confirmed_name':'陈明'})
    assert candidate.status_code == 201, candidate.text
    for item in (saved, candidate.json()):
        assert len(item['honors']) == 1
        honor = item['honors'][0]
        assert all(honor[key] == HONOR[key] for key in ('name', 'organization', 'year'))
        assert honor['source_url'] == source['url'] and HONOR['quote'] in honor['quote']
        assert item['research_evidence'][-1]['source_version'] == source['raw_sha256']
    assert saved['research_evidence_review_required'] is False
    changed = client.put('/api/catalog/doctor/'+saved['id'], json={**draft, 'version':saved['version'],
        'honors':[{**saved['honors'][0], 'name':'人工修订的荣誉'}]})
    assert changed.status_code == 200 and changed.json()['research_evidence_review_required'] is True


def test_research_honor_details_require_matching_archived_words(client, monkeypatch):
    service = configured(client)
    _, captured, raw = research_honor(service, monkeypatch)
    for key, value in [('name','未出现的奖项'), ('organization','未知机构'), ('year',2024)]:
        invalid = deepcopy(raw)
        invalid['findings'][0]['details'][-1]['honor'][key] = value
        with pytest.raises(EvidenceNotReturned, match='荣誉'):
            validate_result(ResearchResult.model_validate(invalid), PROFILES['doctor'], service.archives, captured)
    raw['findings'][0]['details'][-1]['honor'].update(organization='', year=None)
    checked = validate_result(ResearchResult.model_validate(raw), PROFILES['doctor'], service.archives, captured)
    assert checked['findings'][0]['details'][-1]['honor']['organization'] == ''
    del raw['findings'][0]['details'][-1]['honor']
    with pytest.raises(ValidationError, match='荣誉'):
        ResearchResult.model_validate(raw)
