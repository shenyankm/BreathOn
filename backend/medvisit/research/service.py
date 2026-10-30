"""Persist research runs, source history and explicitly enabled daily watches."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import re

from fastapi import HTTPException

from ..platform.store import now
from .agents import PROFILES, observations, run_agent, validate_result
from .archive import canonical_url, write_private
from .models import ResearchResult

logger = logging.getLogger('medvisit.research')


class ResearchService:
    def __init__(self, store, settings, current_user):
        self.store, self.settings, self.current_user = store, settings, current_user
        self.base = settings.records / 'research'
        self.archives = self.base / 'sources'
        self.tasks = set()
        self.job_tasks = {}
        self.scheduler = None
        self._lifecycle = asyncio.Lock()
        self._closing = False

    @property
    def workspace(self):
        return self.current_user()['workspace']

    def list(self, kind):
        with self.store.transaction(write=False) as tx:
            return tx.list(self.workspace, kind)

    def _observations(self, job_id):
        try:
            captured = observations(self.base / 'jobs' / job_id)
            if any(not isinstance(captured.get(key), list) for key in ('queries','search_results','archives','errors')):
                raise ValueError('Invalid observations')
            if (any(not isinstance(query, str) for query in captured['queries'])
                    or any(not isinstance(item, dict) for item in captured['search_results'])
                    or any(not isinstance(item, dict) or not all(isinstance(item.get(key), str)
                        for key in ('id','url','title','raw_sha256','text_sha256','retrieved_at','resolved_url'))
                        for item in captured['archives'])
                    or any(not isinstance(item, dict) or not all(isinstance(item.get(key), str)
                        for key in ('operation','message')) or ('url' in item and not isinstance(item['url'], str))
                        for item in captured['errors'])):
                raise ValueError('Invalid observation entries')
            return captured
        except (OSError, ValueError, AttributeError):
            return {'queries':[], 'search_results':[], 'archives':[], 'errors':[{
                'operation':'recovery', 'message':'检索检查记录暂不可读取或已损坏，已保留原文件，请人工核对。'}]}

    def get_job(self, job_id):
        with self.store.transaction(write=False) as tx:
            job = tx.get(self.workspace, 'research_job', job_id)
        if not job:
            raise HTTPException(404, '检索记录不存在。')
        if job['status'] == 'running':
            captured = self._observations(job['id'])
            job['progress'] = {'searches':len(captured['queries']), 'archives':len(captured['archives'])}
        return job

    def _create_job(self, request, watch_id=None):
        if not self.settings.deepseek_api_key or not self.settings.deepseek_search_enabled:
            raise HTTPException(503, '请先配置 DeepSeek 并开启 DEEPSEEK_SEARCH_ENABLED。')
        private = re.search(r'(?<!\d)(?:1[3-9]\d{9}|\d{17}[\dXx])(?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', request.query)
        if private or self.settings.deepseek_api_key in request.query:
            raise HTTPException(422, '检索仅使用公开职业、药品或政策关键词，请移除联系方式、身份信息及密钥。')
        with self.store.transaction(self.workspace) as tx:
            if any(job['status'] == 'running' for job in tx.list(self.workspace, 'research_job')):
                raise HTTPException(409, '已有检索正在进行，请等待本次完成。')
            previous = []
            for source in PROFILES[request.kind].get('seed_sources', []):
                if any(term.casefold() in request.query.casefold() for term in source['terms']):
                    previous.append(source['url'])
            if watch_id:
                watch = tx.get(self.workspace, 'research_watch', watch_id)
                if not watch or not watch['enabled']:
                    raise HTTPException(409, '该主题的追踪已关闭。')
                for source_id in watch.get('source_ids', []):
                    source = tx.get(self.workspace, 'research_source', source_id)
                    if source:
                        previous.append(source['url'])
                tx.update(self.workspace, 'research_watch', watch_id,
                    {**watch, 'next_check_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}, watch['version'])
            return tx.create(self.workspace, 'research_job', {**request.model_dump(), 'status':'running',
                'watch_id':watch_id, 'seed_urls':list(dict.fromkeys(previous))[:5], 'result':None, 'usage':{}, 'source_ids':[],
                'changes':[], 'error':'', 'reviewed':False})

    async def start(self, request, watch_id=None):
        async with self._lifecycle:
            if self._closing:
                raise HTTPException(503, '服务正在停止，请稍后重试。')
            creating = asyncio.create_task(asyncio.to_thread(self._create_job, request, watch_id))
            cancelled = False
            # Repeated cancellation cannot stop a database worker or release its lifecycle lock early.
            while not creating.done():
                try:
                    await asyncio.shield(creating)
                except asyncio.CancelledError:
                    cancelled = True
            job = creating.result()
            if cancelled:
                interrupting = asyncio.create_task(asyncio.to_thread(self._interrupt, job))
                while not interrupting.done():
                    try:
                        await asyncio.shield(interrupting)
                    except asyncio.CancelledError:
                        pass
                interrupting.result()
                raise asyncio.CancelledError
            task = asyncio.create_task(self._run(job))
            self.tasks.add(task)
            self.job_tasks[job['id']] = task
            task.add_done_callback(lambda completed:self._task_done(job['id'], completed))
            return job

    def _task_done(self, job_id, task):
        self.tasks.discard(task)
        self.job_tasks.pop(job_id, None)
        if not task.cancelled() and (error := task.exception()):
            logger.error('research_job_failed job_id=%s error_type=%s', job_id, type(error).__name__)

    async def cancel(self, job_id):
        async with self._lifecycle:
            job = await asyncio.to_thread(self.get_job, job_id)
            task = self.job_tasks.get(job_id)
            if job['status'] == 'running':
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                job = await asyncio.to_thread(self.get_job, job_id)
                if job['status'] == 'running':
                    interrupting = asyncio.create_task(asyncio.to_thread(self._interrupt, job))
                    cancelled = False
                    while not interrupting.done():
                        try:
                            await asyncio.shield(interrupting)
                        except asyncio.CancelledError:
                            cancelled = True
                    interrupting.result()
                    if cancelled:
                        raise asyncio.CancelledError
            return await asyncio.to_thread(self.get_job, job_id)

    async def _run(self, job):
        result, usage, error, interrupted = None, {}, '', False
        job_dir = self.base / 'jobs' / job['id']
        try:
            result, usage = await run_agent(self.settings, job['kind'], job['query'], self.archives, job_dir, job['seed_urls'])
        except asyncio.CancelledError:
            interrupted, error = True, '本次检索已停止，已归档的原件保留。'
        except (ValueError, TimeoutError) as exc:
            error = str(exc)[:500] or '检索超时，已归档的原件保留。'
        except Exception:
            error = '检索未完成，已归档的原件保留；请核对服务配置或稍后重试。'
        captured = self._observations(job['id'])
        if not usage:
            try:
                usage = json.loads((job_dir/'usage.json').read_text())
                if not isinstance(usage, dict):
                    raise ValueError('Invalid usage')
            except FileNotFoundError:
                usage = {}
            except (OSError, ValueError):
                usage = {}
                captured['errors'].append({'operation':'recovery',
                    'message':'模型用量记录暂不可读取或已损坏，已保留原文件；本次用量不完整。'})
        usage.update(search_requests=captured.get('search_requests', len(captured['queries'])),
            archive_attempts=len(captured['archives'])+sum(error['operation']=='archive' for error in captured['errors']))
        def finish():
            if result:
                try:
                    self._save_result(job, result, usage)
                except OSError:
                    logger.error('research_result_checkpoint_failed job_id=%s', job['id'])
            self._finish(job, result, usage, error, interrupted, captured)
        finalizing = asyncio.create_task(asyncio.to_thread(finish))
        cancelled = False
        while not finalizing.done():
            try:
                await asyncio.shield(finalizing)
            except asyncio.CancelledError:
                cancelled = True
        finalizing.result()
        if interrupted or cancelled:
            raise asyncio.CancelledError

    def _save_result(self, job, result, usage):
        report = deepcopy(result)
        for finding in report['findings']:
            for detail in finding['details']:
                detail.pop('quote', None)
                detail.pop('source_version', None)
        write_private(self.base/'jobs'/job['id']/'result.json', json.dumps({'result':report,'usage':usage}).encode())

    def _finish(self, job, result, usage, error, interrupted, captured):
        checked_at, source_ids, changes = now(), [], []
        archived = {source['id']:source for source in captured['archives']}
        baselines = {}
        with self.store.transaction(self.workspace) as tx:
            for metadata in captured['archives']:
                source_id = metadata['id']
                old = tx.get(self.workspace, 'research_source', source_id)
                previous = baselines.setdefault(source_id, old.get('latest') if old else None)
                status = 'first_archive' if not previous else 'unchanged' if previous['raw_sha256'] == metadata['raw_sha256'] else (
                    'page_changed' if previous['text_sha256'] == metadata['text_sha256'] else 'content_changed')
                versions = old.get('versions', []) if old else []
                if not any(version['raw_sha256'] == metadata['raw_sha256'] for version in versions):
                    versions = [*versions, metadata]
                data = {**(old or {}), 'url':metadata['url'], 'title':metadata['title'], 'latest':metadata,
                    'versions':versions, 'last_checked_at':metadata['retrieved_at'], 'last_check_error':'',
                    'change_status':status, 'research_kinds':sorted(set((old or {}).get('research_kinds', [])+[job['kind']]))}
                if old:
                    tx.update(self.workspace, 'research_source', source_id, data, old['version'])
                else:
                    tx.create(self.workspace, 'research_source', data, item_id=source_id)
                if source_id not in source_ids:
                    source_ids.append(source_id)
                changes = [change for change in changes if change['source_id']!=source_id]
                changes.append({'source_id':source_id, 'title':metadata['title'], 'status':status,
                    'previous_version':previous['raw_sha256'] if previous else None, 'version':metadata['raw_sha256']})
            for failure in captured['errors']:
                if failure.get('operation') != 'archive' or not failure.get('url'):
                    continue
                try:
                    source_id = hashlib.sha256(canonical_url(failure['url']).encode()).hexdigest()[:24]
                except ValueError:
                    continue
                old = tx.get(self.workspace, 'research_source', source_id)
                if old and source_id not in archived:
                    tx.update(self.workspace, 'research_source', source_id,
                        {**old, 'last_checked_at':checked_at, 'last_check_error':failure['message']}, old['version'])
            status = 'interrupted' if interrupted else 'completed' if result and result['findings'] and not captured['errors'] else 'partial' if source_ids else 'failed'
            current = tx.get(self.workspace, 'research_job', job['id'])
            finished = tx.update(self.workspace, 'research_job', job['id'], {**current, 'status':status,
                'finished_at':checked_at, 'result':result, 'usage':usage, 'error':error,
                'source_ids':source_ids, 'changes':changes, 'search_queries':captured['queries'],
                'search_results':captured['search_results'], 'source_errors':captured['errors'],
                'currency_notice':'仅表示本次检索范围与核验时间；页面内容变化仍需核对，法律效力、医生任职与药品信息不由哈希判定。'}, current['version'])
            if job.get('watch_id'):
                watch = tx.get(self.workspace, 'research_watch', job['watch_id'])
                if watch:
                    tx.update(self.workspace, 'research_watch', watch['id'], {**watch,
                        'last_job_id':job['id'], 'last_checked_at':checked_at, 'last_status':finished['status'],
                        'last_error':'' if finished['status'] == 'completed' else error or '部分来源仍待核对。'}, watch['version'])

    def set_watch(self, job_id, enabled):
        with self.store.transaction(self.workspace) as tx:
            job = tx.get(self.workspace, 'research_job', job_id)
            if not job:
                raise HTTPException(404, '检索记录不存在。')
            if job['status'] not in ('completed', 'partial') or not job['source_ids']:
                raise HTTPException(409, '先完成一次原文归档，再开启追踪。')
            watch_id = hashlib.sha256(f'{job["kind"]}\n{job["query"]}'.encode()).hexdigest()[:24]
            old = tx.get(self.workspace, 'research_watch', watch_id)
            data = {**(old or {}), 'kind':job['kind'], 'query':job['query'], 'enabled':enabled,
                'last_job_id':job_id, 'last_checked_at':job.get('finished_at'), 'last_status':job['status'],
                'source_ids':job['source_ids'][:5], 'next_check_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}
            return tx.update(self.workspace, 'research_watch', watch_id, data, old['version']) if old else tx.create(
                self.workspace, 'research_watch', data, item_id=watch_id)

    def _interrupt(self, job):
        captured = self._observations(job['id'])
        try:
            saved = json.loads((self.base/'jobs'/job['id']/'result.json').read_text())
            if not isinstance(saved, dict) or not isinstance(saved.get('usage'), dict):
                raise ValueError('Invalid saved result')
            result = validate_result(ResearchResult.model_validate(saved.get('result')),
                PROFILES[job['kind']], self.archives, captured)
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            captured['errors'].append({'operation':'recovery',
                'message':'已保存结果未通过恢复校验，原文件保留，请重新核对来源。'})
        else:
            self._finish(job, result, saved['usage'], '', False, captured)
            return
        self._finish(job, None, {}, '上次服务结束前检索未完成，已落盘的原件保留，可重新检索。',
            True, captured)

    def recover(self):
        for job in self.list('research_job'):
            task = self.job_tasks.get(job['id'])
            if job['status'] == 'running' and (task is None or task.done()):
                self._interrupt(job)

    async def check_due_watches(self):
        from .models import ResearchRequest
        for watch in await asyncio.to_thread(self.list, 'research_watch'):
            if not watch['enabled'] or datetime.fromisoformat(watch['next_check_at']) > datetime.now(timezone.utc):
                continue
            try:
                await self.start(ResearchRequest(kind=watch['kind'], query=watch['query']), watch['id'])
            except HTTPException as exc:
                if exc.status_code == 409:
                    return
                await asyncio.to_thread(self._watch_error, watch['id'], str(exc.detail))
            return

    def _watch_error(self, watch_id, message):
        with self.store.transaction(self.workspace) as tx:
            watch = tx.get(self.workspace, 'research_watch', watch_id)
            if watch:
                tx.update(self.workspace, 'research_watch', watch_id, {**watch, 'last_error':message,
                    'next_check_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}, watch['version'])

    async def start_scheduler(self):
        await asyncio.to_thread(self.recover)

        async def poll():
            while True:
                await asyncio.sleep(30)
                try:
                    async with self._lifecycle:
                        await asyncio.to_thread(self.recover)
                    await self.check_due_watches()
                except Exception as exc:
                    # A storage outage must not stop future checks or trigger a retry storm.
                    logger.error('research_watch_check_failed error_type=%s', type(exc).__name__)
                    continue

        self.scheduler = asyncio.create_task(poll())

    async def close(self):
        async with self._lifecycle:
            self._closing = True
            tasks = [*self.tasks, *([self.scheduler] if self.scheduler else [])]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # A task cancelled before its first step never enters _run's cancellation handler.
            recovering = asyncio.create_task(asyncio.to_thread(self.recover))
            cancelled = False
            while not recovering.done():
                try:
                    await asyncio.shield(recovering)
                except asyncio.CancelledError:
                    cancelled = True
            recovering.result()
            if cancelled:
                raise asyncio.CancelledError
