"""Matching concerns training departments, not a physician's prescribing authority."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from conftest import LocalClient
from medvisit.api.app import create_app
from medvisit.platform.departments import department, drug_departments, require_department_match
from medvisit.platform.models import Drug
from medvisit.platform.training import check_free_context, prepare_free_context
from test_bridge import settings, ORIGIN
from test_free_practice import selection


@pytest.mark.parametrize('specialty,expected', [
    ('内分泌科', '内分泌科'), ('心血管代谢中心', '心血管科'), ('心内科', '心血管科'),
    ('肺内一科', '呼吸科'), ('消化肿瘤内科', '肿瘤科'), ('淋巴肿瘤内科', '血液科'),
    ('北京大学血液病研究所（血液科）', '血液科'), ('白血病诊疗中心', '血液科'),
    ('  教学专科  ', '教学专科'),
])
def test_department_aliases(specialty, expected):
    assert department(specialty) == expected


def test_defaults_cover_catalog_and_explicit_empty_is_not_overridden():
    seed = json.loads((Path(__file__).parents[1] / 'medvisit/platform/catalog_seed.json').read_text())
    assert all(drug_departments(row) for row in seed['drugs'])
    assert drug_departments({'name': '未知药'}) == []
    assert drug_departments({'name': '玛仕度肽注射液', 'practice_departments': []}) == []
    assert Drug(name='玛仕度肽注射液').practice_departments == ['内分泌科']
    assert Drug(name='测试药', practice_departments=['心内科', '心血管科']).practice_departments == ['心血管科']
    with pytest.raises(ValueError):
        Drug(name='测试药', practice_departments=[' '])


def test_many_to_many_matches_and_endocrinology_rejects_oncology_drug():
    for specialty in ['内分泌科', '内分泌代谢科']:
        for name in ['玛仕度肽注射液', '托莱西单抗注射液']:
            require_department_match({'name': name}, {'specialty': specialty})
    for specialty in ['肿瘤医学部', '消化肿瘤内科', '肺内一科', '淋巴肿瘤内科']:
        require_department_match({'name': '信迪利单抗注射液'}, {'specialty': specialty})
    with pytest.raises(HTTPException):
        require_department_match({'name': '信迪利单抗注射液'}, {'specialty': '内分泌科'})


def test_preview_websocket_and_running_session_recheck_department(tmp_path):
    with LocalClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        store, user = client.app.state.platform, client.app.state.local_user
        free = prepare_free_context(store, user, drug['id'], doctor['id'])
        with store.transaction(user['workspace']) as tx:
            tx.update(user['workspace'], 'doctor', doctor['id'], {**doctor, 'specialty': '不匹配科室'}, doctor['version'])
        query = f"drug_id={drug['id']}&doctor_id={doctor['id']}"
        response = client.get('/api/practice/preview?' + query)
        assert response.status_code == 409 and '科室不匹配' in response.text
        with patch('medvisit.api.app.connect') as provider:
            with client.websocket_connect('/api/realtime?' + query, headers=ORIGIN) as ws:
                assert ws.receive_json()['type'] == 'error'
            provider.assert_not_called()
        with pytest.raises(HTTPException):
            check_free_context(store, user['workspace'], free)
        assert not client.get('/api/sessions').json()


def test_catalog_exposes_same_matching_metadata_on_create_and_read(tmp_path):
    with LocalClient(create_app(settings(tmp_path))) as client:
        drug = client.post('/api/catalog/drug', json={'name': '玛仕度肽注射液'}).json()
        assert drug['practice_departments'] == ['内分泌科']
        assert client.get('/api/catalog/drug/' + drug['id']).json()['practice_departments'] == ['内分泌科']
        assert next(row for row in client.get('/api/catalog/drug').json() if row['id'] == drug['id'])['practice_departments'] == ['内分泌科']
        doctor = client.get('/api/catalog/doctor/li-xiaoying').json()
        assert doctor['practice_department'] == '内分泌科'


def test_scenario_creation_and_preview_cannot_bypass_department_matching(tmp_path):
    with LocalClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
        assert client.post('/api/catalog/rubric/academic-visit-v1/publish', json={'version': rubric['version']}).status_code == 200
        body = {'title': '科室匹配测试', 'product': drug['name'], 'drug_id': drug['id'],
                'doctor_id': doctor['id'], 'rubric_id': rubric['id'], 'disease': '合成疾病',
                'objective': '验证科室筛选', 'stages': ['opening']}
        scene = client.post('/api/catalog/scenario', json=body).json()
        assert 'id' in scene, scene
        assert client.post(f"/api/catalog/scenario/{scene['id']}/publish", json={'version': scene['version']}).status_code == 200
        with client.app.state.platform.transaction(client.app.state.local_user['workspace']) as tx:
            tx.update(client.app.state.local_user['workspace'], 'doctor', doctor['id'], {**doctor, 'specialty': '不匹配科室'}, doctor['version'])
        assert client.post('/api/catalog/scenario', json=body).status_code == 409
        assert client.get(f"/api/scenarios/{scene['id']}/preview").status_code == 409
