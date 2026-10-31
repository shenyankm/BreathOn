from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
import asyncio
import threading
from uuid import uuid4

import pytest

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from psycopg import IsolationLevel, OperationalError, connect

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
        await router.visit_run_job('local', item['id'], 'abc', 'secret')
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
    blocked = False
    @contextmanager
    def delayed_commit(*args, **kwargs):
        nonlocal blocked
        assert threading.get_ident() != loop_thread, 'Transcription storage blocked the event loop'
        write = kwargs.get('write', True)
        inject = write and not blocked
        if inject:
            blocked = True
        try:
            with transaction(*args, **kwargs) as tx:
                yield tx
                if inject:
                    loop.call_soon_threadsafe(started.set)
                    assert release.wait(5), 'Commit was not released'
                    if commit_fails:
                        raise RuntimeError('synthetic commit failure')
        finally:
            if inject:
                settled.set()

    with monkeypatch.context() as storage_check:
        storage_check.setattr(store, 'transaction', delayed_commit)
        task = asyncio.create_task(router.visit_run_job('local', item['id'], 'synthetic-job'))
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
    await asyncio.wait_for(router.visit_run_job('local', 'missing', 'synthetic-job'), 1)


@pytest.mark.parametrize('replacement_before_read', [False, True])
async def test_superseded_transcription_does_not_submit_or_promote_replacement(tmp_path, monkeypatch, replacement_before_read):
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
    if replacement_before_read:
        with store.transaction('local') as tx:
            current = tx.get('local', 'visit', item['id'])
            tx.update('local', 'visit', item['id'], {**current, 'transcription_job_id':'replacement-job'}, current['version'])
    await router.visit_run_job('local', item['id'], 'old-job', 'old-token')
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert requests == [] and saved['audio_status'] == 'queued'
    assert saved['transcription_job_id'] == 'replacement-job'


@pytest.mark.parametrize('storage', ['sqlite', 'postgres'])
@pytest.mark.parametrize('replacements', [1, 3])
async def test_cancelled_queued_transcription_keeps_replacement_identity(tmp_path, monkeypatch, request, storage, replacements):
    from io import BytesIO
    from urllib.parse import urlsplit
    import httpx
    import wave

    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    config = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    config.asr_api_key, config.origins = 'synthetic-key', ('https://example.test',)
    tokens = []
    def token(_):
        tokens.append('synthetic-token-' + str(len(tokens)))
        return tokens[-1]
    monkeypatch.setattr('medvisit.visits.api.secrets.token_urlsafe', token)
    raw = BytesIO()
    with wave.open(raw, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(bytes(32000))
    data = raw.getvalue()
    entered, release = asyncio.Event(), asyncio.Event()
    calls, fetched = [], {}
    first_job = None
    client_type = httpx.AsyncClient

    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            job_id = kwargs['headers']['X-Api-Request-Id']
            action = url.rsplit('/', 1)[-1]
            calls.append((action, job_id))
            if action == 'submit':
                target = urlsplit(kwargs['json']['audio']['url'])
                response = await client.get(target.path + '?' + target.query)
                fetched[job_id] = response.status_code
                if response.status_code == 200:
                    assert response.content == data
                assert kwargs['json']['request']['enable_speaker_info'] is True
                assert kwargs['json']['request']['show_utterances'] is True
                return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'})
            assert action == 'query'
            if job_id == first_job:
                entered.set()
                await release.wait()
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000' if fetched[job_id] == 200 else '40000000'},
                json={'result':{'text':'Synthetic provider transcript', 'utterances':[]}})

    async with client_type(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        items = []
        directory = tmp_path/'visit-audio'
        directory.mkdir(exist_ok=True)
        for _ in range(2):
            response = await client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'Synthetic original note'})
            assert response.status_code == 201
            item = response.json()
            items.append(item['id'])
            path = directory/uuid4().hex
            path.write_bytes(data)
            path.chmod(0o600)
            with store.transaction('local') as tx:
                current = tx.get('local', 'visit', item['id'])
                tx.update('local', 'visit', item['id'], {**current, 'audio_path':path.name,
                    'audio_type':'audio/wav', 'audio_duration':1, 'audio_status':'transcription_unavailable'}, current['version'])
        with monkeypatch.context() as provider:
            provider.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
            try:
                response = await client.post(f'/api/visits/{items[0]}/transcription')
                assert response.status_code == 202
                first_job = response.json()['transcription_job_id']
                await asyncio.wait_for(entered.wait(), 2)
                old_jobs, old_tokens = [], []
                for _ in range(replacements):
                    response = await client.post(f'/api/visits/{items[1]}/transcription')
                    assert response.status_code == 202
                    old_jobs.append(response.json()['transcription_job_id'])
                    old_tokens.append(tokens[-1])
                    cancelled = await client.post(f'/api/visits/{items[1]}/transcription/cancel')
                    assert cancelled.status_code == 200 and cancelled.json()['audio_status'] == 'transcription_interrupted'
                replacement = await client.post(f'/api/visits/{items[1]}/transcription')
                assert replacement.status_code == 202
                replacement_id = replacement.json()['transcription_job_id']
                assert replacement_id not in old_jobs
                release.set()
                async with asyncio.timeout(3):
                    while True:
                        response = await client.get('/api/visits/' + items[1])
                        if response.json()['audio_status'] not in ('queued', 'transcribing'):
                            break
                        await asyncio.sleep(.001)
                assert response.json()['audio_status'] == 'transcribed'
                assert response.json()['transcription_job_id'] == replacement_id
                assert response.json()['text'] == 'Synthetic original note'
                assert response.json()['transcription_text'] == 'Synthetic provider transcript'
                assert fetched == {first_job:200, replacement_id:200}
                assert calls.count(('submit', replacement_id)) == calls.count(('query', replacement_id)) == 1
                assert not any(job_id in old_jobs for _, job_id in calls)
                for value in old_tokens:
                    assert (await client.get(f'/api/visits/{items[1]}/provider-audio?token={value}')).status_code == 404
                assert (await client.get('/api/visits/' + items[1], headers={'x-user':'bob'})).status_code == 404
                before = list(calls)
                await router.visit_run_job('other-workspace', items[1], replacement_id)
                await router.visit_run_job('local', 'missing', replacement_id)
                with store.transaction('local') as tx:
                    current = tx.get('local', 'visit', items[1])
                    tx.update('local', 'visit', items[1], {**current, 'audio_status':'deleted'}, current['version'])
                await router.visit_run_job('local', items[1], replacement_id)
                assert calls == before
            finally:
                release.set()
                await router.visit_close()
    slots = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if isinstance(cell.cell_contents, asyncio.Semaphore))
    assert not slots.locked()


@pytest.mark.parametrize('storage', ['sqlite', 'postgres'])
@pytest.mark.parametrize('missing_id', [False, True])
async def test_recovery_transcription_keeps_saved_identity_and_error_boundary(tmp_path, monkeypatch, request, storage, missing_id):
    import httpx
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    config = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    config.asr_api_key = 'synthetic-key'
    queries = []
    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            assert url.endswith('/query'), 'Recovery must not resubmit a paid job'
            queries.append(kwargs['headers']['X-Api-Request-Id'])
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'Synthetic recovered result', 'utterances':[]}})
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
    workspace = 'recovery-test-' + uuid4().hex
    with store.transaction(workspace) as tx:
        item = tx.create(workspace, 'visit', {'owner_id':'alice', 'source':'recording', 'audio_status':'transcribing',
            **({} if missing_id else {'transcription_job_id':'saved-job'})})
    launch = next(cell.cell_contents for name, cell in zip(router.visit_recover.__code__.co_freevars, router.visit_recover.__closure__) if name == 'launch')
    tasks = next(cell.cell_contents for name, cell in zip(launch.__code__.co_freevars, launch.__closure__) if name == 'tasks')
    try:
        router.visit_recover(workspace)
        results = await asyncio.wait_for(asyncio.gather(*list(tasks), return_exceptions=True), 3)
        with store.transaction(workspace, write=False) as tx:
            saved = tx.get(workspace, 'visit', item['id'])
        if missing_id:
            assert len(results) == 1 and isinstance(results[0], KeyError)
            assert saved == item and queries == []
        else:
            assert results == [None] and queries == ['saved-job']
            assert saved['audio_status'] == 'transcribed' and saved['transcription_job_id'] == 'saved-job'
        assert not tasks
    finally:
        await router.visit_close()


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


@pytest.mark.parametrize('storage', ['file', 'postgres'])
def test_old_cleanup_failure_preserves_committed_transcript(tmp_path, monkeypatch, request, storage):
    from pathlib import Path
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'original synthetic text'}).json()
    with store.transaction('local', write=False) as tx:
        old = tx.get('local', 'visit', item['id'])['transcript_file']
    unlink = Path.unlink
    def fail_old(path, *args, **kwargs):
        if path.name == old:
            raise OSError('synthetic old-file cleanup failure')
        return unlink(path, *args, **kwargs)
    with monkeypatch.context() as fault:
        fault.setattr(Path, 'unlink', fail_old)
        with pytest.raises(OSError, match='synthetic old-file cleanup failure'):
            client.put('/api/visits/' + item['id'], json={'version':item['version'], 'visited_at':'2026-10-31', 'text':'committed synthetic replacement'})
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert saved['version'] == 2
    replacement = tmp_path / 'visit-audio' / saved['transcript_file']
    assert replacement.is_file(), 'Post-commit cleanup deleted a committed attachment'
    assert client.get('/api/visits/' + item['id']).json()['text'] == 'committed synthetic replacement'
    router.visit_cleanup('local')
    assert not (tmp_path / 'visit-audio' / old).exists()
    assert replacement.is_file()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('operation', ['create', 'upload'])
def test_response_failure_preserves_committed_visit_files(tmp_path, monkeypatch, request, storage, operation):
    from pathlib import Path
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    body = {'source':'recording', 'visited_at':'2026-10-31', 'text':'private synthetic text'}
    item = client.post('/api/visits', json=body).json() if operation == 'upload' else None
    with store.transaction('local', write=False) as tx:
        before = {row['id'] for row in tx.list('local', 'visit')}
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    read_text = Path.read_text
    def fail_read(path, *args, **kwargs):
        if path.suffix == '.transcript':
            raise OSError('synthetic response read failure')
        return read_text(path, *args, **kwargs)
    with monkeypatch.context() as fault:
        fault.setattr(Path, 'read_text', fail_read)
        response = (client.post('/api/visits', json=body) if operation == 'create' else
            client.post('/api/visits/' + item['id'] + '/audio', content=b'synthetic audio',
                headers={'content-type':'audio/wav', 'x-recording-authorized':'true'}))
        assert response.status_code == 409
    with store.transaction('local', write=False) as tx:
        saved = (next(row for row in tx.list('local', 'visit') if row['id'] not in before) if operation == 'create' else
            tx.get('local', 'visit', item['id']))
    directory = tmp_path / 'visit-audio'
    assert (directory / saved['transcript_file']).is_file()
    if operation == 'upload':
        assert saved['audio_status'] == 'transcription_unavailable'
        assert (directory / saved['audio_path']).read_bytes() == b'synthetic audio'
        assert client.get('/api/visits/' + saved['id'] + '/audio').content == b'synthetic audio'
        files = {path.name for path in directory.iterdir()}
        assert client.post('/api/visits/' + saved['id'] + '/audio', content=b'synthetic audio',
            headers={'content-type':'audio/wav', 'x-recording-authorized':'true'}).status_code == 409
        assert {path.name for path in directory.iterdir()} == files
    assert client.get('/api/visits/' + saved['id']).json()['text'] == body['text']


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_transcription_cleanup_failure_preserves_committed_result(tmp_path, monkeypatch, request, storage):
    from pathlib import Path
    import httpx
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'original synthetic text'}).json()
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    with store.transaction('local') as tx:
        row = tx.get('local', 'visit', item['id'])
        old = row['transcript_file']
        tx.update('local', 'visit', item['id'], {**row, 'audio_status':'transcribing', 'transcription_job_id':'synthetic-job'}, row['version'])
    requests = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            assert url.endswith('/query')
            requests.append(url)
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'synthetic provider result', 'utterances':[]}})
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Client)
    unlink = Path.unlink
    def fail_old(path, *args, **kwargs):
        if path.name == old:
            raise OSError('synthetic old-file cleanup failure')
        return unlink(path, *args, **kwargs)
    with monkeypatch.context() as fault:
        fault.setattr(Path, 'unlink', fail_old)
        with pytest.raises(OSError, match='synthetic old-file cleanup failure'):
            await router.visit_run_job('local', item['id'], 'synthetic-job')
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert saved['version'] == 3 and saved['audio_status'] == 'transcribed'
    replacement = tmp_path / 'visit-audio' / saved['transcript_file']
    assert replacement.is_file(), 'Cleanup deleted the committed ASR result'
    detail = client.get('/api/visits/' + item['id']).json()
    assert detail['text'] == 'original synthetic text' and detail['transcription_text'] == 'synthetic provider result'
    assert len(requests) == 1
    router.visit_cleanup('local')
    assert replacement.is_file() and not (tmp_path / 'visit-audio' / old).exists()
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('applied', [False, True])
async def test_transcription_failed_commit_preserves_only_committed_result(tmp_path, monkeypatch, request, storage, applied):
    import httpx
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'original synthetic text'}).json()
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key = 'synthetic-key'
    with store.transaction('local') as tx:
        row = tx.get('local', 'visit', item['id'])
        tx.update('local', 'visit', item['id'], {**row, 'audio_status':'transcribing', 'transcription_job_id':'synthetic-job'}, row['version'])
    with store.transaction('local', write=False) as tx:
        before = tx.get('local', 'visit', item['id'])
    directory = tmp_path / 'visit-audio'
    before_files = {path.name:path.read_bytes() for path in directory.iterdir()}
    queries = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            assert url.endswith('/query')
            queries.append(url)
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'synthetic provider result', 'utterances':[]}})
    transaction = store.transaction
    armed = True
    @contextmanager
    def fail(*args, **kwargs):
        nonlocal armed
        inject = armed and kwargs.get('write', True)
        with transaction(*args, **kwargs) as tx:
            yield tx
            if inject and not applied:
                armed = False
                raise OperationalError('synthetic transcription commit failure')
        if inject:
            armed = False
            raise OperationalError('synthetic transcription commit failure')
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Client)
    with monkeypatch.context() as fault:
        fault.setattr(store, 'transaction', fail)
        with pytest.raises(OperationalError, match='synthetic transcription commit failure'):
            await router.visit_run_job('local', item['id'], 'synthetic-job')
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    if applied:
        assert saved['audio_status'] == 'transcribed' and saved['version'] == before['version'] + 1
        assert (directory / saved['transcript_file']).is_file(), 'Cleanup deleted a committed transcription'
        detail = client.get('/api/visits/' + item['id'])
        assert detail.status_code == 200
        assert detail.json()['text'] == 'original synthetic text'
        assert detail.json()['transcription_text'] == 'synthetic provider result'
        router.visit_cleanup('local')
        assert (directory / saved['transcript_file']).is_file()
    else:
        assert saved == before and {path.name:path.read_bytes() for path in directory.iterdir()} == before_files
    assert len(queries) == 1 and not armed
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('operation', ['create', 'edit', 'upload'])
@pytest.mark.parametrize('applied', [False, True])
@pytest.mark.parametrize('failure', [RuntimeError, OperationalError])
def test_failed_visit_commit_cleans_only_uncommitted_files(tmp_path, monkeypatch, request, storage, operation, applied, failure):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    body = {'source':'recording', 'visited_at':'2026-10-31', 'text':'private synthetic text'}
    other = client.post('/api/visits', json=body, headers={'x-user':'bob'}).json()
    item = client.post('/api/visits', json=body).json() if operation != 'create' else None
    directory = tmp_path / 'visit-audio'
    before_files = {path.name:path.read_bytes() for path in directory.glob('*')} if directory.exists() else {}
    with store.transaction('local', write=False) as tx:
        before = tx.list('local', 'visit')
    transaction = store.transaction
    armed = True
    @contextmanager
    def fail_commit(*args, **kwargs):
        nonlocal armed
        inject = armed and kwargs.get('write', True)
        with transaction(*args, **kwargs) as tx:
            yield tx
            inject = inject and (operation != 'upload' or bool(tx.get('local', 'visit', item['id']).get('audio_path')))
            if inject and not applied:
                armed = False
                raise failure('synthetic commit failure')
        if inject:
            armed = False
            raise failure('synthetic commit failure')
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    with monkeypatch.context() as fault:
        fault.setattr(store, 'transaction', fail_commit)
        with pytest.raises(failure, match='synthetic commit failure'):
            if operation == 'create':
                client.post('/api/visits', json=body)
            elif operation == 'edit':
                client.put('/api/visits/' + item['id'], json={'version':item['version'], 'visited_at':'2026-10-31', 'text':'replacement'})
            else:
                client.post('/api/visits/' + item['id'] + '/audio', content=b'synthetic audio',
                    headers={'content-type':'audio/wav', 'x-recording-authorized':'true'})
    with store.transaction('local', write=False) as tx:
        after = tx.list('local', 'visit')
    assert not armed
    if not applied:
        assert after == before
        assert {path.name:path.read_bytes() for path in directory.glob('*')} == before_files
    else:
        originals = {row['id']:row for row in before}
        changed = [row for row in after if row != originals.get(row['id'])]
        assert len(changed) == 1
        saved = changed[0]
        assert saved['owner_id'] == 'alice'
        assert len(after) == len(before) + (operation == 'create')
        assert all(row == originals[row['id']] for row in after if row['id'] != saved['id'])
        name = saved['audio_path' if operation == 'upload' else 'transcript_file']
        assert name and (directory / name).is_file(), 'Cleanup deleted a committed private file'
        assert (directory / name).stat().st_mode & 0o777 == 0o600
        if operation == 'upload':
            audio = client.get('/api/visits/' + saved['id'] + '/audio')
            assert audio.status_code == 200 and audio.content == b'synthetic audio'
            assert audio.headers['cache-control'] == 'no-store' and audio.headers['x-content-type-options'] == 'nosniff'
        else:
            detail = client.get('/api/visits/' + saved['id'])
            assert detail.status_code == 200
            assert detail.json()['text'] == ('replacement' if operation == 'edit' else body['text'])
        router.visit_cleanup('local')
        assert (directory / name).is_file()
    assert client.get('/api/visits/' + other['id']).status_code == 404
    assert client.get('/api/visits/' + other['id'], headers={'x-user':'bob'}).json()['text'] == body['text']


@pytest.mark.parametrize('settle_commit', [False, True])
@pytest.mark.parametrize('repeatable_read', [False, True])
@pytest.mark.parametrize('cancel_cleanup', [False, True])
async def test_upload_discard_waits_for_uncertain_transaction_to_settle(tmp_path, monkeypatch, postgres_store, settle_commit, repeatable_read, cancel_cleanup):
    pool = postgres_store.pool
    with ExitStack() as connections:
        for _ in range(pool.max_size):
            connection = connections.enter_context(pool.connection())
            connection.isolation_level = IsolationLevel.REPEATABLE_READ if repeatable_read else IsolationLevel.READ_COMMITTED
    app, router, store = make_app(tmp_path, pool=pool)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    transaction = store.transaction
    reported = OperationalError('synthetic uncertain transaction result')
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    settlers, errors = [], []
    armed = True
    @contextmanager
    def pending(*args, **kwargs):
        nonlocal armed
        if not armed or not kwargs.get('write', True):
            with transaction(*args, **kwargs) as tx:
                yield tx
            return
        context = transaction(*args, **kwargs)
        tx = context.__enter__()
        try:
            yield tx
        except BaseException as exc:
            context.__exit__(type(exc), exc, exc.__traceback__)
            raise
        if not tx.get('local', 'visit', item['id']).get('audio_path'):
            context.__exit__(None, None, None)
            return
        armed = False
        def settle():
            try:
                assert release.wait(5), 'Test did not release original transaction'
                if settle_commit:
                    context.__exit__(None, None, None)
                else:
                    error = OperationalError('synthetic delayed rollback')
                    context.__exit__(type(error), error, None)
            except BaseException as exc:
                errors.append(type(exc).__name__)
            finally:
                finished.set()
        thread = threading.Thread(target=settle)
        settlers.append(thread)
        thread.start()
        started.set()
        raise reported
    user = {'id':'alice', 'workspace':'local', 'team':''}
    with monkeypatch.context() as fault:
        fault.setattr(store, 'transaction', pending)
        stamp = asyncio.get_running_loop().time()
        task = asyncio.create_task(endpoint(item['id'], audio_request(), user=user))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            assert asyncio.get_running_loop().time() - stamp < .5, 'Discard blocked the event loop'
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(task), .05)
            files = list((tmp_path / 'visit-audio').iterdir())
            assert len(files) == 1 and files[0].read_bytes() == b'synthetic audio'
            with connect(postgres_store.pool.conninfo, autocommit=True) as observer:
                waiting = observer.execute("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())").fetchone()[0]
                assert waiting >= 1, 'Discard did not wait for the existing workspace lock'
            if cancel_cleanup:
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0)
                assert not task.done() and files[0].is_file()
        finally:
            release.set()
            result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3))[0]
            for thread in settlers:
                await asyncio.to_thread(thread.join, 2)
            assert await asyncio.to_thread(finished.wait, 2)
    assert result is reported and not task.cancelled() and not errors
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    if settle_commit:
        assert saved['audio_status'] == 'transcription_unavailable'
        assert (tmp_path / 'visit-audio' / saved['audio_path']).read_bytes() == b'synthetic audio'
    else:
        assert saved['audio_status'] == 'none' and saved['audio_path'] == ''
        assert list((tmp_path / 'visit-audio').iterdir()) == []
    stats = pool.get_stats()
    assert stats['pool_available'] == stats['pool_size'] and stats['requests_waiting'] == 0
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('operation', ['create', 'edit', 'upload'])
@pytest.mark.parametrize('applied', [False, True])
def test_failed_private_file_check_defers_cleanup_and_preserves_original_error(tmp_path, monkeypatch, request, caplog, storage, operation, applied):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    body = {'source':'recording', 'visited_at':'2026-10-31', 'text':'synthetic original private text'}
    other = client.post('/api/visits', json=body, headers={'x-user':'bob'}).json()
    item = client.post('/api/visits', json=body).json() if operation != 'create' else None
    directory = tmp_path / 'visit-audio'
    before_files = {path.name:path.read_bytes() for path in directory.iterdir()}
    with store.transaction('local', write=False) as tx:
        before = tx.list('local', 'visit')
    transaction = store.transaction
    primary = OperationalError('synthetic primary write failure')
    armed = True
    @contextmanager
    def unavailable(*args, **kwargs):
        nonlocal armed
        if not armed:
            raise OSError('synthetic-private-path-and-payload')
        inject = kwargs.get('write', True)
        with transaction(*args, **kwargs) as tx:
            yield tx
            inject = inject and (operation != 'upload' or bool(tx.get('local', 'visit', item['id']).get('audio_path')))
            if inject and not applied:
                armed = False
                raise primary
        if inject:
            armed = False
            raise primary
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    caplog.set_level('ERROR', logger='medvisit')
    with monkeypatch.context() as fault:
        fault.setattr(store, 'transaction', unavailable)
        with pytest.raises(OperationalError, match='synthetic primary write failure') as failed:
            if operation == 'create':
                client.post('/api/visits', json=body)
            elif operation == 'edit':
                client.put('/api/visits/' + item['id'], json={'visited_at':'2026-10-31', 'text':'replacement', 'version':item['version']})
            else:
                client.post('/api/visits/' + item['id'] + '/audio', content=b'synthetic audio',
                    headers={'content-type':'audio/wav', 'x-recording-authorized':'true'})
    assert failed.value is primary and not armed
    after_files = {path.name:path.read_bytes() for path in directory.iterdir()}
    created = set(after_files) - set(before_files)
    assert len(created) == 1, 'An unverifiable file must remain available for reconciliation'
    assert all(after_files[name] == content for name, content in before_files.items())
    assert [record.getMessage() for record in caplog.records if record.name == 'medvisit'] == ['visit_file_cleanup_failed error_type=OSError']
    assert 'synthetic-private-path-and-payload' not in caplog.text
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits' and 'POST' in route.methods)
    discard = next(cell.cell_contents for cell in endpoint.__closure__ if getattr(cell.cell_contents, '__name__', '') == 'discard_private')
    name = created.pop()
    discard(name, 'local')
    if applied:
        assert (directory / name).is_file()
        router.visit_cleanup('local')
        assert (directory / name).is_file()
    else:
        with store.transaction('local', write=False) as tx:
            assert tx.list('local', 'visit') == before
        assert {path.name:path.read_bytes() for path in directory.iterdir()} == before_files
    assert client.get('/api/visits/' + other['id'], headers={'x-user':'bob'}).json()['text'] == body['text']


@pytest.mark.parametrize('storage', ['file', 'postgres'])
def test_upload_exclusive_create_failure_preserves_existing_file(tmp_path, monkeypatch, request, storage):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    directory = tmp_path / 'visit-audio'
    directory.mkdir(mode=0o700)
    existing = directory / uuid4().hex
    existing.write_bytes(b'synthetic file owned by another upload')
    existing.chmod(0o600)
    monkeypatch.setattr('medvisit.visits.api.uuid4', lambda: SimpleNamespace(hex=existing.name))
    with pytest.raises(FileExistsError):
        client.post('/api/visits/' + item['id'] + '/audio', content=b'new synthetic audio',
            headers={'content-type':'audio/wav', 'x-recording-authorized':'true'})
    assert existing.read_bytes() == b'synthetic file owned by another upload'
    assert existing.stat().st_mode & 0o777 == 0o600 and list(directory.iterdir()) == [existing]
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert saved['audio_path'] == '' and saved['audio_status'] == 'none'


async def test_upload_discard_pool_exhaustion_preserves_file_and_event_loop(tmp_path, monkeypatch, postgres_store, caplog):
    app, router, store = make_app(tmp_path, pool=postgres_store.pool)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    transaction = store.transaction
    exhausted = threading.Event()
    primary = OperationalError('synthetic applied commit acknowledgement failure')
    armed = True
    with ExitStack() as held:
        @contextmanager
        def fail_after_commit(*args, **kwargs):
            nonlocal armed
            inject = armed and kwargs.get('write', True)
            with transaction(*args, **kwargs) as tx:
                yield tx
                inject = inject and bool(tx.get('local', 'visit', item['id']).get('audio_path'))
            if inject:
                armed = False
                for _ in range(postgres_store.pool.max_size):
                    held.enter_context(postgres_store.pool.connection())
                exhausted.set()
                raise primary
        caplog.set_level('ERROR', logger='medvisit')
        with monkeypatch.context() as fault:
            fault.setattr(store, 'transaction', fail_after_commit)
            loop = asyncio.get_running_loop()
            start = loop.time()
            task = asyncio.create_task(endpoint(item['id'], audio_request(), user={'id':'alice', 'workspace':'local', 'team':''}))
            gaps = []
            try:
                assert await asyncio.to_thread(exhausted.wait, 2)
                assert loop.time() - start < .5, 'Discard blocked the event loop'
                while not task.done():
                    stamp = loop.time()
                    await asyncio.sleep(.02)
                    gaps.append(loop.time() - stamp)
                    assert loop.time() - start < 17, 'Discard did not respect bounded pool timeout'
                elapsed = loop.time() - start
            finally:
                held.close()
                result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3))[0]
    assert result is primary and 4 <= elapsed < 17
    assert len(gaps) >= 20 and max(gaps) < .5
    assert [record.getMessage() for record in caplog.records if record.name == 'medvisit'] == ['visit_file_cleanup_failed error_type=PoolTimeout']
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    assert saved['audio_status'] == 'transcription_unavailable'
    path = tmp_path / 'visit-audio' / saved['audio_path']
    assert path.read_bytes() == b'synthetic audio'
    create = next(route.endpoint for route in router.routes if route.path == '/api/visits' and 'POST' in route.methods)
    discard = next(cell.cell_contents for cell in create.__closure__ if getattr(cell.cell_contents, '__name__', '') == 'discard_private')
    await asyncio.to_thread(discard, saved['audio_path'], 'local')
    assert path.read_bytes() == b'synthetic audio'
    stats = postgres_store.pool.get_stats()
    assert stats['pool_available'] == stats['pool_size'] and stats['requests_waiting'] == 0
    await router.visit_close()


def audio_request(content=b'synthetic audio'):
    async def receive():
        return {'type':'http.request', 'body':content, 'more_body':False}
    return Request({'type':'http', 'method':'POST', 'headers':[
        (b'content-type', b'audio/wav'), (b'x-recording-authorized', b'true')]}, receive)


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_upload_keeps_storage_and_response_reads_off_loop(tmp_path, monkeypatch, request, storage):
    from pathlib import Path
    import httpx
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        created = (await client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'synthetic private text'})).json()
        transaction, read_text = store.transaction, Path.read_text
        loop_thread = threading.get_ident()
        modes = []
        @contextmanager
        def off_loop(*args, **kwargs):
            assert threading.get_ident() != loop_thread, 'Upload storage blocked the event loop'
            assert current_role.get() == 'representative'
            modes.append(kwargs.get('write', True))
            with transaction(*args, **kwargs) as tx:
                yield tx
        def private_read(path, *args, **kwargs):
            if path.suffix == '.transcript':
                assert threading.get_ident() != loop_thread, 'Upload response read blocked the event loop'
            return read_text(path, *args, **kwargs)
        with monkeypatch.context() as checks:
            checks.setattr(store, 'transaction', off_loop)
            checks.setattr(Path, 'read_text', private_read)
            url = '/api/visits/' + created['id'] + '/audio'
            headers = {'content-type':'audio/wav', 'x-recording-authorized':'true'}
            assert (await client.post(url, content=b'synthetic', headers={**headers, 'x-user':'bob'})).status_code == 404
            response = await client.post(url, content=b'synthetic', headers=headers)
        assert response.status_code == 202 and response.json()['text'] == 'synthetic private text'
        assert modes == [True, True, True]
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_upload_cancellation_drains_audio_verification(tmp_path, monkeypatch, request, storage):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    paths = []
    def verify(path, content_type):
        paths.append(path)
        entered.set()
        try:
            assert release.wait(5)
            assert path.is_file(), 'Cancellation removed a file still used by the verifier'
            return 10.0
        finally:
            finished.set()
    monkeypatch.setattr('medvisit.visits.api.verify_audio', verify)
    user = {'id':'alice', 'workspace':'local', 'team':''}
    task = asyncio.create_task(endpoint(item['id'], audio_request(), user=user))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel(); await asyncio.sleep(0)
        task.cancel(); await asyncio.sleep(0)
        assert not task.done() and paths[0].is_file(), 'Upload abandoned its verification worker'
    finally:
        release.set()
        await asyncio.to_thread(finished.wait, 2)
        await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled() and not paths[0].exists()
    with store.transaction('local', write=False) as tx:
        assert tx.get('local', 'visit', item['id'])['audio_status'] == 'none'
    result = await endpoint(item['id'], audio_request(), user=user)
    assert result['audio_status'] == 'transcription_unavailable' and paths[1].is_file()
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('commit_fails', [False, True])
async def test_upload_cancellation_preserves_committed_audio(tmp_path, monkeypatch, request, storage, commit_fails):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    transaction = store.transaction
    entered, release = threading.Event(), threading.Event()
    @contextmanager
    def delayed(*args, **kwargs):
        with transaction(*args, **kwargs) as tx:
            yield tx
            if kwargs.get('write', True) and not entered.is_set() and tx.get('local', 'visit', item['id']).get('audio_path'):
                entered.set()
                assert release.wait(5)
                if commit_fails:
                    raise RuntimeError('synthetic upload commit failure')
    user = {'id':'alice', 'workspace':'local', 'team':''}
    with monkeypatch.context() as changes:
        changes.setattr(store, 'transaction', delayed)
        task = asyncio.create_task(endpoint(item['id'], audio_request(), user=user))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel(); await asyncio.sleep(0)
            task.cancel(); await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(RuntimeError if commit_fails else asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    files = list((tmp_path / 'visit-audio').iterdir())
    if commit_fails:
        assert saved['audio_status'] == 'none' and files == []
    else:
        assert saved['audio_status'] == 'transcription_unavailable'
        assert len(files) == 1 and files[0].name == saved['audio_path']
        assert files[0].read_bytes() == b'synthetic audio'
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_concurrent_uploads_keep_only_one_authorized_file(tmp_path, monkeypatch, request, storage):
    from fastapi import HTTPException
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    barrier = threading.Barrier(2)
    def verify(*args):
        barrier.wait(timeout=5)
        return 10.0
    monkeypatch.setattr('medvisit.visits.api.verify_audio', verify)
    user = {'id':'alice', 'workspace':'local', 'team':''}
    payloads = [b'first synthetic audio', b'second synthetic audio']
    results = await asyncio.gather(*(endpoint(item['id'], audio_request(payload), user=user) for payload in payloads), return_exceptions=True)
    assert sum(isinstance(result, dict) for result in results) == 1
    assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in results) == 1
    winner = next(index for index, result in enumerate(results) if isinstance(result, dict))
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    files = list((tmp_path / 'visit-audio').iterdir())
    assert len(files) == 1 and files[0].name == saved['audio_path']
    assert files[0].read_bytes() == payloads[winner]
    await router.visit_close()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
def test_cleanup_reclaims_only_unreferenced_regular_raw_audio(tmp_path, request, storage):
    import os
    import subprocess
    import sys
    pytest.importorskip('fcntl')
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    directory = tmp_path / 'visit-audio'
    directory.mkdir(mode=0o700)
    old = (datetime.now(timezone.utc) - timedelta(days=31)).timestamp()
    committed = []
    for workspace, owner in [('local', 'alice'), ('local', 'bob'), ('legacy-workspace', 'legacy-owner')]:
        path = directory / uuid4().hex
        path.write_bytes(('synthetic committed ' + owner).encode())
        path.chmod(0o600)
        os.utime(path, (old, old))
        with store.transaction(workspace) as tx:
            item = tx.create(workspace, 'visit', {'owner_id':owner, 'source':'recording', 'audio_path':path.name,
                'audio_status':'transcription_unavailable', 'audio_uploaded_at':datetime.now(timezone.utc).isoformat(),
                'audio_type':'audio/wav', 'transcript_file':''})
        committed.append((workspace, item, path, path.read_bytes(), path.stat().st_mtime))
    orphans = [directory / uuid4().hex for _ in range(2)]
    for path in orphans:
        path.write_bytes(b'synthetic uncommitted raw audio')
    os.utime(orphans[1], (old, old))
    outside = tmp_path / 'outside-control'
    outside.write_bytes(b'synthetic outside content')
    symlink = directory / uuid4().hex
    symlink.symlink_to(outside)
    unmanaged = directory / 'legacy-unmanaged-audio.wav'
    unmanaged.write_bytes(b'synthetic unmanaged file')
    subdirectory = directory / uuid4().hex
    subdirectory.mkdir()
    active = directory / uuid4().hex
    active.write_bytes(b'synthetic active upload')
    script = "import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()"
    process = subprocess.Popen([sys.executable, '-c', script, str(active)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == 'ready'
        router.visit_cleanup('local')
        assert all(not path.exists() for path in orphans)
        assert active.read_bytes() == b'synthetic active upload'
        assert symlink.is_symlink() and outside.read_bytes() == b'synthetic outside content'
        assert unmanaged.read_bytes() == b'synthetic unmanaged file' and subdirectory.is_dir()
        for workspace, item, path, content, mtime in committed:
            assert path.read_bytes() == content and path.stat().st_mode & 0o777 == 0o600
            assert path.stat().st_mtime == mtime
            with store.transaction(workspace, write=False) as tx:
                assert tx.get(workspace, 'visit', item['id']) == item
    finally:
        process.stdin.close()
        process.wait(timeout=5)
        process.stdout.close()
    assert process.returncode == 0
    router.visit_cleanup('local')
    assert not active.exists()


@pytest.mark.parametrize('file_type', ['audio', 'transcript'])
@pytest.mark.parametrize('cancel_cleanup', [False, True])
@pytest.mark.parametrize('commit', [False, True])
@pytest.mark.parametrize('repeatable_read', [False, True])
async def test_cleanup_waits_for_uncertain_private_file_commit(tmp_path, postgres_store, database_url, commit, repeatable_read, cancel_cleanup, file_type):
    import json
    import time
    if file_type == 'audio':
        pytest.importorskip('fcntl')
    pool = postgres_store.pool
    with ExitStack() as connections:
        for _ in range(pool.max_size):
            connection = connections.enter_context(pool.connection())
            connection.isolation_level = IsolationLevel.REPEATABLE_READ if repeatable_read else IsolationLevel.READ_COMMITTED
    app, router, store = make_app(tmp_path, pool=pool)
    directory = tmp_path / 'visit-audio'
    directory.mkdir()
    path = directory / (uuid4().hex + ('.transcript' if file_type == 'transcript' else ''))
    path.write_bytes(json.dumps({'text':'synthetic pending transaction', 'segments':[]}).encode())
    path.chmod(0o600)
    context = store.transaction('local')
    tx = context.__enter__()
    item = tx.create('local', 'visit', {'owner_id':'alice', 'source':'recording',
        'audio_path':path.name if file_type == 'audio' else '', 'transcript_file':path.name if file_type == 'transcript' else '',
        'audio_status':'transcription_unavailable', 'audio_uploaded_at':datetime.now(timezone.utc).isoformat()})
    task = asyncio.create_task(router.visit_work(router.visit_cleanup, 'local'))
    def waiting_for_original_commit():
        with connect(database_url, autocommit=True) as observer:
            deadline = time.monotonic() + 2
            while not observer.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'").fetchone()[0]:
                assert time.monotonic() < deadline
                time.sleep(.005)
    cancelled = False
    try:
        await asyncio.to_thread(waiting_for_original_commit)
        if cancel_cleanup:
            task.cancel(); await asyncio.sleep(0)
            task.cancel(); await asyncio.sleep(0)
            cancelled = True
        assert not task.done() and path.is_file()
    finally:
        if commit:
            context.__exit__(None, None, None)
        else:
            error = OperationalError('synthetic original transaction rollback')
            context.__exit__(type(error), error, None)
        if cancelled:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 3)
        else:
            await asyncio.wait_for(task, 3)
    assert path.exists() is commit
    if commit:
        assert path.read_bytes() == json.dumps({'text':'synthetic pending transaction', 'segments':[]}).encode()
        assert path.stat().st_mode & 0o777 == 0o600
    with store.transaction('local', write=False) as tx:
        assert tx.get('local', 'visit', item['id']) == (item if commit else None)
    stats = pool.get_stats()
    assert stats['pool_available'] == stats['pool_size'] and stats['requests_waiting'] == 0


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('cancel', [False, True])
@pytest.mark.parametrize('phase', ['stream', 'verification'])
async def test_cleanup_preserves_active_verified_upload(tmp_path, monkeypatch, request, storage, cancel, phase):
    pytest.importorskip('fcntl')
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    entered, release = threading.Event(), threading.Event()
    paths = []
    def verify(path, content_type):
        paths.append(path)
        if phase == 'verification':
            entered.set()
            assert release.wait(5)
        return 10.0
    monkeypatch.setattr('medvisit.visits.api.verify_audio', verify)
    stream_entered, stream_release = asyncio.Event(), asyncio.Event()
    messages = 0
    async def receive():
        nonlocal messages
        messages += 1
        if messages == 1:
            return {'type':'http.request', 'body':b'synthetic ', 'more_body':True}
        stream_entered.set()
        await stream_release.wait()
        return {'type':'http.request', 'body':b'audio', 'more_body':False}
    incoming = audio_request()
    if phase == 'stream':
        incoming = Request(incoming.scope, receive)
    task = asyncio.create_task(endpoint(item['id'], incoming, user={'id':'alice', 'workspace':'local', 'team':''}))
    try:
        if phase == 'stream':
            await asyncio.wait_for(stream_entered.wait(), 2)
        else:
            assert await asyncio.to_thread(entered.wait, 2)
        if cancel:
            task.cancel(); await asyncio.sleep(0)
            task.cancel(); await asyncio.sleep(0)
            if phase == 'verification':
                assert not task.done()
        await asyncio.wait_for(asyncio.to_thread(router.visit_cleanup, 'local'), 2)
        if phase == 'verification':
            assert paths[0].read_bytes() == b'synthetic audio'
        elif not cancel:
            assert len(list((tmp_path / 'visit-audio').iterdir())) == 1
    finally:
        release.set()
        stream_release.set()
        result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3))[0]
    if cancel:
        assert isinstance(result, asyncio.CancelledError)
        assert list((tmp_path / 'visit-audio').iterdir()) == []
        with store.transaction('local', write=False) as tx:
            assert tx.get('local', 'visit', item['id'])['audio_path'] == ''
    else:
        assert result['audio_status'] == 'transcription_unavailable'
        router.visit_cleanup('local')
        audio = client.get('/api/visits/' + item['id'] + '/audio')
        assert audio.status_code == 200 and audio.content == b'synthetic audio'


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('failure', ['snapshot', 'unlink'])
@pytest.mark.parametrize('file_type', ['audio', 'transcript'])
def test_private_cleanup_failure_preserves_file_and_recovers(tmp_path, monkeypatch, request, storage, failure, file_type):
    fcntl = pytest.importorskip('fcntl')
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    directory = tmp_path / 'visit-audio'
    directory.mkdir()
    path = directory / (uuid4().hex + ('.transcript' if file_type == 'transcript' else ''))
    path.write_bytes(b'synthetic orphan')
    transaction = store.transaction
    @contextmanager
    def unavailable(*args, **kwargs):
        if not kwargs.get('write', True):
            raise OperationalError('synthetic reference snapshot failure')
        with transaction(*args, **kwargs) as tx:
            yield tx
    unlink = type(path).unlink
    def failed_unlink(candidate, *args, **kwargs):
        if candidate == path:
            raise OSError('synthetic orphan unlink failure')
        return unlink(candidate, *args, **kwargs)
    with monkeypatch.context() as fault:
        if failure == 'snapshot':
            fault.setattr(store, 'transaction', unavailable)
        else:
            fault.setattr(type(path), 'unlink', failed_unlink)
        with pytest.raises(OperationalError if failure == 'snapshot' else OSError):
            router.visit_cleanup('local')
    assert path.read_bytes() == b'synthetic orphan'
    with path.open('rb') as output:
        fcntl.flock(output, fcntl.LOCK_EX | fcntl.LOCK_NB)
    router.visit_cleanup('local')
    assert not path.exists()


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('lock_fails', [False, True])
@pytest.mark.parametrize('cancel', [False, True])
async def test_audio_creation_ownership_survives_concurrent_cleanup(tmp_path, monkeypatch, request, storage, lock_fails, cancel):
    import os
    from pathlib import Path
    fcntl = pytest.importorskip('fcntl')
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    endpoint = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}/audio' and 'POST' in route.methods)
    entered, release = threading.Event(), threading.Event()
    owned, closed = [], []
    original_open, original_close, original_flock = os.open, os.close, fcntl.flock
    def paused_open(path, flags, *args, **kwargs):
        fd = original_open(path, flags, *args, **kwargs)
        if flags & os.O_EXCL and Path(path).parent == tmp_path / 'visit-audio':
            owned.append((fd, os.fstat(fd).st_ino))
            entered.set()
            assert release.wait(5)
        return fd
    def checked_close(fd):
        is_owned = (fd, os.fstat(fd).st_ino) in owned
        original_close(fd)
        if is_owned:
            closed.append(fd)
    injected = False
    def failed_lock(fd, operation):
        nonlocal injected
        if lock_fails and not injected and owned and fd == owned[0][0]:
            injected = True
            raise OSError('synthetic upload lease failure')
        return original_flock(fd, operation)
    monkeypatch.setattr('medvisit.visits.api.os.open', paused_open)
    monkeypatch.setattr('medvisit.visits.api.os.close', checked_close)
    if lock_fails:
        monkeypatch.setattr('medvisit.visits.api.fcntl.flock', failed_lock)
    task = asyncio.create_task(endpoint(item['id'], audio_request(), user={'id':'alice', 'workspace':'local', 'team':''}))
    cleanup = None
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        cleanup = asyncio.create_task(asyncio.to_thread(router.visit_cleanup, 'local'))
        await asyncio.sleep(.05)
        if cancel:
            task.cancel(); await asyncio.sleep(0)
            task.cancel(); await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
        result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3))[0]
        if cleanup:
            await asyncio.wait_for(cleanup, 3)
    assert len(owned) == 1
    assert closed == [owned[0][0]]
    with store.transaction('local', write=False) as tx:
        saved = tx.get('local', 'visit', item['id'])
    if lock_fails or cancel:
        assert isinstance(result, OSError if lock_fails else asyncio.CancelledError)
        assert list((tmp_path / 'visit-audio').iterdir()) == [] and saved['audio_path'] == ''
    else:
        assert result['audio_status'] == 'transcription_unavailable'
        assert (tmp_path / 'visit-audio' / saved['audio_path']).read_bytes() == b'synthetic audio'


def test_upload_without_posix_locks_preserves_existing_cleanup_behavior(tmp_path, monkeypatch):
    app, router, store = make_app(tmp_path)
    monkeypatch.setattr('medvisit.visits.api.fcntl', None)
    monkeypatch.setattr('medvisit.visits.api.verify_audio', lambda *args: 10.0)
    client = TestClient(app)
    item = client.post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31'}).json()
    assert client.post('/api/visits/' + item['id'] + '/audio', content=b'synthetic audio',
        headers={'content-type':'audio/wav', 'x-recording-authorized':'true'}).status_code == 202
    orphan = tmp_path / 'visit-audio' / uuid4().hex
    orphan.write_bytes(b'synthetic unmanaged lease platform')
    router.visit_cleanup('local')
    assert orphan.read_bytes() == b'synthetic unmanaged lease platform'
    assert client.get('/api/visits/' + item['id'] + '/audio').content == b'synthetic audio'


@pytest.mark.parametrize('file_type', ['audio', 'transcript'])
async def test_private_cleanup_pool_exhaustion_preserves_orphan_and_event_loop(tmp_path, postgres_store, file_type):
    if file_type == 'audio':
        pytest.importorskip('fcntl')
    from psycopg_pool import PoolTimeout
    app, router, store = make_app(tmp_path, pool=postgres_store.pool)
    directory = tmp_path / 'visit-audio'
    directory.mkdir()
    path = directory / (uuid4().hex + ('.transcript' if file_type == 'transcript' else ''))
    path.write_bytes(b'synthetic unverified orphan')
    loop = asyncio.get_running_loop()
    with ExitStack() as held:
        for _ in range(postgres_store.pool.max_size - 1):
            held.enter_context(postgres_store.pool.connection())
        started = loop.time()
        task = asyncio.create_task(router.visit_work(router.visit_cleanup, 'local'))
        gaps = []
        while not task.done():
            stamp = loop.time()
            await asyncio.sleep(.02)
            gaps.append(loop.time() - stamp)
            assert loop.time() - started < 17
        with pytest.raises(PoolTimeout):
            await task
        assert 4 <= loop.time() - started < 17
        assert len(gaps) >= 20 and max(gaps) < .5
        assert path.read_bytes() == b'synthetic unverified orphan'
    await router.visit_work(router.visit_cleanup, 'local')
    assert not path.exists()
    stats = postgres_store.pool.get_stats()
    assert stats['pool_available'] == stats['pool_size'] and stats['requests_waiting'] == 0


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('without_posix_locks', [False, True])
def test_cleanup_preserves_unexpired_transcripts_across_workspaces(tmp_path, monkeypatch, request, storage, without_posix_locks):
    from medvisit.visits.api import CreateVisit
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    if without_posix_locks:
        monkeypatch.setattr('medvisit.visits.api.fcntl', None)
    client = TestClient(app)
    body = {'source':'recording', 'visited_at':'2026-10-31', 'text':'Synthetic private reference text'}
    alice = client.post('/api/visits', json=body).json()
    bob = client.post('/api/visits', json=body, headers={'x-user':'bob'}).json()
    create = next(route.endpoint for route in router.routes if route.path == '/api/visits' and 'POST' in route.methods)
    legacy_user = {'id':'legacy-owner', 'workspace':'legacy-workspace', 'team':''}
    legacy = create(CreateVisit(**body), user=legacy_user)
    private_write = next(c.cell_contents for c in create.__closure__ if getattr(c.cell_contents, '__name__', '') == 'private_write')
    directory = tmp_path / 'visit-audio'
    rows = []
    for workspace, item in [('local', alice), ('local', bob), ('legacy-workspace', legacy)]:
        with store.transaction(workspace, write=False) as tx:
            saved = tx.get(workspace, 'visit', item['id'])
        path = directory / saved['transcript_file']
        rows.append((workspace, saved, path, path.read_bytes()))
    orphan = directory / private_write({'text':'Synthetic orphan text', 'segments':[]})
    unmanaged = directory / 'manual-note.transcript'
    unmanaged.write_bytes(b'synthetic unmanaged note')
    for _ in range(2):
        router.visit_cleanup('local')
        assert not orphan.exists() and unmanaged.read_bytes() == b'synthetic unmanaged note'
        for workspace, saved, path, content in rows:
            assert path.is_file() and path.read_bytes() == content
            assert path.stat().st_mode & 0o777 == 0o600
            with store.transaction(workspace, write=False) as tx:
                assert tx.get(workspace, 'visit', saved['id']) == saved
    assert client.get('/api/visits/' + alice['id']).json()['text'] == body['text']
    assert client.get('/api/visits/' + bob['id']).status_code == 404
    assert client.get('/api/visits/' + bob['id'], headers={'x-user':'bob'}).json()['text'] == body['text']
    detail = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}' and 'GET' in route.methods)
    assert detail(legacy['id'], user=legacy_user)['text'] == body['text']


@pytest.mark.parametrize('storage', ['file', 'postgres'])
@pytest.mark.parametrize('workspace', ['local', 'legacy-workspace'])
@pytest.mark.parametrize('expired_by', ['upload', 'confirmation'])
@pytest.mark.parametrize('already_deleted', [False, True])
def test_cleanup_enforces_private_retention_and_reconciles_deleted_rows(tmp_path, request, storage, workspace, expired_by, already_deleted):
    import hashlib
    from medvisit.visits.api import CreateVisit
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store = make_app(tmp_path, pool=pool)
    user = {'id':'alice', 'workspace':workspace, 'team':''}
    create = next(route.endpoint for route in router.routes if route.path == '/api/visits' and 'POST' in route.methods)
    item = create(CreateVisit(source='recording', visited_at='2026-10-31', text='Synthetic private transcript'), user=user)
    directory = tmp_path / 'visit-audio'
    raw = directory / uuid4().hex
    raw.write_bytes(b'synthetic expired raw')
    raw.chmod(0o600)
    provider_copy = directory / (raw.name + '_' + uuid4().hex + '.provider.ogg')
    provider_copy.write_bytes(b'synthetic expired copy')
    provider_copy.chmod(0o600)
    with store.transaction(workspace) as tx:
        old = tx.get(workspace, 'visit', item['id'])
        before = tx.update(workspace, 'visit', item['id'], {**old, 'audio_path':raw.name,
            'audio_status':'deleted' if already_deleted else 'transcribed',
            'audio_uploaded_at':(datetime.now(timezone.utc) - timedelta(days=31 if expired_by == 'upload' else 1)).isoformat(),
            'confirmed_at':(datetime.now(timezone.utc) - timedelta(days=8)).isoformat() if expired_by == 'confirmation' else None,
            'provider_token_hash':hashlib.sha256(b'not-a-live-token').hexdigest(),
            'provider_token_expires':(datetime.now(timezone.utc) + timedelta(hours=4)).isoformat(),
            'text':'Synthetic legacy private text', 'transcription_text':'Synthetic raw transcript',
            'segments':[{'text':'Synthetic private segment'}], 'redacted_text':'Synthetic confirmed safe text',
            'review':{'decision':'needs_evidence', 'reason':'Synthetic safe review'}}, old['version'])
    transcript = directory / before['transcript_file']
    from concurrent.futures import ThreadPoolExecutor
    barrier = threading.Barrier(2)
    def cleanup():
        barrier.wait(timeout=3)
        router.visit_cleanup('local')
    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(cleanup) for _ in range(2)]
        for future in futures:
            future.result(timeout=5)
    assert not raw.exists() and not transcript.exists() and not provider_copy.exists()
    with store.transaction(workspace, write=False) as tx:
        saved = tx.get(workspace, 'visit', item['id'])
        audits = [r for r in tx.list(workspace, 'audit') if r['action'] == 'visit.audio_delete' and r['object_id'] == item['id']]
    assert saved['audio_status'] == 'deleted'
    assert all(not saved.get(key) for key in ('audio_path', 'transcript_file', 'provider_token_hash', 'provider_token_expires'))
    assert all(key not in saved for key in ('text', 'transcription_text', 'segments'))
    assert saved['version'] == before['version'] + 1
    for key in ('created_at', 'owner_id', 'audio_uploaded_at', 'confirmed_at', 'redacted_text', 'review'):
        assert saved[key] == before[key]
    assert len(audits) == 1 and audits[0]['actor_id'] == 'system'
    detail = next(route.endpoint for route in router.routes if route.path == '/api/visits/{item_id}' and 'GET' in route.methods)
    assert detail(item['id'], user=user)['text'] == ''
    router.visit_cleanup('local')
    with store.transaction(workspace, write=False) as tx:
        assert tx.get(workspace, 'visit', item['id']) == saved
        assert len([r for r in tx.list(workspace, 'audit') if r['action'] == 'visit.audio_delete' and r['object_id'] == item['id']]) == 1
