import asyncio
from contextlib import ExitStack
from datetime import datetime, timezone
from threading import Event
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from psycopg_pool import PoolTimeout

from medvisit.api.app import create_app
from medvisit.research.models import ResearchRequest
from test_bridge import ORIGIN, settings
from test_research_word import docx
from test_storage import database_url


@pytest.mark.parametrize('operation', ['startup', 'cancel_first', 'cancel_final',
    'cancel_running_middle', 'cancel_running_final', 'watch_list', 'watch_error', 'poll', 'policy'])
@pytest.mark.parametrize('worker_fails', [False, True])
async def test_research_storage_finishes_before_shutdown(tmp_path, database_url, operation, worker_fails, caplog):
    config = settings(tmp_path/'records', database_url=database_url, deepseek_search_enabled=False)
    config.deepseek_api_key = ''
    app = create_app(config)
    service = app.state.research
    entered, release, finished = Event(), Event(), Event()
    tick = asyncio.Event()
    sleep = asyncio.sleep
    order, calls = [], []
    close = app.state.records.close
    error = RuntimeError('synthetic research storage failure')
    lifecycle = app.router.lifespan_context(app)
    target = ('recover' if operation in ('startup', 'poll') else
        'policy_file' if operation == 'policy' else
        'list' if operation == 'watch_list' else '_watch_error' if operation == 'watch_error' else 'get_job')
    target_call = 3 if operation == 'cancel_running_final' else 2 if operation in ('cancel_final', 'cancel_running_middle') else 1
    original = getattr(service, target)

    async def clock(delay):
        if delay == 30:
            await tick.wait()
            tick.clear()
        else:
            await sleep(delay)

    def close_store():
        order.append('store_closed')
        close()

    def held(*args, **kwargs):
        if operation == 'watch_list' and args != ('research_watch',):
            return original(*args, **kwargs)
        calls.append(args)
        if len(calls) != target_call:
            return original(*args, **kwargs)
        entered.set()
        try:
            assert release.wait(5)
            if worker_fails:
                raise error
            return original(*args, **kwargs)
        finally:
            order.append('work_finished')
            finished.set()

    with patch('medvisit.research.service.asyncio.sleep', clock), \
         patch('medvisit.research.service.run_agent', AsyncMock()) as provider, \
         patch.object(app.state.records, 'close', close_store):
        if operation != 'startup':
            await lifecycle.__aenter__()
        if operation.startswith('cancel_'):
            if operation.startswith('cancel_running'):
                service.settings.deepseek_api_key = 'synthetic-not-a-live-key'
                service.settings.deepseek_search_enabled = True
                job = service._create_job(ResearchRequest(kind='policy', query='Synthetic lifecycle regression'))
            else:
                with service.store.transaction(service.workspace) as tx:
                    job = tx.create(service.workspace, 'research_job', {'status':'completed', 'kind':'policy', 'query':'Synthetic software test'})
        elif operation == 'watch_error':
            with service.store.transaction(service.workspace) as tx:
                tx.create(service.workspace, 'research_watch', {'enabled':True, 'kind':'policy',
                    'query':'Synthetic public policy', 'next_check_at':datetime.now(timezone.utc).isoformat(), 'source_ids':[]})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers=ORIGIN) as client:
            with patch.object(service, target, held):
                if operation == 'startup':
                    actor = asyncio.create_task(lifecycle.__aenter__())
                elif operation.startswith('cancel_'):
                    actor = asyncio.create_task(service.cancel(job['id']))
                elif operation == 'poll':
                    actor = service.scheduler
                    tick.set()
                elif operation == 'policy':
                    raw = docx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Synthetic public policy original for software validation only, pending medical review.</w:t></w:r></w:p></w:document>')
                    actor = asyncio.create_task(client.post('/api/research/policy-file?title=Synthetic', content=raw))
                else:
                    actor = asyncio.create_task(service.check_due_watches())
                exiting = None
                try:
                    assert await asyncio.to_thread(entered.wait, 2)
                    if operation != 'poll':
                        for _ in range(2):
                            actor.cancel()
                            await sleep(.01)
                    if operation != 'startup':
                        exiting = asyncio.create_task(lifecycle.__aexit__(None, None, None))
                        for _ in range(2):
                            await sleep(.01)
                            exiting.cancel()
                    await sleep(.025)
                    assert not actor.done()
                    assert exiting is None or not exiting.done()
                    assert 'store_closed' not in order
                finally:
                    release.set()
                    results = await asyncio.wait_for(asyncio.gather(actor, *([exiting] if exiting else []), return_exceptions=True), 3)
                    assert await asyncio.to_thread(finished.wait, 2)
        if worker_fails and operation == 'policy':
            assert results[0].status_code == 500
            assert str(error) not in results[0].text
            assert '"error_type": "RuntimeError"' in caplog.text
        elif worker_fails and operation != 'poll':
            assert results[0] is error
        else:
            assert isinstance(results[0], asyncio.CancelledError)
        assert order.index('work_finished') < order.index('store_closed')
        assert app.state.records.pool.closed and not app.state.ready
        assert all(task.done() for task in service.tasks)
        provider.assert_not_awaited()


@pytest.mark.parametrize('worker_fails', [False, True])
async def test_concurrent_research_close_joins_one_outcome(tmp_path, database_url, worker_fails):
    app = create_app(settings(tmp_path/'records', database_url=database_url))
    lifecycle = app.router.lifespan_context(app)
    await lifecycle.__aenter__()
    service = app.state.research
    entered, release = Event(), Event()
    recover, calls = service.recover, []
    error = RuntimeError('synthetic shutdown failure')

    def held():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        if worker_fails:
            raise error
        recover()

    with patch.object(service, 'recover', held):
        exiting = asyncio.create_task(lifecycle.__aexit__(None, None, None))
        duplicate = None
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            duplicate = asyncio.create_task(service.close())
            for _ in range(2):
                exiting.cancel()
                await asyncio.sleep(.01)
            assert not exiting.done() and not duplicate.done()
            assert not app.state.records.pool.closed
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(exiting, *([duplicate] if duplicate else []), return_exceptions=True), 3)
        assert calls == [1]
        if worker_fails:
            assert results == [error, error]
            with pytest.raises(RuntimeError) as again:
                await service.close()
            assert again.value is error
        else:
            assert isinstance(results[0], asyncio.CancelledError) and results[1] is None
            await service.close()
        assert app.state.records.pool.closed and not app.state.ready
        with pytest.raises(Exception) as closed:
            await service.start(ResearchRequest(kind='policy', query='Synthetic request after shutdown'))
        assert closed.value.status_code == 503
        with patch.object(service.store, 'transaction') as transaction:
            for operation in (service.cancel('missing'), service.import_policy_file('Synthetic', b'')):
                with pytest.raises(Exception) as closed:
                    await operation
                assert closed.value.status_code == 503
            await service.check_due_watches()
            await service.start_scheduler()
            transaction.assert_not_called()


async def test_research_close_waits_for_admission_lock_under_cancellation(tmp_path, database_url):
    app = create_app(settings(tmp_path/'records', database_url=database_url, deepseek_search_enabled=True))
    lifecycle = app.router.lifespan_context(app)
    await lifecycle.__aenter__()
    service = app.state.research
    entered, release = Event(), Event()
    create = service._create_job

    def held(*args):
        entered.set()
        assert release.wait(5)
        return create(*args)

    with patch.object(service, '_create_job', held), patch('medvisit.research.service.run_agent', AsyncMock()) as provider:
        admission = asyncio.create_task(service.start(ResearchRequest(kind='policy', query='Synthetic admission')))
        exiting = None
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            exiting = asyncio.create_task(lifecycle.__aexit__(None, None, None))
            for _ in range(2):
                await asyncio.sleep(.01)
                exiting.cancel()
            await asyncio.sleep(.025)
            assert not exiting.done() and not app.state.records.pool.closed
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(admission, *([exiting] if exiting else []), return_exceptions=True), 3)
        assert isinstance(results[0], dict) and isinstance(results[1], asyncio.CancelledError)
        provider.assert_not_awaited()
        assert app.state.records.pool.closed and not app.state.ready


@pytest.mark.parametrize('operation', ['cancel', 'close'])
async def test_research_real_pool_timeout_and_restart_recovery(tmp_path, database_url, operation):
    config = settings(tmp_path/'records', database_url=database_url, deepseek_search_enabled=True)
    app = create_app(config)
    lifecycle = app.router.lifespan_context(app)
    await lifecycle.__aenter__()
    service, pool = app.state.research, app.state.records.pool
    job = service._create_job(ResearchRequest(kind='policy', query='Synthetic restart recovery'))
    ticks = []

    async def heartbeat():
        while True:
            ticks.append(asyncio.get_running_loop().time())
            await asyncio.sleep(.01)

    beat = asyncio.create_task(heartbeat())
    try:
        with ExitStack() as held:
            for _ in range(pool.max_size):
                held.enter_context(pool.connection())
            pending = asyncio.create_task(service.cancel(job['id']) if operation == 'cancel' else service.close())
            async with asyncio.timeout(2):
                while not pool.get_stats().get('requests_waiting'):
                    await asyncio.sleep(.001)
            for _ in range(2):
                pending.cancel()
                await asyncio.sleep(.01)
            assert not pending.done() and not pool.closed
            with pytest.raises(PoolTimeout) as failure:
                await asyncio.wait_for(pending, 6)
        assert max(b-a for a,b in zip(ticks, ticks[1:])) < .5
        assert pool.get_stats()['requests_waiting'] == 0
        if operation == 'cancel':
            assert (await service.cancel(job['id']))['status'] == 'interrupted'
        else:
            with pytest.raises(PoolTimeout) as again:
                await service.close()
            assert again.value is failure.value
    finally:
        beat.cancel()
        await asyncio.gather(beat, return_exceptions=True)
        if operation == 'close':
            with pytest.raises(PoolTimeout):
                await lifecycle.__aexit__(None, None, None)
        else:
            await lifecycle.__aexit__(None, None, None)
    assert pool.closed and not app.state.ready
    restarted = create_app(config)
    with patch('medvisit.research.service.run_agent', AsyncMock()) as provider:
        async with restarted.router.lifespan_context(restarted):
            recovered = restarted.state.research.get_job(job['id'])
            assert recovered['status'] == 'interrupted' and recovered['reviewed'] is False
            assert not restarted.state.research.tasks
            provider.assert_not_awaited()
