from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from contextlib import contextmanager
import asyncio
import threading

import pytest

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from medvisit.core.identity import current_role
from medvisit.platform.store import PlatformStore
from medvisit.visits.api import visits_router
from test_storage import database_url, store as postgres_store


def make_app(tmp_path, *, pool=None):
    store = PlatformStore(tmp_path / 'platform.sqlite3', pool=pool)
    store.open()
    settings = SimpleNamespace(records=tmp_path / 'records')
    app = FastAPI()

    @app.middleware('http')
    async def identity(request: Request, call_next):
        token = current_role.set(request.headers.get('x-role', 'representative'))
        try:
            return await call_next(request)
        finally:
            current_role.reset(token)

    def current_user(request: Request):
        return {'id':request.headers.get('x-user', 'alice'), 'workspace':'local', 'team':''}

    router = visits_router(store, settings, current_user)
    app.include_router(router)
    return app, router, store


def test_visit_access_and_audited_review(tmp_path):
    app, router, store = make_app(tmp_path)
    client = TestClient(app)
    created = client.post('/api/visits', json={'source':'self_report', 'visited_at':'2026-10-30', 'text':'电话 13812345678'}).json()
    item_id = created['id']
    assert client.get('/api/visits/' + item_id, headers={'x-user':'bob'}).status_code == 404
    assert client.get('/api/visits', headers={'x-user':'bob'}).json() == []
    admin = {'x-user':'admin', 'x-role':'admin'}
    assert client.get('/api/visits/' + item_id, headers=admin).json()['redaction_suggestion'] == '电话 [已隐藏]'
    assert client.post('/api/visits/' + item_id + '/review', headers=admin, json={'version':1,'decision':'scenario','reason':'复核'}).status_code == 409
    confirmed = client.post('/api/visits/' + item_id + '/confirm', json={'version':1,'redacted_text':'电话 [已隐藏]', 'redaction_confirmed':True}).json()
    assert confirmed['status'] == 'submitted'
    assert client.post('/api/visits/' + item_id + '/review', json={'version':2,'decision':'scenario','reason':'复核'}).status_code == 403
    reviewed = client.post('/api/visits/' + item_id + '/review', headers=admin, json={'version':2,'decision':'scenario','reason':'复核'}).json()
    assert reviewed['review']['decision'] == 'scenario'
    with store.transaction('local', write=False) as tx:
        assert any(x['action'] == 'visit.read' for x in tx.list('local', 'audit'))


def test_audio_permission_and_retention_is_not_extended(tmp_path, monkeypatch):
    app, router, store = make_app(tmp_path)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda path, kind: 30.0)
    client = TestClient(app)
    created = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-30'}).json()
    url = '/api/visits/' + created['id']
    headers = {'content-type':'audio/wav'}
    assert client.post(url + '/audio', content=b'fake', headers=headers).status_code == 422
    headers['x-recording-authorized'] = 'true'
    uploaded = client.post(url + '/audio', content=b'fake', headers=headers).json()
    assert uploaded['audio_status'] == 'transcription_unavailable'
    assert client.get(url + '/audio', headers={'x-user':'bob'}).status_code == 404
    assert client.get(url + '/audio').content == b'fake'
    confirmed = client.post(url + '/confirm', json={'version':uploaded['version'], 'redacted_text':'脱敏内容', 'redaction_confirmed':True}).json()
    with store.transaction('local') as tx:
        row = tx.get('local', 'visit', created['id'])
        row['confirmed_at'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        tx.update('local', 'visit', created['id'], row, row['version'])
    router.visit_cleanup('local')
    assert client.get(url + '/audio').status_code == 404
    saved = client.get(url).json()
    assert saved['audio_status'] == 'deleted' and saved['redacted_text'] == '脱敏内容'


async def test_provider_fetch_token_and_transcription(tmp_path, monkeypatch):
    import hashlib
    import httpx
    app, router, store = make_app(tmp_path)
    router.visit_run_job.__closure__  # exercise the same worker used by the HTTP endpoint
    # Supply provider configuration without making a paid request.
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'test-key'
    settings.origins = ('https://example.test',)
    audio_dir = tmp_path / 'visit-audio'
    audio_dir.mkdir()
    (audio_dir / ('a' * 32)).write_bytes(b'private audio')
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording', 'audio_status':'queued', 'audio_path':'a'*32,
            'audio_type':'audio/wav', 'audio_duration':10, 'transcription_job_id':'abc',
            'provider_token_hash':hashlib.sha256(b'secret').hexdigest(),
            'provider_token_expires':(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()})
    requests = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            requests.append((url, kwargs))
            if url.endswith('/submit'):
                return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'})
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'一段录音', 'utterances':[{'text':'一段录音','start_time':0,'end_time':100,'additions':{'speaker':'1'}}]}})
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Client)
    transaction = store.transaction
    loop_thread = threading.get_ident()
    @contextmanager
    def off_loop(*args, **kwargs):
        assert threading.get_ident() != loop_thread, 'Transcription storage blocked the event loop'
        with transaction(*args, **kwargs) as tx:
            yield tx
    with monkeypatch.context() as storage_check:
        storage_check.setattr(store, 'transaction', off_loop)
        await router.visit_run_job('local', item['id'], 'secret')
    assert requests[0][1]['json']['request']['enable_speaker_info'] is True
    with store.transaction('local', write=False) as tx:
        result = tx.get('local','visit',item['id'])
    assert 'text' not in result and 'segments' not in result and 'transcription_text' not in result
    detail = TestClient(app).get('/api/visits/' + item['id']).json()
    assert detail['text'] == '一段录音' and detail['segments'][0]['speaker_id'] == '1'
    assert result['provider_token_hash'] == ''
    assert TestClient(app).get('/api/visits/' + item['id'] + '/provider-audio?token=secret').status_code == 404


@pytest.mark.parametrize('commit_fails', [False, True])
@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_transcription_cancellation_drains_commit_before_releasing_slot(tmp_path, monkeypatch, request, commit_fails, storage):
    import httpx

    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording', 'audio_status':'transcribing',
            'transcription_job_id':'synthetic-job', 'provider_token_hash':'synthetic-token'})

    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'合成转写', 'utterances':[]}})

    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Client)
    transaction = store.transaction
    started, release, settled = asyncio.Event(), threading.Event(), threading.Event()
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    @contextmanager
    def delayed_commit(*args, **kwargs):
        assert threading.get_ident() != loop_thread, 'Transcription storage blocked the event loop'
        write = kwargs.get('write', True)
        try:
            with transaction(*args, **kwargs) as tx:
                yield tx
                if write:
                    loop.call_soon_threadsafe(started.set)
                    assert release.wait(5), 'Commit was not released'
                    if commit_fails:
                        raise RuntimeError('synthetic commit failure')
        finally:
            if write:
                settled.set()

    with monkeypatch.context() as storage_check:
        storage_check.setattr(store, 'transaction', delayed_commit)
        task = asyncio.create_task(router.visit_run_job('local', item['id']))
        try:
            await asyncio.wait_for(started.wait(), 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done() and not settled.is_set()
            slot = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if isinstance(cell.cell_contents, asyncio.Semaphore))
            assert slot.locked()
        finally:
            release.set()
            result, = await asyncio.gather(task, return_exceptions=True)
    assert settled.is_set()
    assert isinstance(result, RuntimeError if commit_fails else asyncio.CancelledError)
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    files = list((tmp_path / 'visit-audio').glob('*.transcript'))
    if commit_fails:
        assert saved['audio_status'] == 'transcribing' and files == []
    else:
        assert saved['audio_status'] == 'transcribed' and saved['provider_token_hash'] == ''
        assert [path.name for path in files] == [saved['transcript_file']]
        assert '合成转写' in files[0].read_text()
    # The next job must be admitted after success, cancellation or rollback.
    await asyncio.wait_for(router.visit_run_job('local', 'missing'), 1)


async def test_superseded_transcription_does_not_submit_or_promote_replacement(tmp_path, monkeypatch):
    app, router, store = make_app(tmp_path)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key, settings.origins = 'synthetic-key', ('https://example.test',)
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'audio_status':'queued', 'audio_type':'audio/wav',
            'audio_duration':10, 'transcription_job_id':'old-job'})
    requests = []

    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self):
            with store.transaction('local') as tx:
                old = tx.get('local', 'visit', item['id'])
                tx.update('local', 'visit', item['id'], {**old, 'transcription_job_id':'replacement-job'}, old['version'])
            return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            requests.append(args)
            raise AssertionError('A superseded job attempted a paid request')

    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Client)
    await router.visit_run_job('local', item['id'], 'old-token')
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert requests == [] and saved['audio_status'] == 'queued'
    assert saved['transcription_job_id'] == 'replacement-job'


def test_provider_link_only_accepts_unexpired_token_for_active_job(tmp_path):
    import hashlib
    app, router, store = make_app(tmp_path)
    directory = tmp_path / 'visit-audio'
    directory.mkdir()
    (directory / ('b' * 32)).write_bytes(b'authorized')
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'audio_path':'b'*32,
            'audio_type':'audio/wav', 'audio_status':'transcribing',
            'provider_token_hash':hashlib.sha256(b'good').hexdigest(),
            'provider_token_expires':(datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()})
    url = '/api/visits/' + item['id'] + '/provider-audio'
    client = TestClient(app)
    assert client.get(url, params={'token':'wrong'}).status_code == 404
    assert client.get(url, params={'token':'good'}).content == b'authorized'
    with store.transaction('local') as tx:
        row = tx.get('local','visit',item['id'])
        row['provider_token_expires'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        tx.update('local','visit',item['id'],row,row['version'])
    assert client.get(url, params={'token':'good'}).status_code == 404


def test_recording_original_text_is_never_stored_in_database_and_is_cleaned(tmp_path):
    import sqlite3
    app, router, store = make_app(tmp_path)
    client = TestClient(app)
    raw = 'RAW-RECORDING-PRIVATE-913'
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-30', 'text':raw}).json()
    assert item['text'] == raw
    with sqlite3.connect(store.path) as connection:
        documents = '\n'.join(row[0] for row in connection.execute('select document from platform_entities'))
    assert raw not in documents
    item = client.put('/api/visits/' + item['id'], json={'version':item['version'], 'visited_at':'2026-10-30', 'text':raw+'-edited'}).json()
    with sqlite3.connect(store.path) as connection:
        documents = '\n'.join(row[0] for row in connection.execute('select document from platform_entities'))
    assert raw not in documents
    item = client.post('/api/visits/' + item['id'] + '/confirm', json={'version':item['version'], 'redacted_text':'脱敏记录', 'redaction_confirmed':True}).json()
    with store.transaction('local') as tx:
        row = tx.get('local', 'visit', item['id'])
        row['confirmed_at'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        tx.update('local', 'visit', item['id'], row, row['version'])
    router.visit_cleanup('local')
    result = client.get('/api/visits/' + item['id']).json()
    assert result['text'] == '' and result['redacted_text'] == '脱敏记录'
    assert list((tmp_path / 'visit-audio').glob('*.transcript')) == []


async def test_recovery_migrates_legacy_raw_text_and_cleanup_removes_orphans(tmp_path):
    app, router, store = make_app(tmp_path)
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording', 'audio_status':'none',
            'text':'OLD-RAW-TRANSCRIPT', 'segments':[{'text':'OLD-RAW-TRANSCRIPT'}], 'audio_uploaded_at':None})
    router.visit_recover('local')
    with store.transaction('local', write=False) as tx:
        record = tx.get('local', 'visit', item['id'])
    assert 'text' not in record and 'segments' not in record
    assert TestClient(app).get('/api/visits/' + item['id']).json()['text'] == 'OLD-RAW-TRANSCRIPT'
    orphan = tmp_path / 'visit-audio' / ('c'*32 + '.transcript')
    orphan.write_text('old unreferenced sensitive content')
    router.visit_cleanup('local')
    assert not orphan.exists()


def test_reconfirm_does_not_extend_first_confirmation(tmp_path):
    app, router, store = make_app(tmp_path)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-30', 'text':'私密'}).json()
    url = '/api/visits/' + item['id']
    item = client.post(url + '/confirm', json={'version':item['version'], 'redacted_text':'已脱敏', 'redaction_confirmed':True}).json()
    first = item['confirmed_at']
    item = client.put(url, json={'version':item['version'], 'visited_at':'2026-10-30', 'text':'已修正私密'}).json()
    item = client.post(url + '/confirm', json={'version':item['version'], 'redacted_text':'再次脱敏', 'redaction_confirmed':True}).json()
    assert item['confirmed_at'] == first


def test_fact_review_uses_verified_public_quote_and_creates_only_draft(tmp_path):
    from fastapi import HTTPException
    from medvisit.platform.catalog import Catalog
    app, router, store = make_app(tmp_path)
    with store.transaction('local') as tx:
        doctor = tx.create('local', 'doctor', {'name':'王医生', 'status':'published', 'background_type':'public',
            'public_facts':'既有公开资料', 'sources':['https://hospital.example/old'], 'specialty':'内科',
            'population':'成人', 'focus':'沟通', 'training_style':'追问', 'mood':'neutral', 'opening':'请讲'})
        source = tx.create('local', 'content', {'status':'approved', 'source_url':'https://hospital.example/profile',
            'pages':[{'number':1, 'text':'王医生在内科从事临床研究。'}]})
    client = TestClient(app)
    visit = client.post('/api/visits', json={'doctor_id':doctor['id'], 'source':'self_report',
        'visited_at':'2026-10-30', 'text':'代表自述的猜测'}).json()
    url = '/api/visits/' + visit['id']
    visit = client.post(url + '/confirm', json={'version':visit['version'], 'redacted_text':'代表自述的猜测',
        'redaction_confirmed':True}).json()
    headers = {'x-user':'admin', 'x-role':'admin'}
    body = {'version':visit['version'], 'decision':'fact', 'reason':'核对', 'content_id':source['id'],
        'page':1, 'quote':'王医生在内科从事临床研究。', 'identity_confirmed':True}
    assert client.post(url+'/review', headers=headers, json={**body, 'identity_confirmed':False}).status_code == 422
    assert client.post(url+'/review', headers=headers, json={**body, 'quote':'王医生没有说过这句话'}).status_code == 422
    with store.transaction('local') as tx:
        old = tx.get('local','content',source['id'])
        tx.update('local','content',source['id'],{**old, 'status':'draft'},old['version'])
    assert client.post(url+'/review', headers=headers, json=body).status_code == 422
    with store.transaction('local') as tx:
        old = tx.get('local','content',source['id'])
        source = tx.update('local','content',source['id'],{**old, 'status':'approved'},old['version'])
    reviewed = client.post(url+'/review', headers=headers, json=body)
    assert reviewed.status_code == 200
    draft_id = reviewed.json()['review']['doctor_draft_id']
    with store.transaction('local') as tx:
        draft = tx.get('local','doctor',draft_id)
        original = tx.get('local','doctor',doctor['id'])
        assert draft['status'] == 'draft' and draft['doctor_id'] == doctor['id']
        assert draft['fact_evidence'][0]['identity_status'] == '待再次核对'
        assert body['quote'] in draft['public_facts'] and '代表自述的猜测' not in draft['public_facts']
        assert original['version'] == doctor['version']
        tx.update('local','content',source['id'],{**source, 'status':'retired'},source['version'])
    try:
        Catalog(store).publish({'id':'admin','workspace':'local'}, 'doctor', draft_id, draft['version'])
        assert False, 'revoked evidence must block publication'
    except HTTPException as exc:
        assert exc.status_code == 409


def test_self_report_audio_and_private_webm_transcoding(tmp_path, monkeypatch):
    import hashlib
    import sqlite3
    from pathlib import Path
    app, router, store = make_app(tmp_path)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda path, kind: 30.0)
    client = TestClient(app)
    ordinary = client.post('/api/visits', json={'source':'self_report','visited_at':'2026-10-30','text':'已有文字'}).json()
    headers = {'content-type':'audio/webm; codecs=opus', 'x-recording-authorized':'true'}
    assert client.post('/api/visits/'+ordinary['id']+'/audio', content=b'webm', headers=headers).status_code == 409
    visit = client.post('/api/visits', json={'source':'self_report', 'private_audio':True,
        'visited_at':'2026-10-30', 'text':'SELF-REPORT-RAW-PRIVATE'}).json()
    url = '/api/visits/' + visit['id']
    uploaded = client.post(url+'/audio', content=b'webm', headers=headers)
    assert uploaded.status_code == 202 and uploaded.json()['source'] == 'self_report'
    with sqlite3.connect(store.path) as connection:
        assert 'SELF-REPORT-RAW-PRIVATE' not in ''.join(row[0] for row in connection.execute('select document from platform_entities'))
    with store.transaction('local') as tx:
        item = tx.get('local','visit',visit['id'])
        tx.update('local','visit',visit['id'],{**item, 'audio_status':'transcribing',
            'provider_token_hash':hashlib.sha256(b'good').hexdigest(),
            'provider_token_expires':(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()},item['version'])
    monkeypatch.setattr('medvisit.visits.api.shutil.which', lambda binary: '/usr/bin/ffmpeg')
    def convert(args, **kwargs):
        assert '-c:a' in args and 'libopus' in args
        Path(args[-1]).write_bytes(b'encoded-ogg')
    monkeypatch.setattr('medvisit.visits.api.subprocess.run', convert)
    response = client.get(url+'/provider-audio', params={'token':'good'})
    assert response.status_code == 200 and response.content == b'encoded-ogg'
    assert response.headers['content-type'].startswith('audio/ogg')
    assert not list((tmp_path/'visit-audio').glob('*.provider.ogg'))
    item = client.get(url).json()
    confirmed = client.post(url+'/confirm', json={'version':item['version'], 'redacted_text':'脱敏自述', 'redaction_confirmed':True}).json()
    with store.transaction('local') as tx:
        item = tx.get('local','visit',visit['id'])
        tx.update('local','visit',visit['id'],{**item,'confirmed_at':(datetime.now(timezone.utc)-timedelta(days=8)).isoformat()},item['version'])
    router.visit_cleanup('local')
    result = client.get(url).json()
    assert result['source']=='self_report' and result['audio_status']=='deleted'
    assert result['text']=='' and result['redacted_text']==confirmed['redacted_text']


def test_cancel_during_webm_conversion_invalidates_link_and_deletes_copy(tmp_path, monkeypatch):
    import hashlib
    from pathlib import Path
    app, router, store = make_app(tmp_path)
    directory = tmp_path/'visit-audio'
    directory.mkdir()
    (directory/('d'*32)).write_bytes(b'webm')
    with store.transaction('local') as tx:
        item = tx.create('local','visit', {'owner_id':'alice','source':'self_report','private_audio':True,
            'audio_path':'d'*32,'audio_type':'audio/webm','audio_status':'transcribing',
            'provider_token_hash':hashlib.sha256(b'token').hexdigest(),
            'provider_token_expires':(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()})
    monkeypatch.setattr('medvisit.visits.api.shutil.which', lambda binary: '/usr/bin/ffmpeg')
    def cancel_during_conversion(args, **kwargs):
        Path(args[-1]).write_bytes(b'converted')
        with store.transaction('local') as tx:
            row = tx.get('local','visit',item['id'])
            tx.update('local','visit',item['id'],{**row,'audio_status':'transcription_interrupted','provider_token_hash':''},row['version'])
    monkeypatch.setattr('medvisit.visits.api.subprocess.run', cancel_during_conversion)
    result = TestClient(app).get('/api/visits/'+item['id']+'/provider-audio', params={'token':'token'})
    assert result.status_code == 404 and not list(directory.glob('*.provider.ogg'))


def test_expired_raw_audio_and_text_inaccessible_before_cleanup(tmp_path, monkeypatch):
    app, router, store = make_app(tmp_path)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda path, kind: 10.0)
    client = TestClient(app)
    item = client.post('/api/visits',json={'source':'self_report','private_audio':True,
        'visited_at':'2026-10-30','text':'临时原文'}).json()
    url = '/api/visits/'+item['id']
    client.post(url+'/audio',content=b'raw',headers={'content-type':'audio/webm','x-recording-authorized':'true'})
    with store.transaction('local') as tx:
        row=tx.get('local','visit',item['id'])
        tx.update('local','visit',item['id'],{**row,'audio_uploaded_at':(datetime.now(timezone.utc)-timedelta(days=31)).isoformat()},row['version'])
    assert client.get(url).json()['text'] == ''
    assert client.get(url+'/audio').status_code == 404


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_transcription_admission_keeps_storage_off_event_loop(tmp_path, monkeypatch, request, storage):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    settings.origins = ('https://example.test',)
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/transcription')
    transaction = store.transaction
    loop_thread = threading.get_ident()
    @contextmanager
    def off_loop(*args, **kwargs):
        assert threading.get_ident() != loop_thread, 'Transcription admission blocked the event loop'
        with transaction(*args, **kwargs) as tx:
            yield tx
    monkeypatch.setattr(store, 'transaction', off_loop)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        await endpoint('missing', user={'id':'alice', 'workspace':'local', 'team':''})
    assert error.value.status_code == 404
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('commit_fails', [False, True])
async def test_cancelled_transcription_admission_drains_and_recovers(tmp_path, monkeypatch, request, storage, commit_fails):
    from fastapi import HTTPException
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    settings.origins = ('https://example.test',)
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/transcription')
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording',
            'audio_status':'transcription_unavailable', 'audio_path':'a' * 32, 'audio_type':'audio/wav', 'audio_duration':10})
    launched = []
    launch = next(cell for name, cell in zip(endpoint.__code__.co_freevars, endpoint.__closure__) if name == 'launch')
    monkeypatch.setattr(launch, 'cell_contents', lambda *args: launched.append(args))
    transaction = store.transaction
    entered, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    @contextmanager
    def delayed(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        with transaction(*args, **kwargs) as tx:
            yield tx
            if not entered.is_set():
                entered.set()
                assert release.wait(3), 'Test did not release admission transaction'
                if commit_fails:
                    raise RuntimeError('synthetic commit failure')
    user = {'id':'alice', 'workspace':'local', 'team':''}
    with monkeypatch.context() as changes:
        changes.setattr(store, 'transaction', delayed)
        task = asyncio.create_task(endpoint(item['id'], user=user))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done(), 'Cancellation released the lifecycle before the database worker finished'
        finally:
            release.set()
        with pytest.raises(RuntimeError if commit_fails else asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
        actions = [entry['action'] for entry in tx.list('local', 'audit') if entry['object_id'] == item['id']]
    assert launched == []
    if commit_fails:
        assert saved['audio_status'] == 'transcription_unavailable'
        assert actions == []
    else:
        assert saved['audio_status'] == 'transcription_interrupted'
        assert saved['provider_token_hash'] == '' and saved['provider_token_expires'] is None
        assert set(actions) == {'visit.transcription_start', 'visit.transcription_cancel'}
    results = await asyncio.gather(endpoint(item['id'], user=user), endpoint(item['id'], user=user), return_exceptions=True)
    assert sum(isinstance(result, dict) and result['audio_status'] == 'queued' for result in results) == 1
    assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in results) == 1
    assert len(launched) == 1
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_transcription_shutdown_waits_for_admission(tmp_path, monkeypatch, request, storage):
    from fastapi import HTTPException
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    settings.origins = ('https://example.test',)
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/transcription')
    transaction = store.transaction
    entered, release = threading.Event(), threading.Event()
    @contextmanager
    def delayed(*args, **kwargs):
        with transaction(*args, **kwargs) as tx:
            entered.set()
            assert release.wait(3)
            yield tx
    user = {'id':'alice', 'workspace':'local', 'team':''}
    with monkeypatch.context() as changes:
        changes.setattr(store, 'transaction', delayed)
        admission = asyncio.create_task(endpoint('missing', user=user))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            stopping = asyncio.create_task(router.visit_close())
            await asyncio.sleep(0)
            assert not stopping.done()
        finally:
            release.set()
        with pytest.raises(HTTPException) as missing:
            await asyncio.wait_for(admission, 2)
        assert missing.value.status_code == 404
        await asyncio.wait_for(stopping, 2)
    with pytest.raises(HTTPException) as stopped:
        await endpoint('missing', user=user)
    assert stopped.value.status_code == 503


@pytest.mark.parametrize('storage', ['file', 'postgres'])
def test_transcription_admission_preserves_http_guards(tmp_path, monkeypatch, request, storage):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    settings.origins = ('https://example.test',)
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/transcription')
    launched = []
    launch = next(cell for name, cell in zip(endpoint.__code__.co_freevars, endpoint.__closure__) if name == 'launch')
    monkeypatch.setattr(launch, 'cell_contents', lambda *args: launched.append(args))
    with store.transaction('local') as tx:
        item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording',
            'audio_status':'transcription_unavailable', 'audio_path':'a' * 32, 'audio_type':'audio/wav', 'audio_duration':10})
        expired = tx.create('local', 'visit', {**item, 'audio_uploaded_at':(datetime.now(timezone.utc) - timedelta(days=31)).isoformat()})
    client = TestClient(app)
    url = '/api/visits/' + item['id'] + '/transcription'
    assert client.post(url, headers={'x-user':'bob'}).status_code == 404
    assert client.post(url, headers={'x-user':'admin','x-role':'admin'}).status_code == 403
    assert client.post('/api/visits/' + expired['id'] + '/transcription').status_code == 409
    response = client.post(url)
    assert response.status_code == 202 and response.json()['audio_status'] == 'queued'
    assert 'provider_token_hash' not in response.json() and 'audio_path' not in response.json()
    assert client.post(url).status_code == 409
    assert len(launched) == 1
