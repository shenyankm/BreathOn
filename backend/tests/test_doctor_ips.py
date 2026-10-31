"""Communication-style doctor IPs: fictional role models seeded next to the public-background doctors."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from conftest import LocalClient as TestClient
from medvisit.api.app import create_app
from medvisit.platform.catalog import Catalog
from medvisit.platform.departments import require_department_match
from medvisit.platform.models import Doctor
from medvisit.platform.training import prepare_free_context
from test_bridge import settings

KEYS = ['blood', 'breast', 'endocrine', 'general', 'cardio', 'oncology', 'pediatrics']


def ips(client):
    return [row for row in client.get('/api/catalog/doctor').json() if row.get('ip_profile')]


def test_seven_ip_roles_are_seeded_published_fictional_and_carry_no_real_person_claims(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        rows = ips(client)
        assert [row['ip_profile']['ip_key'] for row in sorted(rows, key=lambda r: KEYS.index(r['ip_profile']['ip_key']))] == KEYS
        for row in rows:
            assert row['status'] == 'published' and row['background_type'] == 'fictional'
            assert row['display_name'].endswith('（训练模拟）')
            assert not row['sources'] and not row['public_facts'] and not row.get('hospital')
            assert row['any_drug'] is True and row['ip_profile']['modules'] and row['ip_profile']['tags']
        # Real public-background doctors are untouched and are not marked as IPs.
        real = [r for r in client.get('/api/catalog/doctor').json() if r.get('imported_from') == 'doctor_research_agent 2026-10-31']
        assert len(real) == 12 and all(not r.get('ip_profile') and r['any_drug'] is False for r in real)


def test_seeding_twice_does_not_duplicate_or_overwrite_an_edited_ip(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        store, tenant = client.app.state.platform, client.app.state.local_user['workspace']
        first = next(r for r in ips(client) if r['ip_profile']['ip_key'] == 'blood')
        with store.transaction(tenant) as tx:
            edited = tx.update(tenant, 'doctor', first['id'], {**first, 'focus': '管理员调整'}, first['version'])
        Catalog(store).seed(tenant, 'local')
        again = ips(client)
        assert len(again) == 7 and next(r for r in again if r['id'] == first['id'])['focus'] == '管理员调整'
        assert edited['version'] == first['version'] + 1


def test_an_ip_must_be_fictional():
    profile = {'name': 'x', 'specialty': '血液科', 'background_type': 'public', 'public_facts': 'f', 'sources': ['https://example.com/a'],
               'population': 'p', 'focus': 'f', 'training_style': 's', 'opening': 'o',
               'ip_profile': {'ip_key': 'blood', 'dept': '血液科', 'style': '文献探讨型', 'area': '血液肿瘤'}}
    with pytest.raises(ValueError, match='虚构'):
        Doctor.model_validate(profile)


def test_ip_pairs_with_any_drug_but_a_real_doctor_still_needs_a_matching_department(tmp_path):
    drug = {'name': '玛仕度肽注射液'}
    require_department_match(drug, {'specialty': '儿科', 'ip_profile': {'ip_key': 'pediatrics'}})
    with pytest.raises(HTTPException) as exc:
        require_department_match(drug, {'specialty': '儿科'})
    assert exc.value.status_code == 409


def test_a_free_practice_context_can_be_built_for_a_non_matching_ip(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        store, user = client.app.state.platform, client.app.state.local_user
        pediatrics = next(r for r in ips(client) if r['ip_profile']['ip_key'] == 'pediatrics')
        drug = client.post('/api/catalog/drug', json={'name': '玛仕度肽注射液', 'brand': '信尔美', 'ownership': 'company'}).json()
        drug = client.post(f"/api/catalog/drug/{drug['id']}/publish", json={'version': drug['version']}).json()
        context = prepare_free_context(store, user, drug['id'], pediatrics['id'])
        assert context['doctor']['id'] == pediatrics['id'] and context['drug']['name'] == '玛仕度肽注射液'


def test_seed_file_matches_the_model():
    data = json.loads((Path(__file__).parents[1] / 'medvisit/platform/doctor_ips.json').read_text())
    assert [d['profile']['ip_profile']['ip_key'] for d in data['doctors']] == KEYS
    for row in data['doctors']:
        Doctor.model_validate(row['profile'])


def published_drug(client):
    drug = client.post('/api/catalog/drug', json={'name': '玛仕度肽注射液', 'brand': '信尔美', 'ownership': 'company'}).json()
    return client.post(f"/api/catalog/drug/{drug['id']}/publish", json={'version': drug['version']}).json()


def test_context_carries_the_ip_style_and_the_chosen_focus(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        store, user = client.app.state.platform, client.app.state.local_user
        blood = next(r for r in ips(client) if r['ip_profile']['ip_key'] == 'blood')
        context = prepare_free_context(store, user, published_drug(client)['id'], blood['id'], 'evidence')
        assert context['focus'] == {'key': 'evidence', 'label': '质疑证据', 'goal': context['focus']['goal']}
        assert context['doctor']['ip_profile']['style'] == '文献探讨型' and context['doctor']['ip_profile']['modules']
        plain = prepare_free_context(store, user, published_drug(client)['id'], blood['id'])
        assert 'focus' not in plain
        with pytest.raises(HTTPException) as exc:
            prepare_free_context(store, user, published_drug(client)['id'], blood['id'], 'bogus')
        assert exc.value.status_code == 422


def test_a_real_doctor_context_has_no_ip_block(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        store, user = client.app.state.platform, client.app.state.local_user
        real = client.get('/api/catalog/doctor/li-xiaoying').json()
        context = prepare_free_context(store, user, published_drug(client)['id'], real['id'], 'first')
        assert 'ip_profile' not in context['doctor'] and context['focus']['label'] == '首次拜访'


def test_the_doctor_prompt_marks_the_style_as_fictional_and_not_a_medical_fact(tmp_path):
    from medvisit.platform.training import doctor_instructions, opening
    with TestClient(create_app(settings(tmp_path))) as client:
        store, user = client.app.state.platform, client.app.state.local_user
        endocrine = next(r for r in ips(client) if r['ip_profile']['ip_key'] == 'endocrine')
        context = prepare_free_context(store, user, published_drug(client)['id'], endocrine['id'], 'next')
    prompt = doctor_instructions(free_context=context)
    assert '案例分享型' in prompt and '不代表任何真实医生' in prompt and '不作医学事实' in prompt
    assert '推进下一步' in prompt
    assert opening(free_context=context) == context['doctor']['opening']
    without_focus = {k: v for k, v in context.items() if k != 'focus'}
    assert '玛仕度肽' in opening(free_context=without_focus)
