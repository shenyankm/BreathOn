import asyncio
from datetime import datetime, timedelta, timezone
import json
from threading import Event
from unittest.mock import AsyncMock, patch

import pytest

from medvisit.research import archive
from medvisit.research.models import ResearchRequest
from medvisit.research.archive import write_private
from test_platform import client
from test_storage import database_url
from test_research_archive import URL, TEXT, page


def configured(client):
    service = client.app.state.research
    service.settings.deepseek_search_enabled = True
    return service


def capture(service, monkeypatch, text=TEXT):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(text), URL, {'content-type':'text/html'})))
    return asyncio.run(archive.archive_source(service.archives, URL))[0]


def complete(service, metadata, *, errors=(), result=True):
    job = service._create_job(ResearchRequest(kind='policy', query='公开政策软件测试'))
    report = {'findings':[{'title':'软件测试','details':[{'label':'发布机关','value':'软件测试材料',
        'source_id':metadata['id'],'quote':TEXT}],'caveats':[]}], 'further_checks':[]} if result else None
    captured = {'queries':['软件测试'], 'search_results':[], 'archives':[metadata] if metadata else [], 'errors':list(errors)}
    service._finish(job, report, {'model':'fake'}, '', False, captured)
    return service.get_job(job['id'])


def test_reading_research_state_never_starts_a_provider_request(client):
    with patch('medvisit.research.service.run_agent', AsyncMock()) as model:
        response = client.get('/api/research')
        assert response.status_code == 200
        assert {profile['kind'] for profile in response.json()['profiles']} == {'policy','doctor','drug'}
        assert response.json()['jobs'] == [] and response.json()['watches'] == []
        model.assert_not_awaited()


def test_version_changes_and_failed_checks_preserve_previous_original(client, monkeypatch):
    service = configured(client)
    first = capture(service, monkeypatch)
    initial = complete(service, first)
    assert initial['status'] == 'completed' and initial['reviewed'] is False
    again = complete(service, capture(service, monkeypatch))
    assert again['changes'][0]['status'] == 'unchanged'
    failed = complete(service, None, result=False, errors=[{'operation':'archive','url':URL,'message':'软件测试模拟断网'}])
    assert failed['status'] == 'failed'
    source, = service.list('research_source')
    assert source['latest']['raw_sha256'] == first['raw_sha256'] and len(source['versions']) == 1
    assert source['last_check_error'] == '软件测试模拟断网'
    second = capture(service, monkeypatch, TEXT+' 软件测试修订内容。')
    changed = complete(service, second)
    assert changed['changes'][0]['status'] == 'content_changed'
    source, = service.list('research_source')
    assert len(source['versions']) == 2 and source['last_check_error'] == ''
    assert (service.archives/first['id']/first['raw_sha256']/'original.html').exists()
    for metadata in (first, second):
        url = f'/api/research/sources/{metadata["id"]}/{metadata["raw_sha256"]}'
        reader = client.get(url+'/html')
        assert reader.status_code == 200 and 'sandbox' in reader.headers['content-security-policy']
        assert '<script>' not in reader.text and TEXT in reader.text
        original = client.get(url+'/original')
        assert original.status_code == 200 and 'attachment' in original.headers['content-disposition']
        assert b'<script>' in original.content and original.headers['content-type'] == 'application/octet-stream'


def test_daily_tracking_is_explicit_and_due_only(client, monkeypatch):
    service = configured(client)
    job = complete(service, capture(service, monkeypatch))
    assert service.list('research_watch') == []
    with patch.object(service, 'start', AsyncMock()) as start:
        asyncio.run(service.check_due_watches())
        start.assert_not_awaited()
        watch = client.put(f'/api/research/jobs/{job["id"]}/watch', json={'enabled':True}).json()
        assert watch['enabled'] and watch['source_ids'] == job['source_ids']
        asyncio.run(service.check_due_watches())
        start.assert_not_awaited()
        with service.store.transaction(service.workspace) as tx:
            current = tx.get(service.workspace, 'research_watch', watch['id'])
            tx.update(service.workspace, 'research_watch', watch['id'], {**current,
                'next_check_at':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()}, current['version'])
        asyncio.run(service.check_due_watches())
        start.assert_awaited_once()
        assert start.call_args.args[0].query == job['query']
        assert start.call_args.args[1] == watch['id']
    response = client.put(f'/api/research/jobs/{job["id"]}/watch', json={'enabled':False})
    assert response.status_code == 200 and response.json()['enabled'] is False


def test_one_run_keeps_all_captured_versions_and_compares_against_its_start(client, monkeypatch):
    service = configured(client)
    initial = capture(service, monkeypatch)
    complete(service, initial)
    first = capture(service, monkeypatch, TEXT+' 第一份修订。')
    latest = capture(service, monkeypatch, TEXT+' 第二份修订。')
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试单次多版本'))
    report = {'findings':[{'title':'测试','details':[{'label':'发布机关', 'value':'测试',
        'source_id':first['id'], 'source_version':first['raw_sha256'], 'quote':TEXT}], 'caveats':[]}], 'further_checks':[]}
    service._finish(job, report, {}, '', False,
        {'queries':['测试'], 'search_results':[], 'archives':[first, latest], 'errors':[]})
    source, = service.list('research_source')
    assert [item['raw_sha256'] for item in source['versions']] == [item['raw_sha256'] for item in (initial, first, latest)]
    assert source['latest']['raw_sha256'] == latest['raw_sha256']
    result = service.get_job(job['id'])
    change, = result['changes']
    assert change['status'] == 'content_changed' and change['previous_version'] == initial['raw_sha256']
    assert change['version'] == latest['raw_sha256']
    detail, = result['result']['findings'][0]['details']
    assert detail['source_version'] == first['raw_sha256']
    assert client.get(f'/api/research/sources/{first["id"]}/{detail["source_version"]}/html').status_code == 200


def test_start_blocks_concurrent_jobs_and_rejects_unknown_or_private_input(client):
    service = configured(client)
    with pytest.raises(Exception) as invalid:
        service._create_job(ResearchRequest(kind='doctor', query='公开医生联系 13812345678'))
    assert invalid.value.status_code == 422
    service._create_job(ResearchRequest(kind='doctor', query='内分泌科公开资料'))
    response = client.post('/api/research/jobs', json={'kind':'drug','query':'玛仕度肽公开说明书'})
    assert response.status_code == 409
    assert client.post('/api/research/jobs', json={'kind':'shell','query':'公开资料'}).status_code == 422
    assert client.post('/api/research/jobs', json={'kind':'policy','query':'公开资料'}, headers={'origin':'https://evil.test'}).status_code == 403


def test_recovery_indexes_already_saved_originals_and_keeps_result_unreviewed(client, monkeypatch):
    service = configured(client)
    metadata = capture(service, monkeypatch)
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试中断恢复'))
    captured = {'queries':['软件测试'], 'search_results':[], 'archives':[metadata], 'errors':[]}
    write_private(service.base/'jobs'/job['id']/'observations.json', json.dumps(captured).encode())
    service.recover()
    recovered = service.get_job(job['id'])
    assert recovered['status'] == 'interrupted' and recovered['result'] is None
    assert recovered['source_ids'] == [metadata['id']]
    assert service.list('research_source')[0]['latest']['raw_sha256'] == metadata['raw_sha256']


def test_foreign_workspace_archives_and_jobs_are_not_readable(client):
    service = client.app.state.research
    with service.store.transaction('other') as tx:
        tx.create('other', 'research_source', {'versions':[{'raw_sha256':'b'*64}]}, item_id='a'*24)
        foreign = tx.create('other', 'research_job', {'status':'completed'})
    assert client.get('/api/research/sources/'+'a'*24+'/'+'b'*64+'/html').status_code == 404
    assert client.get('/api/research/jobs/'+foreign['id']).status_code == 404


def test_cancel_keeps_archives_and_releases_the_single_active_job(client, monkeypatch):
    service = configured(client)
    metadata = capture(service, monkeypatch)
    async def running(settings, kind, query, root, job_dir, seeds):
        write_private(job_dir/'observations.json', json.dumps({'queries':['软件测试'], 'search_results':[],
            'archives':[metadata], 'errors':[]}).encode())
        await asyncio.Event().wait()
    async def ready(job_id):
        for _ in range(30):
            if (service.base/'jobs'/job_id/'observations.json').exists():
                return
            await asyncio.sleep(0)
        raise AssertionError('mock research did not start')
    with patch('medvisit.research.service.run_agent', running):
        job = client.post('/api/research/jobs', json={'kind':'policy','query':'软件测试取消'}).json()
        client.portal.call(ready, job['id'])
        response = client.post(f'/api/research/jobs/{job["id"]}/cancel')
        assert response.status_code == 200 and response.json()['status'] == 'interrupted'
        assert response.json()['source_ids'] == [metadata['id']]
        assert not service.tasks


def test_immediate_shutdown_finalizes_a_job_before_its_task_starts(client):
    service = configured(client)
    async def start_and_close():
        job = await service.start(ResearchRequest(kind='policy', query='软件测试立即停止'))
        await service.close()
        return job['id']
    with patch('medvisit.research.service.run_agent', AsyncMock()) as provider:
        job_id = client.portal.call(start_and_close)
        provider.assert_not_awaited()
    assert service.get_job(job_id)['status'] == 'interrupted'
    with pytest.raises(Exception) as closing:
        client.portal.call(service.start, ResearchRequest(kind='policy', query='软件测试停止后启动'))
    assert closing.value.status_code == 503


@pytest.mark.parametrize('damaged', ['{', '[]', '{"archives":[]}',
    '{"queries":[],"search_results":[],"archives":[{}],"errors":[]}',
    '{"queries":[],"search_results":[],"archives":[],"errors":[{}]}'])
def test_recovery_keeps_damaged_observations_and_unblocks_new_jobs(client, damaged):
    service = configured(client)
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试损坏恢复'))
    path = service.base/'jobs'/job['id']/'observations.json'
    write_private(path, damaged.encode())
    assert service.get_job(job['id'])['progress'] == {'searches':0, 'archives':0}
    service.recover()
    recovered = service.get_job(job['id'])
    assert recovered['status'] == 'interrupted' and recovered['reviewed'] is False
    assert recovered['source_errors'][0]['operation'] == 'recovery'
    assert path.read_text() == damaged
    service._create_job(ResearchRequest(kind='policy', query='软件测试恢复后可以启动'))


@pytest.mark.parametrize('cancel_twice', [False, True])
def test_cancellation_waits_for_the_single_final_write(client, cancel_twice):
    service = configured(client)
    entered, release = Event(), Event()
    finish = service._finish
    calls = []
    def slow_finish(*args):
        calls.append(args[0]['id'])
        entered.set()
        assert release.wait(timeout=5)
        return finish(*args)
    async def cancel_during_write():
        job = await service.start(ResearchRequest(kind='policy', query='软件测试保存时停止'))
        assert await asyncio.to_thread(entered.wait, 5)
        task = service.job_tasks[job['id']]
        cancelled = asyncio.create_task(service.cancel(job['id']))
        try:
            async with asyncio.timeout(5):
                while not task.cancelling():
                    await asyncio.sleep(0.001)
            if cancel_twice:
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(.01)
            assert not task.done()
            assert not cancelled.done()
        finally:
            release.set()
        return await cancelled
    with patch.object(service, '_finish', slow_finish), patch('medvisit.research.service.run_agent',
            AsyncMock(return_value=(None, {}))):
        result = client.portal.call(cancel_during_write)
    assert len(calls) == 1 and result['status'] == 'failed'


def test_failed_background_persistence_is_logged_without_secrets_and_can_be_stopped(client, caplog):
    service = configured(client)
    async def failed_run():
        job = await service.start(ResearchRequest(kind='policy', query='软件测试保存失败'))
        await asyncio.gather(*list(service.tasks), return_exceptions=True)
        return job['id']
    with patch('medvisit.research.service.run_agent', AsyncMock(return_value=(None, {}))), \
            patch.object(service, '_finish', side_effect=OSError('software-test private DSN')):
        job_id = client.portal.call(failed_run)
    assert 'research_job_failed' in caplog.text and 'OSError' in caplog.text
    assert 'private DSN' not in caplog.text
    assert not service.tasks and not service.job_tasks
    result = client.portal.call(service.cancel, job_id)
    assert result['status'] == 'interrupted'


@pytest.mark.parametrize('operation', ['cancel', 'close'])
def test_orphan_recovery_keeps_lifecycle_locked_through_repeated_cancellation(client, operation):
    service = configured(client)
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试取消孤立任务恢复'))
    entered, release = Event(), Event()
    interrupt = service._interrupt
    calls = []

    def slow_interrupt(current):
        calls.append(current['id'])
        entered.set()
        assert release.wait(5)
        return interrupt(current)

    async def cancel_recovery():
        pending = asyncio.create_task(service.cancel(job['id']) if operation == 'cancel' else service.close())
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            for _ in range(2):
                pending.cancel()
                await asyncio.sleep(.01)
            assert not pending.done()
            assert service._lifecycle.locked()
        finally:
            release.set()
            result, = await asyncio.gather(pending, return_exceptions=True)
        assert isinstance(result, asyncio.CancelledError)

    with patch.object(service, '_interrupt', slow_interrupt):
        client.portal.call(cancel_recovery)
    assert service.get_job(job['id'])['status'] == 'interrupted'
    assert calls == [job['id']]


@pytest.mark.parametrize('damaged', ['{', '[]', 'null', '"unusable"'])
def test_damaged_usage_does_not_leave_research_running(client, damaged):
    service = configured(client)
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试用量损坏'))
    path = service.base/'jobs'/job['id']/'usage.json'
    write_private(path, damaged.encode())
    with patch('medvisit.research.service.run_agent', AsyncMock(side_effect=ValueError('结果未通过校验'))):
        client.portal.call(service._run, job)
    finished = service.get_job(job['id'])
    assert finished['status'] == 'failed'
    assert finished['source_errors'][0]['operation'] == 'recovery'
    assert path.read_text() == damaged
    service._create_job(ResearchRequest(kind='policy', query='软件测试用量恢复后启动'))


@pytest.mark.parametrize('cancel_again_during', [None, 'creation', 'interruption'])
def test_cancelled_start_waits_for_creation_and_finalizes_its_persisted_job(client, cancel_again_during):
    service = configured(client)
    entered, release, committed = Event(), Event(), Event()
    interrupt_entered, interrupt_release = Event(), Event()
    create = service._create_job
    interrupt = service._interrupt
    def slow_create(*args):
        entered.set()
        assert release.wait(timeout=5)
        job = create(*args)
        committed.set()
        return job
    def slow_interrupt(job):
        if cancel_again_during == 'interruption':
            interrupt_entered.set()
            assert interrupt_release.wait(timeout=5)
        return interrupt(job)
    async def cancelled_start():
        starting = asyncio.create_task(service.start(ResearchRequest(kind='policy', query='软件测试创建时停止')))
        assert await asyncio.to_thread(entered.wait, 5)
        try:
            starting.cancel()
            if cancel_again_during == 'interruption':
                release.set()
                assert await asyncio.to_thread(interrupt_entered.wait, 5)
            if cancel_again_during:
                await asyncio.sleep(0)
                starting.cancel()
                await asyncio.sleep(.01)
            assert not starting.done()
        finally:
            release.set()
            interrupt_release.set()
            await asyncio.gather(starting, return_exceptions=True)
            assert await asyncio.to_thread(committed.wait, 5)
    with patch.object(service, '_create_job', slow_create), patch.object(service, '_interrupt', slow_interrupt), \
            patch('medvisit.research.service.run_agent', AsyncMock()) as provider:
        client.portal.call(cancelled_start)
        provider.assert_not_awaited()
    job, = service.list('research_job')
    assert job['status'] == 'interrupted' and not service.tasks and not service.job_tasks


@pytest.mark.parametrize('damage', [None, 'invalid_json', 'invalid_evidence'])
def test_completed_research_recovers_after_database_failure_without_repeating_provider(client, monkeypatch, damage):
    from medvisit.research.agents import PROFILES, validate_result
    from medvisit.research.models import ResearchResult

    service = configured(client)
    metadata = capture(service, monkeypatch)
    text = archive.read_source(service.archives, metadata['id'], metadata['raw_sha256'])[1]
    evidence = archive.evidence_blocks(text, metadata['raw_sha256'])[0]['id']
    job = service._create_job(ResearchRequest(kind='policy', query='软件测试结果恢复'))
    captured = {'queries':['测试公开原文','测试后续更新'], 'search_results':[], 'archives':[metadata], 'errors':[],
        'evidence_seen':{metadata['id']:[evidence]}}
    write_private(service.base/'jobs'/job['id']/'observations.json', json.dumps(captured).encode())
    raw = {'findings':[{'title':'测试','details':[{'label':'发布机关','value':'测试机关',
        'source_id':metadata['id'],'evidence_id':evidence}],'caveats':[]}], 'further_checks':[]}
    result = validate_result(ResearchResult(**raw), PROFILES['policy'], service.archives, captured)
    with patch('medvisit.research.service.run_agent', AsyncMock(return_value=(result, {'total_tokens':8}))) as provider:
        with patch.object(service, '_finish', side_effect=OSError('database temporarily unavailable')):
            with pytest.raises(OSError):
                client.portal.call(service._run, job)
        checkpoint = service.base/'jobs'/job['id']/'result.json'
        assert checkpoint.stat().st_mode & 0o777 == 0o600
        if damage == 'invalid_json':
            write_private(checkpoint, b'{')
        elif damage == 'invalid_evidence':
            saved = json.loads(checkpoint.read_text())
            saved['result']['findings'][0]['details'][0]['evidence_id'] = 'E999-'+metadata['raw_sha256'][:12]
            write_private(checkpoint, json.dumps(saved).encode())
        checkpoint_bytes = checkpoint.read_bytes()
        service.recover()
        recovered = service.get_job(job['id'])
        if damage:
            assert recovered['status'] == 'interrupted' and recovered['result'] is None
            assert recovered['source_errors'][-1]['operation'] == 'recovery'
        else:
            assert recovered['status'] == 'completed' and recovered['result'] == result
            assert recovered['usage']['total_tokens'] == 8
        assert recovered['source_ids'] == [metadata['id']] and checkpoint.read_bytes() == checkpoint_bytes
        service.recover()
        assert service.get_job(job['id'])['version'] == recovered['version']
        provider.assert_awaited_once()


@pytest.mark.parametrize('damage', ['reader.html', 'original.html', 'changed_original'])
def test_unusable_archive_files_return_safe_error(client, monkeypatch, damage):
    service = configured(client)
    metadata = capture(service, monkeypatch)
    complete(service, metadata)
    folder = service.archives/metadata['id']/metadata['raw_sha256']
    if damage == 'changed_original':
        (folder/'original.html').write_bytes(b'corrupted archive')
    else:
        (folder/damage).unlink()
    for view in ('html', 'original'):
        response = client.get(f'/api/research/sources/{metadata["id"]}/{metadata["raw_sha256"]}/{view}')
        assert response.status_code == 404 and response.json()['detail'] == '归档文件暂不可读取。'


def test_recovery_keeps_live_jobs_and_scheduler_finalizes_orphans(client):
    service = configured(client)

    async def verify():
        service.scheduler.cancel()
        await asyncio.gather(service.scheduler, return_exceptions=True)
        tick, checked = asyncio.Event(), asyncio.Event()
        sleep = asyncio.sleep

        async def clock(seconds):
            if seconds != 30:
                return await sleep(seconds)
            await tick.wait()
            tick.clear()

        async def provider(*args):
            await asyncio.Event().wait()

        async def check_watches():
            checked.set()

        with patch('medvisit.research.service.asyncio.sleep', clock), \
             patch.object(service, 'check_due_watches', side_effect=check_watches), \
             patch('medvisit.research.service.run_agent', side_effect=provider) as model:
            await service.start_scheduler()
            try:
                active = await service.start(ResearchRequest(kind='policy', query='软件测试存活任务'))
                await asyncio.to_thread(service.recover)
                assert service.get_job(active['id'])['status'] == 'running'
                await service.cancel(active['id'])
                orphan = await asyncio.to_thread(service._create_job, ResearchRequest(kind='policy', query='软件测试孤立任务'))
                tick.set()
                await asyncio.wait_for(checked.wait(), 2)
                assert service.get_job(orphan['id'])['status'] == 'interrupted'
                model.assert_awaited_once()
            finally:
                service.scheduler.cancel()
                await asyncio.gather(service.scheduler, return_exceptions=True)

    client.portal.call(verify)
