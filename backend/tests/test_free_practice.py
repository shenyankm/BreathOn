import asyncio
import json
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

import pytest
from fastapi import HTTPException

from conftest import LocalClient as TestClient
from medvisit.api.app import create_app
from medvisit.platform.training import check_free_context, prepare_free_context
from medvisit.services.practice import PracticeDialogue
from medvisit.services.visit_summary import validate_summary
from medvisit.storage.records import SessionRecord
from medvisit.voice.protocol import BridgeError
from test_bridge import AUDIO, ORIGIN, Provider, receive_until, settings
from test_practice import REPLY


def selection(client):
    doctor = client.post('/api/catalog/doctor', json={'name':'测试陈医生', 'specialty':'虚构教学专科',
        'population':'虚构练习人群', 'focus':'沟通与资料边界', 'training_style':'一次追问一个问题',
        'opening':'这是旧主题的开场，不应替代新选主题。'}).json()
    doctor = client.post(f"/api/catalog/doctor/{doctor['id']}/publish", json={'version':doctor['version']}).json()
    drug = client.post('/api/catalog/drug', json={'name':'虚构训练药品乙', 'brand':'教学乙', 'ownership':'company',
        'practice_departments':['虚构教学专科'], 'overview':'这段未经审核的概述不能作为药品医学证据。'}).json()
    drug = client.post(f"/api/catalog/drug/{drug['id']}/publish", json={'version':drug['version']}).json()
    assert doctor['status'] == drug['status'] == 'published'
    return drug, doctor


def test_free_preview_only_published_workspace_items_and_identity(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        params = {'drug_id':drug['id'], 'doctor_id':doctor['id']}
        response = client.get('/api/practice/preview', params=params)
        assert response.status_code == 200
        free = response.json()
        assert free['drug'] == {key:drug[key] for key in ('id','version','name','brand')}
        assert free['doctor']['id'] == doctor['id'] and 'training' not in free
        assert '未经审核的概述' not in json.dumps(free, ensure_ascii=False)
        draft = client.post('/api/catalog/drug', json={'name':'未发布药品'}).json()
        assert client.get('/api/practice/preview', params={**params, 'drug_id':draft['id']}).status_code == 409
        draft_doctor = client.post(f"/api/catalog/doctor/{doctor['id']}/revision").json()
        assert client.get('/api/practice/preview', params={**params, 'doctor_id':draft_doctor['id']}).status_code == 409
        with client.app.state.platform.transaction('other') as tx:
            foreign_drug = tx.create('other', 'drug', {**drug, 'id':'foreign-drug'}, item_id='foreign-drug')
            tx.create('other', 'doctor', {**doctor, 'id':'foreign-doctor'}, item_id='foreign-doctor')
        assert foreign_drug['status'] == 'published'
        for key in params:
            assert client.get('/api/practice/preview', params={**params, key:'foreign-'+('drug' if key=='drug_id' else 'doctor')}).status_code == 404
        for invalid in ({'drug_id':drug['id']}, {**params,'doctor_id':''}, {**params,'drug_id':'x'*81}):
            assert client.get('/api/practice/preview', params=invalid).status_code == 422
        with pytest.raises(HTTPException) as exc:
            prepare_free_context(client.app.state.platform, client.app.state.local_user, drug['id'], ' ')
        assert exc.value.status_code == 422


@pytest.mark.parametrize('extra', ['scenario_id=existing', 'remediation_id=existing'])
def test_fixed_training_cannot_override_selected_role_or_drug(tmp_path, extra):
    with TestClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        query = urlencode({'drug_id':drug['id'], 'doctor_id':doctor['id']})
        with client.websocket_connect('/api/realtime?'+query+'&'+extra, headers=ORIGIN) as ws:
            assert ws.receive_json()['code'] == 'invalid_practice'
        assert not client.get('/api/sessions').json()


@pytest.mark.parametrize('experience', ['practice', 'combat'])
def test_free_context_reaches_ready_voice_and_saved_unscored_record(tmp_path, experience):
    provider = Provider()
    async def connect(*args, **kwargs):
        return provider
    review = AsyncMock(return_value=(REPLY, {}))
    with patch('medvisit.api.app.connect', connect), \
            patch('medvisit.voice.asr.connect', lambda *args, **kwargs: Provider(asr=True)), \
            patch('medvisit.services.final_review.generate_reply', review), \
            TestClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        query = urlencode({'experience':experience, 'drug_id':drug['id'], 'doctor_id':doctor['id']})
        with client.websocket_connect('/api/realtime?'+query, headers=ORIGIN) as ws:
            ws.send_json({'type':'start', 'mode':'independent'})
            ready = receive_until(ws, 'ready')
            assert ready['training'] is None
            assert ready['free_context']['drug']['id'] == drug['id']
            assert ready['doctor']['id'] == doctor['id']
            checkpoint = json.loads((tmp_path/'checkpoints'/f"{ready['session_id']}.json").read_text())
            assert checkpoint['free_context'] == ready['free_context']
            if experience == 'practice':
                opening = receive_until(ws, 'transcript')['text']
                assert drug['name'] in opening and doctor['display_name'] in opening
            ws.send_json({'type':'audio', 'audio':AUDIO})
            ws.send_json({'type':'stop'})
            assert receive_until(ws, 'ended')['saved']
        record = client.get('/api/sessions/'+ready['session_id']).json()
        assert record.get('training') is None
        assert record['free_context'] == ready['free_context']
        assert record['doctor']['id'] == doctor['id']
        assert not any(coach.get('assessment') for coach in record['coaching'])
        assert record['summary_card']['total'] is None
        assert all(row['score'] is None for row in record['summary_card']['dimensions'])
        assert review.await_count == 1
        assert review.call_args.kwargs['training'] is None
        assert review.call_args.kwargs['free_context'] == record['free_context']
    if experience == 'combat':
        events = [json.loads(raw) for raw in provider.sent]
        instructions = events[0]['session']['instructions']
        assert doctor['display_name'] in instructions and drug['name'] in instructions
        assert '未经审核的概述' not in instructions
        assert drug['name'] in next(event['text'] for event in events if event['type']=='speech_text_buffer.commit')


def test_retired_selected_drug_stops_before_next_reply(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        drug, doctor = selection(client)
        store, user = client.app.state.platform, client.app.state.local_user
        free = prepare_free_context(store, user, drug['id'], doctor['id'])
        check_free_context(store, user['workspace'], free)
        assert client.post(f"/api/catalog/drug/{drug['id']}/retire", json={'version':drug['version']}).status_code == 200
        with pytest.raises(HTTPException) as exc:
            check_free_context(store, user['workspace'], free)
        assert exc.value.status_code == 409
        record = SessionRecord('free', 'independent')
        record.data['free_context'] = free
        record.validate_training = lambda: check_free_context(store, user['workspace'], free)
        dialogue = PracticeDialogue(AsyncMock(), settings(tmp_path), record)
        with pytest.raises(BridgeError) as exc:
            asyncio.run(dialogue.observe({'utterances':[{'start_time':0, 'text':'需要核对原文。', 'definite':True}]}, False))
        assert exc.value.code == 'training_material_changed'
        assert not record.data['coaching']


def test_free_summary_discards_model_scores_but_keeps_text():
    record = SessionRecord('free', 'independent')
    record.data.update(free_context={'drug':{'name':'训练主题'}, 'doctor':{'display_name':'模拟医生'}}, capture_status='completed')
    record.transcript('u1', 'trainee', '我需要核对原文。', final=True)
    raw = {'overview':'先核实后回应。', 'dimensions':[{'key':key, 'score':95, 'reason':'先核对证据。',
        'quotes':[{'message_id':'u1', 'quote':'核对原文'}]} for key in ('compliance','communication')]}
    summary = validate_summary(raw, record, 'fake-model')
    assert summary['overview'] == raw['overview'] and summary['total'] is None
    assert all(row['score'] is None and row['weighted_points'] is None for row in summary['dimensions'])
    assert summary['dimensions'][1]['reason'] == '先核对证据。'
    del record.data['free_context']
    assert validate_summary(raw, record, 'fake-model')['dimensions'][1]['score'] == 95
