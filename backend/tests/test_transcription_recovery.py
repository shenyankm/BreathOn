import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import logging
import sqlite3
from threading import Event
from uuid import uuid4
import wave

import httpx
import pytest
from fastapi.testclient import TestClient
from psycopg import OperationalError
from psycopg_pool import PoolTimeout

from test_visits import make_app
from test_storage import database_url, store as postgres_store


def configured(tmp_path, pool=None):
    app, router, store = make_app(tmp_path, pool=pool)
    settings = next(cell.cell_contents for cell in router.visit_run_job.__closure__ if hasattr(cell.cell_contents, 'records'))
    settings.asr_api_key, settings.origins = 'synthetic-key', ('https://example.test',)
    item = TestClient(app).post('/api/visits', json={'source':'recording', 'visited_at':'2026-10-31', 'text':'Synthetic original note'}).json()
    path = tmp_path/'visit-audio'/uuid4().hex
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(bytes(32000))
    path.chmod(0o600)
    with store.transaction('local') as tx:
        current = tx.get('local', 'visit', item['id'])
        item = tx.update('local', 'visit', item['id'], {**current, 'audio_path':path.name,
            'audio_type':'audio/wav', 'audio_duration':1, 'audio_status':'transcription_unavailable'}, current['version'])
    launch = next(cell.cell_contents for name, cell in zip(router.visit_recover.__code__.co_freevars, router.visit_recover.__closure__) if name == 'launch')
    tasks = next(cell.cell_contents for name, cell in zip(launch.__code__.co_freevars, launch.__closure__) if name == 'tasks')
    return app, router, store, item, tasks


@pytest.mark.parametrize('storage,error_class', [('file',sqlite3.OperationalError), ('postgres',OperationalError), ('postgres',PoolTimeout)])
@pytest.mark.parametrize('phase,submit_timeout', [('initial_read',False),('begin',False),('read',False),('persist',False),('finish',False),('read',True)])
async def test_transient_transcription_storage_recovers_without_replaying_provider(tmp_path, monkeypatch, request, caplog, storage, error_class, phase, submit_timeout):
    pool = request.getfixturevalue('postgres_store').pool if storage == 'postgres' else None
    app, router, store, item, tasks = configured(tmp_path, pool)
    first_error, retrying, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    transaction, sleep = store.transaction, asyncio.sleep
    real_client = httpx.AsyncClient
    reads, writes, armed = 0, 0, True
    calls, seen = [], []
    error = error_class('synthetic-private-database-details')
    caplog.set_level(logging.INFO, logger='medvisit')

    @contextmanager
    def fail_once(*args, **kwargs):
        nonlocal reads, writes, armed
        write = kwargs.get('write', True)
        if write: writes += 1
        else: reads += 1
        inject = armed and ((phase == 'initial_read' and not write and reads == 1)
            or (phase == 'begin' and write and writes == 2) or (phase == 'read' and not write and reads == 2)
            or (phase in ('persist','finish') and write and writes == 3))
        if inject:
            armed = False
            seen.extend(list(tasks))
            loop.call_soon_threadsafe(first_error.set)
            raise error
        with transaction(*args, **kwargs) as tx:
            yield tx

    async def clock(seconds):
        if seconds != 15:
            return await sleep(seconds)
        retrying.set()
        await release.wait()

    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            action = url.rsplit('/', 1)[-1]
            calls.append((action, kwargs['headers']['X-Api-Request-Id']))
            if action == 'submit' and submit_timeout:
                raise httpx.ReadTimeout('synthetic ambiguous accepted submit')
            return httpx.Response(200, headers={'X-Api-Status-Code':'40000000' if action == 'query' and phase == 'finish' else '20000000'},
                json={'result':{'text':'Synthetic first result', 'utterances':[{'text':'Synthetic segment',
                    'start_time':0,'end_time':1000,'additions':{'speaker':'1'}}]}})

    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
    monkeypatch.setattr('medvisit.visits.api.asyncio.sleep', clock)
    monkeypatch.setattr(store, 'transaction', fail_once)
    async with real_client(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        try:
            response = await client.post(f'/api/visits/{item["id"]}/transcription')
            assert response.status_code == 202
            job_id = response.json()['transcription_job_id']
            await asyncio.wait_for(first_error.wait(), 2)
            await asyncio.wait_for(retrying.wait(), .5)
            assert len(seen) == 1 and not seen[0].done()
            with transaction('local', write=False) as tx:
                failed = tx.get('local', 'visit', item['id'])
            assert failed['audio_status'] == ('queued' if phase in ('initial_read','begin') else 'transcribing')
            assert 'transcription_text' not in failed
            if phase in ('initial_read','begin'):
                assert calls == []
            release.set()
            assert await asyncio.wait_for(asyncio.gather(*seen), 3) == [None]
            result = (await client.get(f'/api/visits/{item["id"]}')).json()
            assert result['audio_status'] == ('transcription_failed' if phase == 'finish' else 'transcribed')
            if phase != 'finish':
                assert result['text'] == 'Synthetic original note' and result['transcription_text'] == 'Synthetic first result'
                assert result['segments'][0]['speaker_id'] == '1'
            assert calls == [('submit',job_id), ('query',job_id)]
            messages = [record.getMessage() for record in caplog.records if record.name == 'medvisit']
            assert sum('storage_failed' in text for text in messages) == 1
            assert sum('storage_recovered' in text for text in messages) == 1
            assert str(error) not in caplog.text
            assert not tasks
        finally:
            release.set()
            await router.visit_close()
            await asyncio.gather(*seen, return_exceptions=True)


async def test_fatal_transcription_task_error_is_observed_without_private_details(tmp_path, monkeypatch, caplog):
    app, router, store, item, tasks = configured(tmp_path)
    real_client = httpx.AsyncClient
    entered = asyncio.Event()
    error = RuntimeError('synthetic-private-provider-details')
    seen = []
    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            if url.endswith('/query'):
                seen.append(asyncio.current_task())
                entered.set()
                raise error
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'})
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
    caplog.set_level(logging.ERROR, logger='medvisit')
    async with real_client(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        try:
            response = await client.post(f'/api/visits/{item["id"]}/transcription')
            assert response.status_code == 202
            await asyncio.wait_for(entered.wait(), 2)
            assert await asyncio.gather(*seen, return_exceptions=True) == [error]
            await asyncio.sleep(0)
            assert not tasks
            messages = [r.getMessage() for r in caplog.records if r.name == 'medvisit']
            assert messages == [f'visit_transcription_job_failed job_id={response.json()["transcription_job_id"]} error_type=RuntimeError']
            assert str(error) not in caplog.text
        finally:
            await router.visit_close()


@pytest.mark.parametrize('applied', [False, True])
@pytest.mark.parametrize('expired', [False, True])
async def test_begin_retry_keeps_one_submit_and_renews_expired_lease(tmp_path, monkeypatch, applied, expired):
    app, router, store, item, tasks = configured(tmp_path)
    real_client = httpx.AsyncClient
    sleep, transaction = asyncio.sleep, store.transaction
    first_error, retrying, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    writes = 0
    calls = []
    @contextmanager
    def fail(*args, **kwargs):
        nonlocal writes
        if kwargs.get('write', True): writes += 1
        inject = kwargs.get('write', True) and writes == 2
        with transaction(*args, **kwargs) as tx:
            yield tx
            if inject and not applied:
                loop.call_soon_threadsafe(first_error.set)
                raise OperationalError('synthetic begin rollback')
        if inject:
            loop.call_soon_threadsafe(first_error.set)
            raise OperationalError('synthetic begin acknowledgement lost')
    async def clock(seconds):
        if seconds != 15: return await sleep(seconds)
        retrying.set()
        await release.wait()
    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            action = url.rsplit('/', 1)[-1]
            calls.append((action, kwargs['headers']['X-Api-Request-Id']))
            if action == 'submit':
                with transaction('local', write=False) as tx:
                    active = tx.get('local', 'visit', item['id'])
                assert datetime.fromisoformat(active['provider_token_expires']) > datetime.now(timezone.utc) + timedelta(hours=3, minutes=59)
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'Synthetic result','utterances':[]}})
    monkeypatch.setattr(store, 'transaction', fail)
    monkeypatch.setattr('medvisit.visits.api.asyncio.sleep', clock)
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
    async with real_client(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        try:
            response = await client.post(f'/api/visits/{item["id"]}/transcription')
            assert response.status_code == 202
            await asyncio.wait_for(first_error.wait(), 2)
            await asyncio.wait_for(retrying.wait(), .5)
            assert calls == []
            with transaction('local') as tx:
                failed = tx.get('local', 'visit', item['id'])
                assert failed['audio_status'] == ('transcribing' if applied else 'queued')
                if expired:
                    failed = tx.update('local', 'visit', item['id'], {**failed,
                        'provider_token_expires':(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()}, failed['version'])
            release.set()
            await asyncio.wait_for(asyncio.gather(*list(tasks)), 3)
            result = (await client.get(f'/api/visits/{item["id"]}')).json()
            assert result['audio_status'] == 'transcribed'
            assert result['version'] == failed['version'] + (1 if applied and not expired else 2)
            assert calls == [('submit',response.json()['transcription_job_id']), ('query',response.json()['transcription_job_id'])]
        finally:
            release.set()
            await router.visit_close()


@pytest.mark.parametrize('error_class', [sqlite3.OperationalError, OperationalError, PoolTimeout])
async def test_cancellation_keeps_original_storage_error_and_thread_guard(tmp_path, monkeypatch, error_class):
    app, router, store, item, tasks = configured(tmp_path)
    real_client = httpx.AsyncClient
    transaction = store.transaction
    entered, release = Event(), Event()
    writes = 0
    seen, calls = [], []
    error = error_class('synthetic cancelled storage failure')
    @contextmanager
    def held(*args, **kwargs):
        nonlocal writes
        if kwargs.get('write', True): writes += 1
        inject = kwargs.get('write', True) and writes == 3
        with transaction(*args, **kwargs) as tx:
            yield tx
            if inject:
                seen.extend(list(tasks))
                entered.set()
                assert release.wait(5)
                raise error
    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            calls.append(url.rsplit('/',1)[-1])
            return httpx.Response(200, headers={'X-Api-Status-Code':'20000000'}, json={'result':{'text':'Synthetic result','utterances':[]}})
    monkeypatch.setattr(store, 'transaction', held)
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient', Provider)
    async with real_client(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        try:
            assert (await client.post(f'/api/visits/{item["id"]}/transcription')).status_code == 202
            assert await asyncio.to_thread(entered.wait, 2)
            for _ in range(2):
                seen[0].cancel()
                await asyncio.sleep(.01)
            slot = next(c.cell_contents for c in router.visit_run_job.__closure__ if isinstance(c.cell_contents,asyncio.Semaphore))
            assert not seen[0].done() and slot.locked()
            release.set()
            assert await asyncio.wait_for(asyncio.gather(*seen, return_exceptions=True), 3) == [error]
            assert not slot.locked() and not tasks
            assert calls == ['submit','query']
            with transaction('local', write=False) as tx:
                failed = tx.get('local','visit',item['id'])
            assert failed['audio_status'] == 'transcribing'
            assert len(list((tmp_path/'visit-audio').glob('*.transcript'))) == 1
        finally:
            release.set()
            await router.visit_close()
            await asyncio.gather(*seen,return_exceptions=True)


@pytest.mark.parametrize('stop', ['cancel','close'])
async def test_storage_backoff_stops_without_late_retry(tmp_path, monkeypatch, stop):
    app, router, store, item, tasks = configured(tmp_path)
    real_client = httpx.AsyncClient
    transaction, sleep = store.transaction, asyncio.sleep
    retrying, release = asyncio.Event(), asyncio.Event()
    errors, seen, calls = [], [], []
    @contextmanager
    def fail_read(*args, **kwargs):
        if not kwargs.get('write', True) and not errors:
            errors.append(1)
            seen.extend(list(tasks))
            raise sqlite3.OperationalError('synthetic locked database')
        with transaction(*args, **kwargs) as tx: yield tx
    async def clock(seconds):
        if seconds != 15: return await sleep(seconds)
        retrying.set()
        await release.wait()
    class Provider:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            calls.append(1)
            raise AssertionError('No submit may escape cancelled initial storage recovery')
    monkeypatch.setattr(store,'transaction',fail_read)
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient',Provider)
    monkeypatch.setattr('medvisit.visits.api.asyncio.sleep',clock)
    async with real_client(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
        try:
            assert (await client.post(f'/api/visits/{item["id"]}/transcription')).status_code == 202
            await asyncio.wait_for(retrying.wait(),.5)
            if stop == 'cancel':
                for _ in range(2): seen[0].cancel();await sleep(0)
            else:
                await asyncio.wait_for(router.visit_close(),1)
            result, = await asyncio.gather(*seen,return_exceptions=True)
            assert isinstance(result,asyncio.CancelledError)
            release.set();await sleep(.01)
            assert errors == [1] and calls == [] and not tasks
        finally:
            release.set()
            await router.visit_close()
            await asyncio.gather(*seen,return_exceptions=True)


async def test_query_budget_exhaustion_recovers_its_final_state_write(tmp_path,monkeypatch):
    app,router,store,item,tasks=configured(tmp_path)
    real_client=httpx.AsyncClient
    transaction,sleep=store.transaction,asyncio.sleep
    loop=asyncio.get_running_loop()
    failed,retrying,release=asyncio.Event(),asyncio.Event(),asyncio.Event()
    writes=0;calls=[];seen=[]
    @contextmanager
    def fail_final(*args,**kwargs):
        nonlocal writes
        if kwargs.get('write',True):writes+=1
        if kwargs.get('write',True) and writes==3:
            seen.extend(list(tasks));loop.call_soon_threadsafe(failed.set)
            raise sqlite3.OperationalError('synthetic failed timeout state write')
        with transaction(*args,**kwargs) as tx:yield tx
    async def clock(seconds):
        if seconds != 15:return await sleep(seconds)
        if not failed.is_set():return await sleep(0)
        retrying.set();await release.wait()
    class Provider:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def post(self,url,**kwargs):
            action=url.rsplit('/',1)[-1];calls.append(action)
            return httpx.Response(200,headers={'X-Api-Status-Code':'20000000' if action=='submit' else '20000001'})
    monkeypatch.setattr(store,'transaction',fail_final)
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient',Provider)
    monkeypatch.setattr('medvisit.visits.api.asyncio.sleep',clock)
    async with real_client(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
        try:
            assert (await client.post(f'/api/visits/{item["id"]}/transcription')).status_code==202
            await asyncio.wait_for(failed.wait(),10)
            await asyncio.wait_for(retrying.wait(),.5)
            assert calls.count('submit')==1 and calls.count('query')==720 and not seen[0].done()
            release.set();assert await asyncio.wait_for(asyncio.gather(*seen),3)==[None]
            result=(await client.get(f'/api/visits/{item["id"]}')).json()
            assert result['audio_status']=='transcription_interrupted'
            assert calls.count('submit')==1 and calls.count('query')==720 and not tasks
        finally:
            release.set();await router.visit_close();await asyncio.gather(*seen,return_exceptions=True)


async def test_repeated_result_write_errors_keep_one_task_and_bounded_logs(tmp_path,monkeypatch,caplog):
    app,router,store,item,tasks=configured(tmp_path)
    real_client=httpx.AsyncClient
    transaction,sleep=store.transaction,asyncio.sleep
    writes=0;remaining=4;seen=[];calls=[]
    @contextmanager
    def fail(*args,**kwargs):
        nonlocal writes,remaining
        if kwargs.get('write',True):writes+=1
        if kwargs.get('write',True) and writes>=3 and remaining:
            remaining-=1;seen.extend(list(tasks))
            raise sqlite3.OperationalError('synthetic-private-repeated-storage-details')
        with transaction(*args,**kwargs) as tx:yield tx
    async def clock(seconds):
        if seconds==15:
            assert len(tasks)==1
            return await sleep(0)
        return await sleep(seconds)
    class Provider:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def post(self,url,**kwargs):
            action=url.rsplit('/',1)[-1];calls.append(action)
            return httpx.Response(200,headers={'X-Api-Status-Code':'20000000'},json={'result':{'text':'Synthetic first completed result','utterances':[]}})
    monkeypatch.setattr(store,'transaction',fail)
    monkeypatch.setattr('medvisit.visits.api.httpx.AsyncClient',Provider)
    monkeypatch.setattr('medvisit.visits.api.asyncio.sleep',clock)
    caplog.set_level(logging.INFO,logger='medvisit')
    async with real_client(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
        try:
            assert (await client.post(f'/api/visits/{item["id"]}/transcription')).status_code==202
            async with asyncio.timeout(3):
                while tasks:await sleep(.001)
            assert remaining==0 and len(seen)==4 and len({id(task) for task in seen})==1
            assert await asyncio.gather(*set(seen))==[None]
            result=(await client.get(f'/api/visits/{item["id"]}')).json()
            assert result['audio_status']=='transcribed' and result['transcription_text']=='Synthetic first completed result'
            assert calls==['submit','query']
            messages=[r.getMessage() for r in caplog.records if r.name=='medvisit']
            assert sum('storage_failed' in message for message in messages)==1
            recovered=[message for message in messages if 'storage_recovered' in message]
            assert len(recovered)==1 and 'failures=4' in recovered[0]
            assert 'synthetic-private-repeated-storage-details' not in caplog.text
        finally:
            await router.visit_close()
            await asyncio.gather(*set(seen),return_exceptions=True)
