import asyncio
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import sqlite3
from unittest.mock import AsyncMock, Mock, patch
from threading import Event
from types import SimpleNamespace

from fastapi import FastAPI, Request
from psycopg import OperationalError, connect
from starlette.websockets import WebSocketDisconnect
import pytest

from conftest import LocalClient
from medvisit.api.app import create_app
from medvisit.api.middleware import ApiMiddleware
from medvisit.platform.api import platform_router
from medvisit.storage.records import FileRecords
from medvisit.visits.api import visits_router
from medvisit.voice.protocol import BridgeError
from test_bridge import ORIGIN, receive_until, settings
from test_storage import database_url


async def test_actual_body_limit_prevents_parsing_understated_stream(monkeypatch):
    monkeypatch.setattr('medvisit.api.middleware.JSON_LIMIT', 8)
    called = False
    async def endpoint(scope, receive, send):
        nonlocal called
        called = True
    frames = iter([{'type':'http.request', 'body':b'12345', 'more_body':True},
                   {'type':'http.request', 'body':b'67890', 'more_body':False}])
    async def receive():
        return next(frames)
    sent = []
    async def send(message):
        sent.append(message)
    scope = {'type':'http', 'method':'POST', 'path':'/api/import',
        'headers':[(b'origin', b'http://localhost'), (b'content-length', b'1'), (b'content-type', b'application/json')]}
    await ApiMiddleware(endpoint, ('http://localhost',))(scope, receive, send)
    assert not called and sent[0]['status'] == 413
    assert dict(sent[0]['headers'])[b'cache-control'] == b'no-store'


async def test_slow_body_times_out_before_the_handler_runs(monkeypatch):
    monkeypatch.setattr('medvisit.api.middleware.BODY_TIMEOUT_SECONDS', .01)
    endpoint = AsyncMock()
    async def receive():
        await asyncio.sleep(.1)
        return {'type':'http.request', 'body':b'{}', 'more_body':False}
    send = AsyncMock()
    scope = {'type':'http', 'method':'POST', 'path':'/api/import',
        'headers':[(b'origin', b'http://localhost'), (b'content-length', b'2')]}
    await ApiMiddleware(endpoint, ('http://localhost',))(scope, receive, send)
    endpoint.assert_not_awaited()
    assert send.call_args_list[0].args[0]['status'] == 408


def test_requests_have_safe_correlated_logs_and_no_cached_errors(caplog):
    app = FastAPI()
    app.add_middleware(ApiMiddleware, origins=('http://127.0.0.1:5173',))
    @app.post('/api/items/{item_id}')
    async def post(request: Request):
        assert (await request.json())['private'] == 'body-secret'
        return {'ok':True}
    @app.get('/api/broken')
    async def broken():
        raise ValueError('provider-secret-must-not-appear')
    with caplog.at_level(logging.INFO, logger='medvisit.http'), LocalClient(app) as client:
        response = client.post('/api/items/path-secret?key=query-secret', json={'private':'body-secret'}, headers={'X-Request-ID':'client-forged-id'})
        assert response.status_code == 200
        request_id = response.headers['X-Request-ID']
        assert len(request_id) == 32 and request_id != 'client-forged-id'
        failed = client.get('/api/broken')
        assert failed.status_code == 500 and failed.headers['Cache-Control'] == 'no-store'
        denied = client.post('/api/items/test', json={}, headers={'Origin':'https://evil.test'})
        assert denied.status_code == 403 and denied.headers['X-Request-ID']
    events = [json.loads(record.message) for record in caplog.records if record.name == 'medvisit.http']
    assert any(event.get('request_id') == request_id and event.get('route') == '/api/items/{item_id}' for event in events)
    assert any(event.get('error_type') == 'ValueError' and event.get('frames') for event in events)
    assert all(secret not in caplog.text for secret in ('body-secret','path-secret','query-secret','provider-secret-must-not-appear','client-forged-id'))


def test_passive_liveness_and_readiness_include_storage_and_archive_files(tmp_path):
    app = create_app(settings(tmp_path))
    with LocalClient(app) as client, patch('medvisit.api.app.check_services', AsyncMock()) as probes:
        assert client.get('/api/live').status_code == 200
        assert client.get('/api/ready').status_code == 200
        with patch.object(app.state.records, 'check', side_effect=OSError('private-database-url')):
            assert client.get('/api/live').status_code == 200
            response = client.get('/api/ready')
            assert response.status_code == 503 and 'private-database-url' not in response.text
        with patch('medvisit.api.app.TemporaryFile', side_effect=OSError('disk full')):
            assert client.get('/api/ready').status_code == 503
        assert client.get('/api/ready').status_code == 200
        probes.assert_not_awaited()
    assert not app.state.ready


def test_validation_errors_do_not_reflect_rejected_private_input(tmp_path):
    with LocalClient(create_app(settings(tmp_path))) as client:
        response = client.post('/api/research/jobs', json={'kind':'doctor', 'query':'x'*10000, 'token':'private-rejected-value'})
        assert response.status_code == 422 and len(response.content) < 1500
        assert 'private-rejected-value' not in response.text
        assert all(set(error) == {'loc','msg','type'} for error in response.json()['detail'])
        unknown = 'private-unknown-key-'+'x'*10000
        body = {'kind':'doctor', 'query':'公开医生资料', unknown:'value', **{f'extra-{i}':i for i in range(40)}}
        response = client.post('/api/research/jobs', json=body)
        assert response.status_code == 422 and len(response.content) < 4000
        assert 'private-unknown-key-' not in response.text
        assert len(response.json()['detail']) == 20
        assert all(error['loc'][-1] == '<extra_field>' for error in response.json()['detail'])


def test_failed_background_shutdown_still_closes_records(tmp_path):
    app = create_app(settings(tmp_path))
    with patch.object(app.state.research, 'close', AsyncMock(side_effect=RuntimeError('shutdown test'))), \
         patch.object(app.state.records, 'close', Mock()) as close:
        with pytest.raises(RuntimeError, match='shutdown test'):
            with LocalClient(app):
                pass
        close.assert_called_once()
        assert not app.state.ready


@pytest.mark.parametrize('storage', ['file', 'postgres'])
async def test_scheduled_visit_cleanup_recovers_without_leaking_private_errors(tmp_path, monkeypatch, request, caplog, storage):
    database = request.getfixturevalue('database_url') if storage == 'postgres' else ''
    cleanup = None
    def tracked_visits(*args):
        nonlocal cleanup
        router = visits_router(*args)
        cleanup = Mock(wraps=router.visit_cleanup)
        router.visit_cleanup = cleanup
        return router
    monkeypatch.setattr('medvisit.api.app.visits_router', tracked_visits)
    app = create_app(settings(tmp_path / 'sessions', database_url=database))
    ticks, sleeping = asyncio.Queue(), asyncio.Queue()
    sleep = asyncio.sleep
    async def scheduled_sleep(delay):
        task = asyncio.current_task()
        if delay == 3600 and task.get_coro().__qualname__.endswith('cleanup_visits'):
            sleeping.put_nowait(task)
            await ticks.get()
        else:
            await sleep(delay)
    monkeypatch.setattr('medvisit.api.app.asyncio.sleep', scheduled_sleep)
    directory = tmp_path / 'visit-audio'
    directory.mkdir(mode=0o700)
    raw, transcript = directory / ('a' * 32), directory / ('a' * 32 + '.transcript')
    retained = {directory / ('b' * 32):b'other representative audio',
                directory / ('b' * 32 + '.transcript'):b'{"text":"other representative text"}'}
    original_unlink = Path.unlink
    failed = False
    def fail_once(path, *args, **kwargs):
        nonlocal failed
        if path == raw and not failed:
            failed = True
            raise OSError('synthetic-private-path-and-content')
        return original_unlink(path, *args, **kwargs)
    caplog.set_level(logging.ERROR, logger='medvisit')
    async with app.router.lifespan_context(app):
        worker = await asyncio.wait_for(sleeping.get(), 2)
        raw.write_bytes(b'synthetic expired audio')
        transcript.write_text('{"text":"synthetic expired text"}')
        for path, content in retained.items():
            path.write_bytes(content)
        with app.state.platform.transaction('local') as tx:
            expired = tx.create('local', 'visit', {'owner_id':'local', 'source':'recording',
                'audio_path':raw.name, 'transcript_file':transcript.name, 'audio_status':'transcribed',
                'audio_uploaded_at':(datetime.now(timezone.utc) - timedelta(days=31)).isoformat()})
            unexpired = tx.create('local', 'visit', {'owner_id':'other-representative', 'source':'recording',
                'audio_path':'b' * 32, 'transcript_file':'b' * 32 + '.transcript', 'audio_status':'transcribed'})
        with ExitStack() as held:
            if storage == 'postgres':
                pool = app.state.records.pool
                for _ in range(pool.max_size):
                    held.enter_context(pool.connection())
            else:
                monkeypatch.setattr(Path, 'unlink', fail_once)
            next_cycle = asyncio.create_task(sleeping.get())
            ticks.put_nowait(None)
            try:
                done, _ = await asyncio.wait([worker, next_cycle], timeout=7, return_when=asyncio.FIRST_COMPLETED)
                error = type(worker.exception()).__name__ if worker.done() and not worker.cancelled() else None
                assert next_cycle in done, f'Scheduled cleanup stopped after {error}'
                assert next_cycle.result() is worker and not worker.done()
            finally:
                next_cycle.cancel()
                await asyncio.gather(next_cycle, return_exceptions=True)
            assert cleanup.call_count == 2 and raw.is_file() and transcript.is_file()
        ticks.put_nowait(None)
        assert await asyncio.wait_for(sleeping.get(), 2) is worker
        assert cleanup.call_count == 3 and not raw.exists() and not transcript.exists()
        with app.state.platform.transaction('local', write=False) as tx:
            assert tx.get('local', 'visit', expired['id'])['audio_status'] == 'deleted'
            assert tx.get('local', 'visit', unexpired['id']) == unexpired
        assert all(path.read_bytes() == content for path, content in retained.items())
        errors = [record.getMessage() for record in caplog.records if record.name == 'medvisit']
        assert errors == [f'visit_cleanup_failed error_type={"PoolTimeout" if storage == "postgres" else "OSError"}']
        assert 'synthetic-private-path-and-content' not in caplog.text
    assert worker.cancelled() and cleanup.call_count == 3 and not app.state.ready


@pytest.mark.parametrize('worker_fails', [False, True])
@pytest.mark.parametrize('cancel_shutdown', [False, True])
async def test_shutdown_drains_scheduled_visit_cleanup_before_closing_storage(tmp_path, monkeypatch, database_url, caplog, worker_fails, cancel_shutdown):
    started, release, finished = Event(), Event(), Event()
    ticks = asyncio.Queue()
    order, scheduled = [], []
    calls = 0
    def held_visits(*args):
        router = visits_router(*args)
        cleanup = router.visit_cleanup
        def held(workspace):
            nonlocal calls
            calls += 1
            if calls == 1:
                return cleanup(workspace)
            started.set()
            try:
                assert release.wait(5), 'Test did not release cleanup worker'
                if worker_fails:
                    raise OSError('synthetic-private-cleanup-path')
                return cleanup(workspace)
            finally:
                order.append('cleanup_finished')
                finished.set()
        router.visit_cleanup = held
        return router
    monkeypatch.setattr('medvisit.api.app.visits_router', held_visits)
    app = create_app(settings(tmp_path / 'sessions', database_url=database_url))
    sleep = asyncio.sleep
    async def clock(delay):
        task = asyncio.current_task()
        if delay == 3600 and task.get_coro().__qualname__.endswith('cleanup_visits'):
            scheduled.append(task)
            await ticks.get()
        else:
            await sleep(delay)
    monkeypatch.setattr('medvisit.api.app.asyncio.sleep', clock)
    close = app.state.records.close
    def close_store():
        order.append('storage_closed')
        close()
    caplog.set_level(logging.ERROR, logger='medvisit')
    lifecycle = app.router.lifespan_context(app)
    with patch.object(app.state.records, 'close', close_store):
        await lifecycle.__aenter__()
        directory = tmp_path / 'visit-audio'
        directory.mkdir(mode=0o700)
        raw, transcript = directory / ('a' * 32), directory / ('a' * 32 + '.transcript')
        raw.write_bytes(b'synthetic expired audio')
        transcript.write_text('{"text":"synthetic expired transcript"}')
        with app.state.platform.transaction('local') as tx:
            item = tx.create('local', 'visit', {'owner_id':'local', 'source':'recording',
                'audio_path':raw.name, 'transcript_file':transcript.name, 'audio_status':'transcribed',
                'audio_uploaded_at':(datetime.now(timezone.utc) - timedelta(days=31)).isoformat()})
        shutdown = None
        try:
            ticks.put_nowait(None)
            assert await asyncio.to_thread(started.wait, 2)
            shutdown = asyncio.create_task(lifecycle.__aexit__(None, None, None))
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(shutdown), .05)
            assert not app.state.ready and not app.state.records.pool.closed
            if cancel_shutdown:
                for _ in range(2):
                    shutdown.cancel()
                    await asyncio.sleep(0)
                assert not shutdown.done() and 'storage_closed' not in order
        finally:
            release.set()
            if shutdown is None:
                await lifecycle.__aexit__(None, None, None)
            else:
                await asyncio.wait_for(asyncio.gather(shutdown, return_exceptions=True), 2)
            assert await asyncio.to_thread(finished.wait, 2)
    assert order == ['cleanup_finished', 'storage_closed']
    assert calls == 2 and len(scheduled) == 1 and scheduled[0].cancelled()
    assert shutdown.cancelled() is cancel_shutdown and app.state.records.pool.closed
    with connect(database_url, autocommit=True) as connection:
        saved = json.loads(connection.execute('SELECT document FROM platform_entities WHERE id=%s', (item['id'],)).fetchone()[0])
        assert saved['audio_status'] == ('transcribed' if worker_fails else 'deleted')
        deadline = asyncio.get_running_loop().time() + 2
        while connection.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()", ()).fetchone()[0]:
            assert asyncio.get_running_loop().time() < deadline, 'Cleanup left a database connection open'
            await asyncio.sleep(.01)
    assert raw.exists() is worker_fails and transcript.exists() is worker_fails
    errors = [record.getMessage() for record in caplog.records if record.name == 'medvisit']
    assert errors == (['visit_cleanup_failed error_type=OSError'] if worker_fails else [])
    assert 'synthetic-private-cleanup-path' not in caplog.text


def test_pricing_preparation_failure_releases_the_voice_slot(tmp_path):
    app = create_app(settings(tmp_path, max_sessions=1))
    with LocalClient(app) as client, patch('medvisit.api.app.capture_prices', side_effect=RuntimeError('preparation failed')):
        for _ in range(2):
            with client.websocket_connect('/api/realtime?experience=practice', headers=ORIGIN) as ws:
                assert receive_until(ws, 'error')['code'] == 'internal_error'
                assert receive_until(ws, 'ended')['saved'] is True


async def test_readiness_timeouts_share_one_storage_probe_and_recover(tmp_path):
    app = create_app(settings(tmp_path))
    app.state.ready = True
    app.state.platform.open()
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/ready')
    release = Event()
    check = Mock(side_effect=lambda: release.wait(5))
    wait_for = asyncio.wait_for

    async def quick_timeout(future, timeout):
        return await wait_for(future, 2 if release.is_set() else .05)

    try:
        with patch.object(app.state.records, 'check', check), patch('medvisit.api.app.asyncio.wait_for', quick_timeout):
            responses = await asyncio.gather(*(endpoint() for _ in range(8)))
            assert all(response.status_code == 503 for response in responses)
            assert check.call_count == 1
            assert (await endpoint()).status_code == 503
            assert check.call_count == 1
            release.set()
            assert await endpoint() == {'status':'ok'}
    finally:
        release.set()


@pytest.mark.parametrize('phase', ['mkdir', 'records_open', 'platform_open', 'initialize', 'visit_cleanup'])
@pytest.mark.parametrize('worker_fails', [False, True])
@pytest.mark.parametrize('cancel_startup', [False, True])
async def test_startup_waits_for_storage_workers_before_closing(tmp_path, database_url, phase, worker_fails, cancel_startup):
    started, release, finished = Event(), Event(), Event()
    order, errors = [], []
    def hold(function):
        def held(*args, **kwargs):
            started.set()
            try:
                assert release.wait(5), 'Test did not release startup worker'
                result = function(*args, **kwargs)
                if worker_fails:
                    raise OSError('synthetic startup failure')
                return result
            except Exception as exc:
                errors.append(type(exc).__name__)
                raise
            finally:
                order.append('work_finished')
                finished.set()
        return held
    def platform(*args):
        router, initialize, current_user, operations = platform_router(*args)
        return router, hold(initialize) if phase == 'initialize' else initialize, current_user, operations
    def visits(*args):
        router = visits_router(*args)
        if phase == 'visit_cleanup':
            router.visit_cleanup = hold(router.visit_cleanup)
        return router
    with patch('medvisit.api.app.platform_router', platform), patch('medvisit.api.app.visits_router', visits):
        app = create_app(settings(tmp_path / 'sessions', database_url=database_url))
    close = app.state.records.close
    def close_store():
        close()
        order.append('storage_closed')
    mkdir = Path.mkdir
    def held_mkdir(path, *args, **kwargs):
        function = hold(mkdir) if path == tmp_path / 'sessions' else mkdir
        return function(path, *args, **kwargs)
    lifecycle = app.router.lifespan_context(app)
    with ExitStack() as patches:
        patches.enter_context(patch.object(app.state.records, 'close', close_store))
        if phase == 'mkdir':
            patches.enter_context(patch.object(Path, 'mkdir', held_mkdir))
        elif phase == 'records_open':
            patches.enter_context(patch.object(app.state.records, 'open', hold(app.state.records.open)))
        elif phase == 'platform_open':
            patches.enter_context(patch.object(app.state.platform, 'open', hold(app.state.platform.open)))
        startup = asyncio.create_task(lifecycle.__aenter__())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            if cancel_startup:
                for _ in range(2):
                    startup.cancel()
                    await asyncio.sleep(0)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(startup), .05)
            assert not app.state.ready and 'storage_closed' not in order
        finally:
            release.set()
            result = (await asyncio.wait_for(asyncio.gather(startup, return_exceptions=True), 2))[0]
            assert await asyncio.to_thread(finished.wait, 2)
            became_ready = app.state.ready
            if not startup.cancelled() and startup.exception() is None:
                await lifecycle.__aexit__(None, None, None)
            pool_closed = app.state.records.pool.closed
            # A failing baseline must not leak its pool into the next test.
            if not pool_closed:
                close()
    if worker_fails:
        assert isinstance(result, OSError) and str(result) == 'synthetic startup failure'
    else:
        assert startup.cancelled() is cancel_startup
    assert errors == (['OSError'] if worker_fails else [])
    assert order == ['work_finished', 'storage_closed']
    assert became_ready is (not worker_fails and not cancel_startup)
    assert not app.state.ready and pool_closed
    with connect(database_url, autocommit=True) as connection:
        deadline = asyncio.get_running_loop().time() + 2
        while connection.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()", ()).fetchone()[0]:
            assert asyncio.get_running_loop().time() < deadline, 'Startup left a database connection open'
            await asyncio.sleep(.01)


@pytest.mark.parametrize('worker_fails', [False, True])
async def test_shutdown_waits_for_storage_close_under_repeated_cancellation(tmp_path, database_url, worker_fails):
    app = create_app(settings(tmp_path / 'sessions', database_url=database_url))
    started, release, finished = Event(), Event(), Event()
    close = app.state.records.close
    def close_store():
        started.set()
        try:
            assert release.wait(5), 'Test did not release storage close'
            close()
            if worker_fails:
                raise OSError('synthetic close failure')
        finally:
            finished.set()
    lifecycle = app.router.lifespan_context(app)
    with patch.object(app.state.records, 'close', close_store):
        await lifecycle.__aenter__()
        shutdown = asyncio.create_task(lifecycle.__aexit__(None, None, None))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            for _ in range(2):
                shutdown.cancel()
                await asyncio.sleep(0)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(shutdown), .05)
            assert not app.state.records.pool.closed and not app.state.ready
        finally:
            release.set()
            result = (await asyncio.wait_for(asyncio.gather(shutdown, return_exceptions=True), 2))[0]
            assert await asyncio.to_thread(finished.wait, 2)
    if worker_fails:
        assert isinstance(result, OSError) and str(result) == 'synthetic close failure'
    else:
        assert shutdown.cancelled()
    assert app.state.records.pool.closed
    with connect(database_url, autocommit=True) as connection:
        deadline = asyncio.get_running_loop().time() + 2
        while connection.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()", ()).fetchone()[0]:
            assert asyncio.get_running_loop().time() < deadline, 'Shutdown left a database connection open'
            await asyncio.sleep(.01)


@pytest.mark.parametrize('probe_fails', [False, True])
@pytest.mark.parametrize('cancel_shutdown', [False, True])
async def test_shutdown_drains_detached_readiness_probe_before_closing_storage(tmp_path, database_url, probe_fails, cancel_shutdown):
    app = create_app(settings(tmp_path, database_url=database_url))
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/ready')
    started, release, finished = Event(), Event(), Event()
    order = []

    check_storage = app.state.records.check
    def check():
        started.set()
        try:
            assert release.wait(5)
            check_storage()
            order.append('checked')
            if probe_fails:
                raise OSError('test storage failure')
        finally:
            finished.set()

    close = app.state.records.close
    def close_store():
        close()
        order.append('closed')
    lifecycle = app.router.lifespan_context(app)
    with patch.object(app.state.records, 'check', side_effect=check), \
            patch.object(app.state.records, 'close', side_effect=close_store):
        await lifecycle.__aenter__()
        request = asyncio.create_task(endpoint())
        shutdown = None
        try:
            assert await asyncio.to_thread(started.wait, 1)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            shutdown = asyncio.create_task(lifecycle.__aexit__(None, None, None))
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(shutdown), .05)
            assert not app.state.ready and 'closed' not in order
            assert (await endpoint()).status_code == 503
            if cancel_shutdown:
                for _ in range(2):
                    shutdown.cancel()
                    await asyncio.sleep(0)
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(shutdown), .05)
                assert not app.state.records.pool.closed and 'closed' not in order
        finally:
            release.set()
            if shutdown is None:
                await lifecycle.__aexit__(None, None, None)
            else:
                await asyncio.wait_for(asyncio.gather(shutdown, return_exceptions=True), 2)
            assert await asyncio.to_thread(finished.wait, 1)
    assert order == ['checked', 'closed']
    assert shutdown.cancelled() is cancel_shutdown and app.state.records.pool.closed
    with connect(database_url, autocommit=True) as connection:
        deadline = asyncio.get_running_loop().time() + 2
        while connection.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()", ()).fetchone()[0]:
            assert asyncio.get_running_loop().time() < deadline, 'Readiness left a database connection open'
            await asyncio.sleep(.01)


def test_final_review_holds_voice_capacity_until_the_record_is_saved(tmp_path):
    from test_calibration import setup_scene

    app = create_app(settings(tmp_path, max_sessions=1))
    release = Event()

    async def review(*args):
        await asyncio.to_thread(release.wait, 5)

    with LocalClient(app) as client, patch('medvisit.api.app.run_practice', AsyncMock(return_value='completed')), \
            patch('medvisit.api.app.review_training', side_effect=review):
        _, scene = setup_scene(client)
        url = '/api/realtime?experience=practice&stage=closing&scenario_id=' + scene['id']
        with client.websocket_connect(url, headers=ORIGIN) as first:
            first.send_json({'type':'start', 'mode':'assisted'})
            assert receive_until(first, 'practice_state')['state'] == 'thinking'
            try:
                with client.websocket_connect(url, headers=ORIGIN) as second:
                    response = second.receive_json()
                    assert response['type'] == 'error' and response['code'] == 'busy'
            finally:
                release.set()
            assert receive_until(first, 'ended')['saved'] is True
        with client.websocket_connect(url, headers=ORIGIN) as third:
            third.send_json({'type':'start', 'mode':'assisted'})
            assert receive_until(third, 'ended')['saved'] is True


@pytest.mark.parametrize('failure', [sqlite3.OperationalError, OperationalError])
def test_websocket_preparation_database_failure_is_recoverable(tmp_path, failure):
    app = create_app(settings(tmp_path, max_sessions=1))
    with LocalClient(app) as client:
        with patch('medvisit.api.app.prepare_training', side_effect=failure('private database details')):
            with client.websocket_connect('/api/realtime?experience=practice&scenario_id=missing', headers=ORIGIN) as ws:
                error = ws.receive_json()
                assert error['type'] == 'error' and error['code'] == 'storage_unavailable'
                assert 'private' not in error['message']
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 1013
        with patch('medvisit.api.app.run_practice', AsyncMock(return_value='completed')):
            with client.websocket_connect('/api/realtime?experience=practice', headers=ORIGIN) as ws:
                ws.send_json({'type':'start', 'mode':'assisted'})
                assert receive_until(ws, 'ended')['saved'] is True


@pytest.mark.parametrize('blocked_event', ['error', 'ended'])
async def test_slow_client_does_not_block_record_persistence_or_final_cleanup(tmp_path, blocked_event):
    app = create_app(settings(tmp_path))
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/realtime')

    async def send(payload):
        if payload['type'] == blocked_event:
            await asyncio.Event().wait()

    async def practice(client, config, record):
        record.transcript('u1', 'trainee', '软件测试：断流也保留原话。', final=True)
        raise BridgeError('provider_error', '软件测试故障')

    client = SimpleNamespace(headers=ORIGIN, query_params={'experience':'practice'}, accept=AsyncMock(),
        receive_text=AsyncMock(return_value=json.dumps({'type':'start', 'mode':'assisted'})),
        send_json=send, close=AsyncMock())
    wait_for = asyncio.wait_for

    async def short_send_timeout(future, timeout):
        return await wait_for(future, .01 if timeout == 5 else timeout)

    async with app.router.lifespan_context(app):
        with patch('medvisit.api.app.run_practice', side_effect=practice), \
                patch('medvisit.api.app.asyncio.wait_for', short_send_timeout):
            await wait_for(endpoint(client), .5)
        summaries = app.state.records.list()
        assert len(summaries) == 1 and summaries[0]['status'] == 'error'


@pytest.mark.parametrize('database_fails', [False, True])
async def test_repeated_cancellation_waits_for_session_save_and_recovery(tmp_path, database_fails):
    store = FileRecords(tmp_path)
    with patch('medvisit.api.app.PostgresRecords', return_value=store):
        app = create_app(settings(tmp_path, database_url='postgresql://test', max_sessions=1))
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/realtime')
    started, release, written = Event(), Event(), Event()
    save = store.save

    def delayed_save(record, status):
        started.set()
        try:
            assert release.wait(5)
            if database_fails:
                raise OperationalError('synthetic database outage')
            save(record, status)
        finally:
            written.set()

    async def practice(client, config, record):
        record.transcript('u1', 'trainee', 'Keep this transcript after cancellation.', final=True)
        return 'completed'

    def client():
        return SimpleNamespace(headers=ORIGIN, query_params={'experience':'practice'}, accept=AsyncMock(),
            receive_text=AsyncMock(return_value=json.dumps({'type':'start', 'mode':'assisted'})),
            send_json=AsyncMock(), close=AsyncMock())

    async with app.router.lifespan_context(app):
        with patch.object(store, 'save', side_effect=delayed_save), \
                patch('medvisit.api.app.run_practice', side_effect=practice):
            first = client()
            task = asyncio.create_task(endpoint(first))
            try:
                assert await asyncio.to_thread(started.wait, 1)
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0)
                assert not task.done()
                second = client()
                await asyncio.wait_for(endpoint(second), .5)
                assert second.send_json.call_args.args[0]['code'] == 'busy'
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)
                assert await asyncio.to_thread(written.wait, 1)
            assert task.cancelled()
            ended = next(call.args[0] for call in first.send_json.call_args_list if call.args[0]['type'] == 'ended')
            assert ended['saved'] is not database_fails
            assert ended['recovery_saved'] is database_fails
            directory = tmp_path/'recovery' if database_fails else tmp_path
            records = FileRecords(directory).list()
            assert len(records) == 1
            assert records[0]['message_count'] == 1
            # The slot is reusable only after persistence has settled.
            third = client()
            await asyncio.wait_for(endpoint(third), 1)
            assert any(call.args[0]['type'] == 'ended' for call in third.send_json.call_args_list)


async def test_cancellation_during_review_error_notice_still_saves_transcript(tmp_path):
    app = create_app(settings(tmp_path))
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/realtime')
    notice = asyncio.Event()
    sent = []

    async def send(payload):
        sent.append(payload)
        if payload['type'] == 'notice':
            notice.set()
            await asyncio.Event().wait()

    async def practice(client, config, record):
        record.transcript('u1', 'trainee', 'Preserve the words even if the review fails.', final=True)
        return 'completed'

    client = SimpleNamespace(headers=ORIGIN, query_params={'experience':'practice', 'scenario_id':'test'},
        accept=AsyncMock(), receive_text=AsyncMock(return_value='{"type":"start","mode":"assisted"}'),
        send_json=send, close=AsyncMock())
    training = {'doctor':{'id':'test', 'version':1, 'display_name':'Synthetic test doctor'}}
    async with app.router.lifespan_context(app):
        with patch('medvisit.api.app.prepare_training', return_value=training), \
                patch('medvisit.api.app.snapshot', return_value={}), \
                patch('medvisit.api.app.run_practice', side_effect=practice), \
                patch('medvisit.api.app.review_training', side_effect=BridgeError('review_failed', 'Synthetic failure')):
            task = asyncio.create_task(endpoint(client))
            try:
                await asyncio.wait_for(notice.wait(), 1)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            assert task.cancelled()
            assert len(app.state.records.list()) == 1
            assert any(event['type'] == 'ended' and event['saved'] for event in sent)


@pytest.mark.parametrize('cancel_shutdown', [False, True])
async def test_shutdown_waits_for_active_session_persistence(tmp_path, cancel_shutdown):
    app = create_app(settings(tmp_path))
    endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', None) == '/api/realtime')
    started, release = Event(), Event()
    order = []
    save = app.state.records.save

    def delayed_save(record, status):
        started.set()
        assert release.wait(5)
        save(record, status)
        order.append('saved')

    client = SimpleNamespace(headers=ORIGIN, query_params={'experience':'practice'}, accept=AsyncMock(),
        receive_text=AsyncMock(return_value='{"type":"start","mode":"assisted"}'),
        send_json=AsyncMock(), close=AsyncMock())
    lifecycle = app.router.lifespan_context(app)
    with patch.object(app.state.records, 'close', side_effect=lambda: order.append('closed')), \
            patch.object(app.state.records, 'save', side_effect=delayed_save), \
            patch('medvisit.api.app.run_practice', AsyncMock(return_value='completed')):
        await lifecycle.__aenter__()
        session = asyncio.create_task(endpoint(client))
        shutdown = None
        try:
            assert await asyncio.to_thread(started.wait, 1)
            # Uvicorn cancels handlers after its grace period, then starts lifespan shutdown.
            session.cancel()
            shutdown = asyncio.create_task(lifecycle.__aexit__(None, None, None))
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(shutdown), .05)
            assert 'closed' not in order
            late = SimpleNamespace(**vars(client))
            late.send_json = AsyncMock()
            await endpoint(late)
            assert late.send_json.call_args.args[0]['code'] == 'not_ready'
            if cancel_shutdown:
                for _ in range(2):
                    shutdown.cancel()
                    await asyncio.sleep(0)
                assert not shutdown.done() and 'closed' not in order
        finally:
            release.set()
            await asyncio.gather(session, return_exceptions=True)
            if shutdown is None:
                await lifecycle.__aexit__(None, None, None)
            else:
                await asyncio.gather(shutdown, return_exceptions=True)
    assert session.cancelled()
    assert shutdown.cancelled() is cancel_shutdown
    assert order == ['saved', 'closed']
