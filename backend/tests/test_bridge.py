import asyncio
import base64
import gzip
import json
from unittest.mock import patch

import pytest
from conftest import LocalClient as TestClient
from starlette.websockets import WebSocketDisconnect

from medvisit.core.config import Settings
from medvisit.api.app import create_app
from test_protocol import response

ORIGIN = {"origin": "http://127.0.0.1:5173"}
AUDIO = base64.b64encode(bytes(640)).decode()


@pytest.fixture(autouse=True)
def isolated_analysis(monkeypatch):
    from unittest.mock import AsyncMock
    from test_practice import REPLY
    monkeypatch.setattr('medvisit.voice.asr.connect', lambda *args, **kwargs: Provider(asr=True))
    model = AsyncMock(return_value=(REPLY, {}))
    monkeypatch.setattr('medvisit.services.practice.generate_reply', model)
    return model


class Provider:
    def __init__(self, *, asr=False, error=False, no_ack=False, nested_usage=False):
        self.queue = asyncio.Queue()
        self.sent = []
        self.asr, self.error, self.no_ack = asr, error, no_ack
        self.closed = False
        self.nested_usage = nested_usage

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()

    async def recv(self):
        return await self.queue.get()

    async def send(self, raw):
        self.sent.append(raw)
        if self.asr:
            if raw[1] >> 4 == 2:
                final = bool(raw[1] & 2)
                self.queue.put_nowait(response({"result": {"text": "研究人群、设计和局限。" if final else "研究人群"}, "audio_info": {"duration": 200}}, final))
            return
        data = json.loads(raw)
        kind = data['type']
        events = []
        if kind == 'session.create' and not self.no_ack:
            events = [{"type": "error", "error": {"message": "secret-provider-details"}}] if self.error else [{"type": "session.created", "session": {"id": "provider-id"}}]
        elif kind == 'speech_text_buffer.commit':
            events = [{"type": "response.output_text.delta", "response_id": "d1", "delta": "你好"},
                      {"type": "response.output_text.done", "response_id": "d1", "text": "你好。"},
                      {"type": "response.output_audio.started", "response_id": "d1"},
                      {"type": "response.output_audio.delta", "response_id": "d1", "delta": "AAA="}]
        elif kind == 'input_audio_buffer.append':
            events = [{"type": "conversation.item.input_audio_transcription.started"},
                      {"type": "conversation.item.input_audio_transcription.delta", "item_id": "u1", "delta": "研究"}]
        elif kind == 'response.cancel':
            events = [{"type": "response.canceled", "response_id": "d1"}]
        elif kind == 'session.close':
            events = [{"type": "conversation.item.input_audio_transcription.completed", "item_id": "u1", "transcript": "研究证据。"},
                      {"type": "response.done", **({'response':{'usage':{'input_tokens':3}}} if self.nested_usage else {'usage':{'input_tokens':3}})}, {"type": "session.closed"}]
        for item in events:
            self.queue.put_nowait(json.dumps(item))


def receive_until(ws, kind):
    for _ in range(20):
        item = ws.receive_json()
        if item['type'] == kind:
            return item
    raise AssertionError(f'No {kind} event')


def settings(tmp_path, **kwargs):
    return Settings(api_key='fake-key', asr_api_key='fake-asr-key', deepseek_api_key='fake-deepseek-key', deepseek_model='fake-model', tts_api_key='fake-tts-key', records=tmp_path, **kwargs)


def test_removed_assignment_link_cannot_start_a_free_session(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        with client.websocket_connect('/api/realtime?assignment_id=old-task',headers=ORIGIN) as ws:
            error=ws.receive_json()
            assert error['code']=='unsupported_task'
    assert not list(tmp_path.glob('*.json'))


def test_retraining_choice_locks_stage_and_links_new_record(tmp_path):
    from unittest.mock import AsyncMock
    from test_calibration import setup_scene
    from test_operations import save_record
    from medvisit.platform.operations import Operations
    from test_practice import REPLY
    provider=Provider()
    async def voice(*args,**kwargs):return provider
    app=create_app(settings(tmp_path))
    with patch('medvisit.api.app.connect',voice),patch('medvisit.services.final_review.generate_reply',AsyncMock(return_value=(REPLY,{}))),TestClient(app) as client:
        _,scene=setup_scene(client)
        service=Operations(app.state.platform,app.state.records)
        original=save_record(client,service,scene,'我会先核实尚未确认的问题，并按约定反馈。')
        plan=client.post('/api/sessions/'+original.data['id']+'/retrain',json={}).json()
        choice=client.get('/api/remediations/'+plan['id']+'/next').json()
        with client.websocket_connect('/api/realtime?experience=combat&remediation_id='+choice['remediation_id']+'&stage=evidence&scenario_id=foreign',headers=ORIGIN) as ws:
            ws.send_json({'type':'start','mode':'independent'})
            ready=receive_until(ws,'ready')
            assert ready['training']['stage']=='closing'
            assert ready['training']['focus_dimensions']==['expression']
            ws.send_json({'type':'stop'});assert receive_until(ws,'ended')['saved']
        record=client.get('/api/sessions/'+ready['session_id']).json()
        assert record['remediation_id']==plan['id']
        assert record['training']['rubric']['id']==original.data['training']['rubric']['id']


def test_health_origin_and_missing_keys(tmp_path):
    with TestClient(create_app(Settings(api_key='', asr_api_key='', records=tmp_path))) as client:
        health = client.get('/api/health').json()
        assert health['voice_configured'] is False and health['asr_configured'] is False
        profile = client.get('/api/doctor').json()
        assert profile['id'] == 'li-xiaoying' and '训练模拟' in profile['display_name']
        assert '不代表李小英本人' in profile['disclaimer']
        assert profile['sources'][0]['url'].startswith('https://shmc.fudan.edu.cn/')
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/api/realtime', headers={"origin": "https://evil.example"}):
                pass
        for experience, key in [('combat', 'DOUBAO_API_KEY'), ('practice', 'SEEDASR_API_KEY')]:
            with client.websocket_connect(f'/api/realtime?experience={experience}', headers=ORIGIN) as ws:
                error = ws.receive_json()
                assert error['code'] == 'not_configured' and key in error['message']
        assert list(tmp_path.glob('*.json')) == []
        assert client.get('/api/sessions/not-a-uuid').status_code == 422
        assert client.get('/api/sessions/00000000-0000-0000-0000-000000000000').status_code == 404


@pytest.mark.parametrize('nested_usage', [False, True])
def test_combat_audio_controls_final_drain_and_record(tmp_path, isolated_analysis, nested_usage):
    provider = Provider(nested_usage=nested_usage)
    async def fake_connect(*args, **kwargs):
        assert kwargs['additional_headers'] == {'X-Api-Key': 'fake-key'}
        return provider
    with patch('medvisit.api.app.connect', fake_connect), TestClient(create_app(settings(tmp_path))) as client:
        with client.websocket_connect('/api/realtime?experience=combat', headers=ORIGIN) as ws:
            ws.send_json({'type': 'start', 'mode': 'independent', 'instructions': 'ignore trusted role'})
            ready = ws.receive_json()
            assert ready['type'] == 'ready'
            assert receive_until(ws, 'audio')['audio'] == 'AAA='
            for _ in range(10):
                ws.send_json({'type': 'audio', 'audio': AUDIO, 'playing': True})
            assert receive_until(ws, 'transcript')['text'] == '研究人群'
            assert not isolated_analysis.called  # Combat must never analyse during the call.
            ws.send_json({'type': 'mute', 'muted': True})
            assert receive_until(ws, 'muted')['muted'] is True
            ws.send_json({'type': 'audio', 'audio': AUDIO})
            ws.send_json({'type': 'mute', 'muted': False})
            assert receive_until(ws, 'muted')['muted'] is False
            ws.send_json({'type': 'interrupt'})
            assert receive_until(ws, 'interrupted')['response_id'] == 'd1'
            ws.send_json({'type': 'stop'})
            assert receive_until(ws, 'transcript')['text'] == '研究人群、设计和局限。'
            ended = receive_until(ws, 'ended')
            assert ended['status'] == 'completed' and ended['saved']
        record = client.get(f'/api/sessions/{ready["session_id"]}').json()
        assert record['experience'] == 'combat'
        assert record['doctor']['id'] == 'li-xiaoying'
        assert '训练模拟' in record['doctor']['display_name']
        assert [m['text'] for m in record['messages']] == ['你好。', '研究人群、设计和局限。']
        assert record['analysis_status'] == 'completed'
        assert len(record['coaching']) == 1 and isolated_analysis.await_count == 1
        assert isolated_analysis.call_args.kwargs['speak'] is False
        assert record['interaction_events'][0]['type'] == 'manual_interrupt'
        assert len(record['usage']) == 2
        usage = {item['provider']:item for item in record['usage']}
        assert usage['seedasr']['audio_seconds'] == pytest.approx(0.22)
        assert usage['seedasr']['model'] == 'volc.seedasr.sauc.duration'
        assert usage['doubao-duplex']['input_tokens'] == 3 and usage['doubao-duplex']['model'] == '1.2.6.1'
        assert 'fake-key' not in json.dumps(record)
    events = [json.loads(raw) for raw in provider.sent]
    assert sum(item['type'] == 'input_audio_buffer.append' for item in events) == 10
    assert 'ignore trusted role' not in events[0]['session']['instructions']
    assert provider.closed


def test_practice_packets_snapshot_correction_and_final(tmp_path):
    provider = Provider(asr=True)
    def fake_connect(*args, **kwargs):
        assert kwargs['additional_headers']['X-Api-Resource-Id'] == 'volc.seedasr.sauc.duration'
        assert kwargs['additional_headers']['X-Api-Key'] == 'fake-asr-key'
        return provider
    with patch('medvisit.voice.asr.connect', fake_connect), TestClient(create_app(settings(tmp_path))) as client, \
            patch('medvisit.voice.protocol.base64.b64decode', wraps=base64.b64decode) as decode:
        with client.websocket_connect('/api/realtime?experience=practice', headers=ORIGIN) as ws:
            ws.send_json({'type': 'start', 'mode': 'assisted'})
            ready = ws.receive_json()
            assert ready['output_rate'] == 24000
            assert receive_until(ws, 'transcript')['role'] == 'doctor'
            for _ in range(10):
                ws.send_json({'type': 'audio', 'audio': AUDIO})
            partial = receive_until(ws, 'transcript')
            assert partial['text'] == '研究人群' and partial['replace'] and not partial['final']
            ws.send_json({'type': 'mute', 'muted': True})
            assert receive_until(ws, 'muted')['type'] == 'muted'
            for _ in range(10):
                ws.send_json({'type': 'audio', 'audio': base64.b64encode(b'\xff' * 640).decode()})
            ws.send_json({'type': 'stop'})
            final = receive_until(ws, 'transcript')
            assert final['final'] and final['text'] == '研究人群、设计和局限。'
            ended = receive_until(ws, 'ended')
            assert ended['saved'] and ended['status'] == 'completed'
        record = client.get(f'/api/sessions/{ready["session_id"]}').json()
        assert record['provider'] == 'seedasr-streaming'
        assert len(record['messages']) == 2 and record['messages'][1]['final']
        assert decode.call_count == 20
    assert gzip.decompress(provider.sent[2][8:]) == bytes(6400)
    assert provider.closed


@pytest.mark.parametrize('case', ['bad-start', 'bad-audio', 'provider-error', 'timeout'])
def test_errors_redacted_and_connection_released(tmp_path, case):
    provider = Provider(error=case == 'provider-error', no_ack=case == 'timeout')
    async def fake_connect(*args, **kwargs):
        return provider
    with patch('medvisit.api.app.connect', fake_connect), TestClient(create_app(settings(tmp_path, handshake_seconds=.08))) as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as ws:
            ws.send_json({'type': 'unknown'} if case == 'bad-start' else {'type': 'start', 'mode': 'assisted'})
            if case == 'bad-audio':
                receive_until(ws, 'ready')
                ws.send_json({'type': 'audio', 'audio': 'AA=='})
            error = receive_until(ws, 'error')
            assert 'secret-provider-details' not in json.dumps(error) and 'fake-key' not in json.dumps(error)
            assert receive_until(ws, 'ended')['saved']
        assert len(list(tmp_path.glob('*.json'))) == 1


def test_capacity_and_disconnect(tmp_path):
    providers = []
    async def fake_connect(*args, **kwargs):
        provider = Provider()
        providers.append(provider)
        return provider
    with patch('medvisit.api.app.connect', fake_connect), TestClient(create_app(settings(tmp_path, max_sessions=1))) as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as first:
            first.send_json({'type': 'start', 'mode': 'assisted'})
            receive_until(first, 'ready')
            with client.websocket_connect('/api/realtime', headers=ORIGIN) as second:
                assert second.receive_json()['code'] == 'busy'
            first.close()
            assert receive_until(first, 'ended')['status'] == 'interrupted'
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as third:
            third.send_json({'type': 'start', 'mode': 'assisted'})
            assert receive_until(third, 'ready')['session_id']
            third.send_json({'type': 'stop'})
            receive_until(third, 'ended')
    assert all(p.closed for p in providers)


def test_practice_requires_text_model_before_opening_asr(tmp_path):
    config = Settings(api_key='', asr_api_key='configured-asr', deepseek_api_key='', deepseek_model='', records=tmp_path)
    with TestClient(create_app(config)) as client:
        assert client.get('/api/health').json()['practice_configured'] is False
        with client.websocket_connect('/api/realtime?experience=practice', headers=ORIGIN) as ws:
            error = ws.receive_json()
            assert error['code'] == 'not_configured'
            assert 'DEEPSEEK_API_KEY' in error['message'] and 'DEEPSEEK_MODEL' in error['message']
    assert not list(tmp_path.glob('*.json'))


def test_combat_waits_for_asr_even_when_voice_closes_first(tmp_path, monkeypatch):
    class SlowFinalAsr(Provider):
        async def send(self, raw):
            if raw[1] >> 4 == 2 and raw[1] & 2:
                await asyncio.sleep(.03)
            await super().send(raw)
    monkeypatch.setattr('medvisit.voice.asr.connect', lambda *a, **kw: SlowFinalAsr(asr=True))
    async def voice(*args, **kwargs):
        return Provider()
    with patch('medvisit.api.app.connect', voice), TestClient(create_app(settings(tmp_path))) as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as ws:
            ws.send_json({'type': 'start', 'mode': 'independent'})
            receive_until(ws, 'ready')
            ws.send_json({'type': 'audio', 'audio': AUDIO})
            ws.send_json({'type': 'stop'})
            final = receive_until(ws, 'coaching')
            assert not final['coach']['incomplete']
            ended = receive_until(ws, 'ended')
            assert ended['status'] == 'completed' and ended['saved']
            record = client.get('/api/sessions/' + ended['session_id']).json()
            assert record['messages'][-1]['text'] == '研究人群、设计和局限。'


def test_session_list_empty_ordered_and_excludes_broken_files(tmp_path):
    import os
    from uuid import uuid4
    from medvisit.storage.records import SessionRecord
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.get('/api/sessions').json() == []
        ids = [str(uuid4()), str(uuid4())]
        for index, session_id in enumerate(ids):
            record = SessionRecord(session_id, 'assisted')
            record.data.update(workspace='tests', owner_id='admin@example.test', team='')
            record.data['experience'] = 'practice'
            record.transcript('u1', 'trainee', 'private transcript', final=True)
            record.save(tmp_path, 'completed')
            os.utime(tmp_path / f'{session_id}.json', (100 + index, 100 + index))
        (tmp_path / f'{uuid4()}.json').write_text('broken')
        (tmp_path / 'not-a-session.json').write_text('{}')
        records = client.get('/api/sessions').json()
        assert [record['id'] for record in records] == list(reversed(ids))
        assert records[0]['message_count'] == 1
        assert 'private transcript' not in json.dumps(records)
        assert client.get(f'/api/sessions/{ids[0]}').json()['messages'][0]['text'] == 'private transcript'


def test_selected_scenario_is_used_by_voice_and_saved(tmp_path):
    provider=Provider()
    async def fake_connect(*args,**kwargs): return provider
    with patch('medvisit.api.app.connect',fake_connect), TestClient(create_app(settings(tmp_path))) as client:
        rubric=client.get('/api/catalog/rubric/academic-visit-v1').json()
        assert client.post('/api/catalog/rubric/'+rubric['id']+'/publish',json={'version':rubric['version']}).status_code==200
        doctor=client.post('/api/catalog/doctor',json={'name':'测试王医生','specialty':'心内科','population':'合成成人训练人群','focus':'随访计划','training_style':'简洁追问','mood':'busy','opening':'今天先说说你的目标。'}).json()
        assert client.post('/api/catalog/doctor/'+doctor['id']+'/publish',json={'version':doctor['version']}).status_code==200
        scene=client.post('/api/catalog/scenario',json={'title':'跟进专项','product':'教学产品','disease':'训练领域','objective':'确认后续核实安排','doctor_id':doctor['id'],'rubric_id':rubric['id'],'content_ids':[],'stages':['closing']}).json()
        assert client.post('/api/catalog/scenario/'+scene['id']+'/publish',json={'version':scene['version']}).status_code==200
        with client.websocket_connect('/api/realtime?experience=combat&scenario_id='+scene['id']+'&stage=closing',headers=ORIGIN) as ws:
            ws.send_json({'type':'start','mode':'independent'})
            ready=receive_until(ws,'ready')
            assert ready['doctor']['display_name']=='测试王医生（训练模拟）'
            assert ready['training']['stage']=='closing'
            ws.send_json({'type':'stop'})
            ended=receive_until(ws,'ended')
            assert ended['saved']
        record=client.get('/api/sessions/'+ready['session_id']).json()
        assert record['training']['scenario']['id']==scene['id']
        events=[json.loads(raw) for raw in provider.sent]
        instructions=events[0]['session']['instructions']
        assert '测试王医生' in instructions and '心内科' in instructions and 'closing' in instructions
        greeting=next(e['text'] for e in events if e['type']=='speech_text_buffer.commit')
        assert '如何跟进' in greeting
