"""Persist research runs, source history and explicitly enabled daily watches."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import re
import base64
import subprocess
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import ValidationError

from ..core.tasks import drain, work
from ..platform.store import now
from ..platform.models import Policy
from ..platform.pdf_extract import extract_pdf
from .agents import PROFILES, failure_kind, observations, run_agent, validate_result
from .archive import canonical_url, read_source, write_private
from .doctor import doctor_draft, candidate_draft, doctor_evidence, matched_finding
from .word_extract import extract_word
from .models import DoctorResearchRequest, ResearchResult

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
        self._shutdown_task = None

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

    def doctor_draft(self, job_id, body):
        job = self.get_job(job_id)
        if job['kind'] != 'doctor' or job['status'] not in ('completed', 'partial') or not job.get('result'):
            raise HTTPException(409, '请先完成医生公开资料检索。')
        captured = self._observations(job_id)
        try:
            report = deepcopy(job['result'])
            for finding in report['findings']:
                for detail in finding['details']:
                    detail.pop('quote', None)
                    detail.pop('source_version', None)
            result = validate_result(ResearchResult.model_validate(report), PROFILES['doctor'], self.archives, captured)
            finding = result['findings'][body.finding_index]
        except (ValueError, KeyError, IndexError, TypeError, OSError):
            raise HTTPException(409, '候选资料或原文无法核验，请重新检索。') from None
        details = finding['details']
        names = {d['value'].strip() for d in details if d['label'] == '姓名'}
        if names != {body.confirmed_name.strip()}:
            raise HTTPException(422, '请确认与候选来源一致的医生姓名。')
        try:
            doctor = candidate_draft(finding, result, captured['archives'])
            evidence = doctor_evidence(finding, captured['archives'])
        except (ValueError, KeyError):
            raise HTTPException(422, '候选身份不完整、存在冲突或字段超长，请核对来源后重试。') from None
        user = self.current_user()
        with self.store.transaction(self.workspace) as tx:
            current = tx.get(self.workspace, 'research_job', job_id)
            key = str(body.finding_index)
            automatic = bool(current.get('doctor_draft')) and finding == matched_finding(current['doctor_identity'], result)
            existing = (current.get('doctor_drafts') or {}).get(key) or (current.get('doctor_id') if automatic else None)
            if existing:
                draft = tx.get(self.workspace, 'doctor', existing)
                if draft and draft.get('status') != 'deleted':
                    return draft
            data = {**doctor, 'status':'draft', 'created_by':user['id'],
                'display_name':doctor['name']+'（训练模拟）', 'research_job_id':job_id,
                'research_finding_index':body.finding_index, 'research_evidence':evidence,
                'identity_confirmed_by':user['id'], 'identity_confirmed_at':now(),
                'research_caveats':finding.get('caveats', []) + result['further_checks'] + [d['value'] for d in details if d['label'] == '同名或时效疑点']}
            draft = tx.create(self.workspace, 'doctor', data)
            tx.update(self.workspace, 'research_job', job_id, {**current,
                'doctor_drafts':{**(current.get('doctor_drafts') or {}), key:draft['id']},
                **({'doctor_id':draft['id']} if automatic else {})}, current['version'])
            tx.audit(self.workspace, user['id'], 'doctor.research_draft', 'doctor', draft['id'], {'job_id':job_id})
            return draft

    def _policy_pages(self, data, kind):
        try:
            if kind == 'pdf':
                return extract_pdf(data)['pages']
            text = extract_word(data) if kind in ('doc', 'docx') else data.decode('utf-8')
            if not text.strip() or len(text) > 20000:
                raise ValueError('原文为空或超过单段限制，请人工分段录入并核对原件。')
            return [{'number':1, 'text':text}]
        except (ValueError, UnicodeError, OSError, subprocess.SubprocessError) as exc:
            raise HTTPException(422, str(exc) or '原文解析失败。') from None

    def _policy(self, title, pages, source_url=''):
        try:
            return Policy(title=title.strip()[:180], version_label='待审核版本', scope='待审核确认适用范围',
                pages=pages, source_url=source_url, legal_status='unknown')
        except ValueError:
            raise HTTPException(422, '政策标题或原文不符合导入要求。') from None

    def policy_draft(self, job_id, body):
        job = self.get_job(job_id)
        if job['kind'] != 'policy' or job['status'] not in ('completed', 'partial'):
            raise HTTPException(409, '请先完成政策原文归档。')
        captured = self._observations(job_id)
        if not any(a['id'] == body.source_id and a['raw_sha256'] == body.source_version for a in captured['archives']):
            raise HTTPException(404, '原文不属于本次检索。')
        try:
            metadata, text = read_source(self.archives, body.source_id, body.source_version)
        except (ValueError, OSError, KeyError):
            raise HTTPException(409, '原文归档不完整或已损坏，请重新核对。') from None
        host = urlsplit(metadata['resolved_url']).hostname or ''
        if host != 'gov.cn' and not host.endswith('.gov.cn'):
            raise HTTPException(422, '仅政府官网归档可作为官方政策原文导入。')
        folder = self.archives / body.source_id / body.source_version
        raw = (folder / metadata['original_file']).read_bytes() if metadata['kind'] == 'pdf' else text.encode('utf-8')
        pages = self._policy_pages(raw, 'pdf' if metadata['kind'] == 'pdf' else 'text')
        policy = self._policy(metadata['title'], pages, metadata['resolved_url'])
        user = self.current_user()
        key = body.source_id + ':' + body.source_version
        with self.store.transaction(self.workspace) as tx:
            current = tx.get(self.workspace, 'research_job', job_id)
            previous = (current.get('policy_drafts') or {}).get(key)
            if previous:
                existing = tx.get(self.workspace, 'policy', previous)
                if existing and existing.get('status') != 'deleted':
                    return existing
            asset = tx.create(self.workspace, 'asset', {'data':base64.b64encode(raw).decode(),
                'sha256':hashlib.sha256(raw).hexdigest(), 'size':len(raw), 'format':'pdf', 'created_by':user['id']}) if metadata['kind'] == 'pdf' else None
            item = tx.create(self.workspace, 'policy', {**policy.model_dump(mode='json'), 'status':'draft',
                'asset_id':asset['id'] if asset else None,
                'created_by':user['id'], 'research_job_id':job_id, 'research_source_id':body.source_id,
                'research_source_version':body.source_version, 'original_kind':metadata['kind'],
                'pagination':'pdf_pages' if metadata['kind'] == 'pdf' else 'text_document'})
            item = tx.update(self.workspace, 'policy', item['id'], {**item, 'series_id':item['id']}, item['version'])
            tx.update(self.workspace, 'research_job', job_id, {**current,
                'policy_drafts':{**(current.get('policy_drafts') or {}), key:item['id']}}, current['version'])
            tx.audit(self.workspace, user['id'], 'policy.research_draft', 'policy', item['id'], {'job_id':job_id})
            return item

    async def import_policy_file(self, title, data):
        async with self._lifecycle:
            if self._closing:
                raise HTTPException(503, '服务正在停止，请稍后重试。')
            return await work(self.policy_file, title, data)

    def policy_file(self, title, data):
        if len(data) > 20_000_000:
            raise HTTPException(413, '原文超过20MB。')
        kind = 'pdf' if data.startswith(b'%PDF-') else 'docx' if data.startswith(b'PK') else 'doc' if data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')) else None
        if not kind:
            raise HTTPException(415, '请选择 PDF、DOC 或 DOCX 原文。')
        pages = self._policy_pages(data, kind)
        policy = self._policy(title, pages)
        user = self.current_user()
        with self.store.transaction(self.workspace) as tx:
            asset = tx.create(self.workspace, 'asset' if kind == 'pdf' else 'research_upload', {'data':base64.b64encode(data).decode(),
                'sha256':hashlib.sha256(data).hexdigest(), 'size':len(data), 'format':kind, 'created_by':user['id']})
            item = tx.create(self.workspace, 'policy', {**policy.model_dump(mode='json'), 'status':'draft',
                'created_by':user['id'], 'asset_id':asset['id'] if kind == 'pdf' else None,
                'research_upload_id':asset['id'], 'original_kind':kind,
                'pagination':'pdf_pages' if kind == 'pdf' else 'text_document'})
            item = tx.update(self.workspace, 'policy', item['id'], {**item, 'series_id':item['id']}, item['version'])
            tx.audit(self.workspace, user['id'], 'policy.file_draft', 'policy', item['id'], {'asset_id':asset['id']})
            return item

    def policy_file_original(self, item_id):
        with self.store.transaction(self.workspace, write=False) as tx:
            item = tx.get(self.workspace, 'research_upload', item_id) or tx.get(self.workspace, 'asset', item_id)
        if not item:
            raise HTTPException(404, '政策原件不存在。')
        try:
            raw = base64.b64decode(item['data'], validate=True)
            if len(raw) != item['size'] or hashlib.sha256(raw).hexdigest() != item['sha256']:
                raise ValueError
        except (KeyError, ValueError, TypeError):
            raise HTTPException(409, '政策原件损坏。') from None
        return item, raw

    def _create_job(self, request, watch_id=None):
        if request.kind not in PROFILES:
            raise HTTPException(422, '该检索助手已停用，历史资料仍可查看。')
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
            identity = {'doctor_identity':request.model_dump()} if isinstance(request, DoctorResearchRequest) else {}
            return tx.create(self.workspace, 'research_job', {'kind':request.kind, 'query':request.query, **identity, 'status':'running',
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
                await work(self._interrupt, job)
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
            if self._closing:
                raise HTTPException(503, '服务正在停止，请稍后重试。')
            job = await work(self.get_job, job_id)
            task = self.job_tasks.get(job_id)
            if job['status'] == 'running':
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                job = await work(self.get_job, job_id)
                if job['status'] == 'running':
                    await work(self._interrupt, job)
            return await work(self.get_job, job_id)

    async def _run(self, job):
        result, usage, error, interrupted, kind = None, {}, '', False, ''
        job_dir = self.base / 'jobs' / job['id']
        try:
            if self._closing:
                raise asyncio.CancelledError
            result, usage = await run_agent(self.settings, job['kind'], job['query'], self.archives, job_dir, job['seed_urls'])
        except asyncio.CancelledError:
            interrupted, error = True, '本次检索已停止，已归档的原件保留。'
        except (ValueError, TimeoutError) as exc:
            error, kind = str(exc)[:500] or '检索超时，已归档的原件保留。', failure_kind(exc)
        except Exception as exc:
            error, kind = '检索未完成，已归档的原件保留；请核对服务配置或稍后重试。', failure_kind(exc)
        if kind:
            # One greppable line per failed job: count by kind to tell model/config faults from source-quality faults.
            logger.warning('research_job_failed_kind job_id=%s kind=%s agent=%s', job['id'], kind, job['kind'])
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
            self._finish(job, result, usage, error, interrupted, captured, kind)
        await work(finish)
        if interrupted:
            raise asyncio.CancelledError

    def _save_result(self, job, result, usage):
        report = deepcopy(result)
        for finding in report['findings']:
            for detail in finding['details']:
                detail.pop('quote', None)
                detail.pop('source_version', None)
        write_private(self.base/'jobs'/job['id']/'result.json', json.dumps({'result':report,'usage':usage}).encode())

    def _finish(self, job, result, usage, error, interrupted, captured, kind=''):
        checked_at, source_ids, changes = now(), [], []
        draft = {}
        if job.get('doctor_identity') and result and not interrupted:
            try:
                draft['doctor_draft'] = doctor_draft(job['doctor_identity'], result, captured['archives'])
                draft['doctor_draft']['research_job_id'] = job['id']
                draft['doctor_draft_error'] = ''
                draft['doctor_evidence'] = doctor_evidence(matched_finding(job['doctor_identity'], result), captured['archives'])
            except ValidationError:
                draft['doctor_draft_error'] = '资料超出角色字段限制，已保留检索结果；请在医生角色表单中手动精简录入。'
            except ValueError as exc:
                draft['doctor_draft_error'] = str(exc)
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
            finished = tx.update(self.workspace, 'research_job', job['id'], {**current, **draft, 'status':status,
                'finished_at':checked_at, 'result':result, 'usage':usage, 'error':error, 'error_kind':kind,
                'source_ids':source_ids, 'changes':changes, 'search_queries':captured['queries'],
                'source_metadata':[{key:source.get(key) for key in ('id','raw_sha256','url','resolved_url','title','kind','retrieved_at')} for source in captured['archives']],
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
            if enabled and job['kind'] not in PROFILES:
                raise HTTPException(422, '该检索助手已停用，不能开启追踪。')
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
        async with self._lifecycle:
            if self._closing:
                return
            watches = await work(self.list, 'research_watch')
        for watch in watches:
            if watch['kind'] not in PROFILES or not watch['enabled'] or datetime.fromisoformat(watch['next_check_at']) > datetime.now(timezone.utc):
                continue
            try:
                await self.start(ResearchRequest(kind=watch['kind'], query=watch['query']), watch['id'])
            except HTTPException as exc:
                if exc.status_code == 409:
                    return
                async with self._lifecycle:
                    if not self._closing:
                        await work(self._watch_error, watch['id'], str(exc.detail))
            return

    def _watch_error(self, watch_id, message):
        with self.store.transaction(self.workspace) as tx:
            watch = tx.get(self.workspace, 'research_watch', watch_id)
            if watch:
                tx.update(self.workspace, 'research_watch', watch_id, {**watch, 'last_error':message,
                    'next_check_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}, watch['version'])

    async def start_scheduler(self):
        async with self._lifecycle:
            if self._closing or (self.scheduler and not self.scheduler.done()):
                return
            await work(self.recover)

        async def poll():
            while True:
                await asyncio.sleep(30)
                try:
                    async with self._lifecycle:
                        if self._closing:
                            return
                        await work(self.recover)
                    await self.check_due_watches()
                except Exception as exc:
                    # A storage outage must not stop future checks or trigger a retry storm.
                    logger.error('research_watch_check_failed error_type=%s', type(exc).__name__)
                    if asyncio.current_task().cancelling():
                        raise asyncio.CancelledError
                    continue

        self.scheduler = asyncio.create_task(poll())

    async def close(self):
        self._closing = True
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self._close())
        await drain(self._shutdown_task)

    async def _close(self):
        async with self._lifecycle:
            tasks = [*self.tasks, *([self.scheduler] if self.scheduler else [])]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # A task cancelled before its first step never enters _run's cancellation handler.
            await work(self.recover)
