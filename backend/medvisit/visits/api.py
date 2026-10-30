"""Visit notes stay distinct from simulated training and reviewed evidence."""
import asyncio
from datetime import date, datetime, timedelta, timezone
import os
from pathlib import Path
import re
import shutil
import subprocess
import json
import hashlib
import secrets
import httpx
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from ..core.identity import current_role
from ..platform.store import now
from ..platform.models import content_usable
from ..agents.web_search import public_url

MAX_AUDIO = 100_000_000
MEDIA_TYPES = {'audio/webm': ('matroska', 'webm'), 'audio/mpeg': ('mp3',), 'audio/mp4': ('mov', 'mp4', 'm4a'), 'audio/x-m4a': ('mov', 'mp4', 'm4a'), 'audio/wav': ('wav',), 'audio/x-wav': ('wav',)}


class VisitInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    doctor_id: str = Field(default='', max_length=80)
    drug_id: str = Field(default='', max_length=80)
    visited_at: date
    text: str = Field(default='', max_length=30000)


class CreateVisit(VisitInput):
    source: Literal['self_report', 'recording'] = 'self_report'
    private_audio: bool = False


class EditVisit(VisitInput):
    version: int = Field(ge=1)


class Speaker(BaseModel):
    model_config = ConfigDict(extra='forbid')
    speaker_id: str = Field(min_length=1, max_length=100)
    role: Literal['doctor', 'representative', 'other', 'unknown']


class ConfirmVisit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=1)
    redacted_text: str = Field(min_length=1, max_length=30000)
    redaction_confirmed: Literal[True]
    speakers: list[Speaker] = Field(default_factory=list, max_length=50)


class ReviewVisit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=1)
    decision: Literal['scenario', 'needs_evidence', 'reject', 'fact']
    reason: str = Field(min_length=1, max_length=2000)
    content_id: str = Field(default='', max_length=80)
    page: int | None = Field(default=None, ge=1)
    quote: str = Field(default='', max_length=2000)
    identity_confirmed: bool = False


def redact_suggestions(text):
    # Suggestions are advisory: people must verify the whole transcript before sharing.
    patterns = [r'(?<!\d)1[3-9]\d{9}(?!\d)', r'(?<!\d)\d{17}[0-9Xx](?!\w)', r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}']
    result = text
    for pattern in patterns:
        result = re.sub(pattern, '[已隐藏]', result)
    return result


def verify_audio(path, content_type):
    probe = shutil.which('ffprobe')
    if not probe:
        raise HTTPException(503, '音频校验服务未配置，请联系管理员。')
    try:
        result = subprocess.run([probe, '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', str(path)], capture_output=True, timeout=20, check=True)
        data = json.loads(result.stdout)
        names = set(data['format']['format_name'].split(','))
        duration = float(data['format']['duration'])
        if not names.intersection(MEDIA_TYPES[content_type]) or not 0 < duration <= 1800 or not any(x.get('codec_type') == 'audio' for x in data.get('streams', [])):
            raise ValueError
        return duration
    except (subprocess.SubprocessError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(422, '音频格式无效或时长超过30分钟。') from None


def visits_router(store, settings, current_user):
    router = APIRouter(prefix='/api/visits')
    audio_dir = Path(settings.records).parent / 'visit-audio'
    slots = asyncio.Semaphore(1)
    tasks = set()
    lifecycle = asyncio.Lock()
    closing = False

    async def work(function, *args):
        worker = asyncio.create_task(asyncio.to_thread(function, *args))
        cancelled = False
        # Keep lifecycle guards until the transaction and private-file cleanup finish.
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                cancelled = True
        result = worker.result()
        if cancelled:
            raise asyncio.CancelledError
        return result

    def has_private_text(item):
        return item.get('source') == 'recording' or item.get('private_audio', False)

    def retention_expired(item):
        if not has_private_text(item):
            return False
        start = item.get('audio_uploaded_at') or item.get('created_at')
        if not start:
            return False
        deadline = datetime.fromisoformat(start) + timedelta(days=30)
        if item.get('confirmed_at'):
            deadline = min(deadline, datetime.fromisoformat(item['confirmed_at']) + timedelta(days=7))
        return datetime.now(timezone.utc) >= deadline

    def remove_provider_files(name):
        if re.fullmatch(r'[a-f0-9]{32}', name or '') and audio_dir.is_dir():
            for path in audio_dir.glob(name + '_*.provider.ogg'):
                if re.fullmatch(r'[a-f0-9]{32}_[a-f0-9]{32}\.provider\.ogg', path.name):
                    path.unlink(missing_ok=True)

    def admin():
        return current_role.get() == 'admin'

    def get_item(tx, user, item_id):
        item = tx.get(user['workspace'], 'visit', item_id)
        if not item or (not admin() and item['owner_id'] != user['id']):
            raise HTTPException(404, '拜访记录不存在。')
        return item

    def private_read(item):
        name = item.get('transcript_file', '')
        if not name:
            return {}
        if not re.fullmatch(r'[a-f0-9]{32}\.transcript', name):
            raise HTTPException(409, '录音转写文件不可读取。')
        try:
            data = json.loads((audio_dir / name).read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError
            return data
        except (OSError, ValueError):
            raise HTTPException(409, '录音转写文件不可读取。') from None

    def private_write(data):
        audio_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(audio_dir, 0o700)
        name = uuid4().hex + '.transcript'
        path = audio_dir / name
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                json.dump(data, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            directory_fd = os.open(audio_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return name

    def private_delete(name):
        if re.fullmatch(r'[a-f0-9]{32}\.transcript', name or ''):
            (audio_dir / name).unlink(missing_ok=True)

    def public(item):
        result = {k: v for k, v in item.items() if k not in ('audio_path', 'provider_token_hash', 'transcript_file')}
        if has_private_text(item):
            if not retention_expired(item):
                result.update(private_read(item))
            result.setdefault('text', '')
            result.setdefault('segments', [])
        return result

    @router.get('')
    def list_visits(user=Depends(current_user)):
        with store.transaction(user['workspace'], write=admin()) as tx:
            items = [public(x) for x in tx.list(user['workspace'], 'visit') if admin() or x['owner_id'] == user['id']]
            if admin():
                tx.audit(user['workspace'], user['id'], 'visit.list', 'visit', '*')
            return items

    @router.post('', status_code=201)
    def create(body: CreateVisit, user=Depends(current_user)):
        transcript_file = ''
        try:
            with store.transaction(user['workspace']) as tx:
                data = body.model_dump(mode='json')
                if body.source == 'recording' or body.private_audio:
                    text = data.pop('text')
                    if text:
                        transcript_file = private_write({'text':text, 'segments':[]})
                item = tx.create(user['workspace'], 'visit', {**data, 'transcript_file':transcript_file, 'owner_id': user['id'],
                    'status':'draft', 'redacted_text':'', 'speakers':[], 'audio_status':'none', 'audio_path':'',
                    'audio_uploaded_at':None, 'confirmed_at':None, 'review':None})
                tx.audit(user['workspace'], user['id'], 'visit.create', 'visit', item['id'])
            return public(item)
        except BaseException:
            private_delete(transcript_file)
            raise

    @router.get('/{item_id}')
    def detail(item_id: str, user=Depends(current_user)):
        with store.transaction(user['workspace'], write=admin()) as tx:
            item = get_item(tx, user, item_id)
            if admin():
                tx.audit(user['workspace'], user['id'], 'visit.read', 'visit', item_id)
            response = public(item)
            return response | {'redaction_suggestion':redact_suggestions(response.get('text', ''))}

    @router.put('/{item_id}')
    def edit(item_id: str, body: EditVisit, user=Depends(current_user)):
        replacement, old_file = '', ''
        try:
            with store.transaction(user['workspace']) as tx:
                item = get_item(tx, user, item_id)
                if item['owner_id'] != user['id']:
                    raise HTTPException(403, '仅记录本人可修改原文。')
                data = body.model_dump(mode='json', exclude={'version'})
                if has_private_text(item):
                    text = data.pop('text')
                    if item.get('audio_status') == 'deleted' and text:
                        raise HTTPException(409, '原始转写已到期删除，请编辑脱敏内容。')
                    old_file = item.get('transcript_file', '')
                    raw = private_read(item)
                    if text or raw:
                        replacement = private_write({**raw, 'text':text})
                    data['transcript_file'] = replacement
                updated = tx.update(user['workspace'], 'visit', item_id, {**item, **data, 'status':'draft', 'review':None}, body.version)
                tx.audit(user['workspace'], user['id'], 'visit.edit', 'visit', item_id)
            private_delete(old_file)
            return public(updated)
        except BaseException:
            private_delete(replacement)
            raise

    @router.post('/{item_id}/confirm')
    def confirm(item_id: str, body: ConfirmVisit, user=Depends(current_user)):
        if not body.redacted_text.strip():
            raise HTTPException(422, '请填写确认后的脱敏文字。')
        with store.transaction(user['workspace']) as tx:
            item = get_item(tx, user, item_id)
            if item['owner_id'] != user['id']:
                raise HTTPException(403, '仅记录本人可确认转写。')
            confirmed = item.get('confirmed_at') or now()
            updated = tx.update(user['workspace'], 'visit', item_id, {**item, 'redacted_text':body.redacted_text,
                'speakers':[x.model_dump() for x in body.speakers], 'confirmed_at':confirmed, 'status':'submitted', 'review':None}, body.version)
            tx.audit(user['workspace'], user['id'], 'visit.confirm', 'visit', item_id)
            return public(updated)

    @router.post('/{item_id}/review')
    def review(item_id: str, body: ReviewVisit, user=Depends(current_user)):
        if not admin():
            raise HTTPException(403, '只有管理员可以审核。')
        with store.transaction(user['workspace']) as tx:
            item = get_item(tx, user, item_id)
            if item['status'] != 'submitted' or not item.get('redacted_text'):
                raise HTTPException(409, '请先确认脱敏内容。')
            case_id, doctor_draft_id = None, None
            if body.decision == 'fact':
                doctor = tx.get(user['workspace'], 'doctor', item.get('doctor_id', ''))
                content = tx.get(user['workspace'], 'content', body.content_id)
                if not doctor or doctor.get('status') != 'published' or doctor.get('doctor_id'):
                    raise HTTPException(409, '请选择一位已发布的医生。')
                if not body.identity_confirmed:
                    raise HTTPException(422, '请确认公开资料与此医生身份一致。')
                if not content_usable(content) or not public_url((content or {}).get('source_url', '')):
                    raise HTTPException(422, '请选用已审核且有效的公开来源资料。')
                page = next((p for p in content['pages'] if p['number'] == body.page), None)
                quote = body.quote.strip()
                if not page or not quote or doctor['name'] not in quote or quote not in page['text']:
                    raise HTTPException(422, '引文须逐字来自所选页并包含医生姓名。')
                facts = (doctor.get('public_facts', '').rstrip() + '\n' + quote).strip()
                sources = list(dict.fromkeys([*doctor.get('sources', []), content['source_url']]))
                if len(facts) > 3000 or len(sources) > 8:
                    raise HTTPException(422, '画像事实或来源超出上限，请先整理现有画像。')
                data = {k:v for k,v in doctor.items() if k not in ('id', 'version', 'created_at', 'updated_at', 'approved_by', 'approved_at', 'review_reason')}
                data.update(status='draft', created_by=user['id'], previous_id=doctor['id'],
                    series_id=doctor.get('series_id', doctor['id']), doctor_id=doctor['id'], base_version=doctor['version'],
                    background_type='public', public_facts=facts, sources=sources,
                    fact_evidence=[*doctor.get('fact_evidence', []), {'content_id':content['id'], 'content_version':content['version'],
                        'page':body.page, 'quote':quote, 'source_url':content['source_url'],
                        'identity_status':'待再次核对', 'reviewed_by':user['id']}])
                draft = tx.create(user['workspace'], 'doctor', data)
                doctor_draft_id = draft['id']
                tx.audit(user['workspace'], user['id'], 'doctor.fact_draft', 'doctor', draft['id'], {'visit_id':item_id, 'content_id':content['id']})
            if body.decision == 'scenario':
                case = tx.create(user['workspace'], 'case', {'title':'真实拜访沟通情境',
                    'situation':item['redacted_text'][:2000], 'approach':'根据该情境练习需求探询和专业沟通。',
                    'rationale':body.reason, 'limitations':'代表自述或转写仅用于模拟沟通，不作为医学事实或真人性格依据。',
                    'status':'confirmed', 'created_by':user['id'], 'confirmed_by':user['id'],
                    'origin_visit_id':item_id, 'origin_verified':False, 'quotes':[], 'documents':[], 'citations':[]})
                case_id = case['id']
            updated = tx.update(user['workspace'], 'visit', item_id, {**item, 'status':'reviewed',
                'review':{'decision':body.decision, 'reason':body.reason, 'actor':user['id'], 'time':now(), 'case_id':case_id, 'doctor_draft_id':doctor_draft_id}}, body.version)
            tx.audit(user['workspace'], user['id'], 'visit.review', 'visit', item_id, {'decision':body.decision})
            return public(updated)

    @router.post('/{item_id}/audio', status_code=202)
    async def upload(item_id: str, request: Request, user=Depends(current_user)):
        if request.headers.get('x-recording-authorized') != 'true':
            raise HTTPException(422, '请先确认录音处理、管理员访问和第三方语音服务。')
        content_type = request.headers.get('content-type', '').split(';', 1)[0].lower()
        if content_type not in MEDIA_TYPES:
            raise HTTPException(415, '请上传 MP3、M4A 或 WAV 音频。')
        with store.transaction(user['workspace'], write=False) as tx:
            item = get_item(tx, user, item_id)
            if item['owner_id'] != user['id']:
                raise HTTPException(403, '仅记录本人可上传录音。')
            if not has_private_text(item):
                raise HTTPException(409, '请新建语音自述草稿，再录音上传。')
            if item['audio_status'] != 'none':
                raise HTTPException(409, '该记录已上传录音。')
            if retention_expired(item):
                raise HTTPException(409, '录音的保留期限已到，请新建记录。')
        audio_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(audio_dir, 0o700)
        name = uuid4().hex
        path = audio_dir / name
        size = 0
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as output:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_AUDIO:
                        raise HTTPException(413, '录音超过100MB。')
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if not size:
                raise HTTPException(422, '录音为空。')
            duration = await asyncio.to_thread(verify_audio, path, content_type)
            with store.transaction(user['workspace']) as tx:
                item = get_item(tx, user, item_id)
                if item['audio_status'] != 'none':
                    raise HTTPException(409, '该记录已上传录音。')
                updated = tx.update(user['workspace'], 'visit', item_id, {**item, 'audio_path':name, 'audio_type':content_type,
                    'audio_duration':duration, 'audio_uploaded_at':now(), 'audio_status':'transcription_unavailable',
                    'recording_authorized':True}, item['version'])
                tx.audit(user['workspace'], user['id'], 'visit.audio_upload', 'visit', item_id)
            return public(updated)
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    @router.get('/{item_id}/audio')
    def audio(item_id: str, user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            item = get_item(tx, user, item_id)
            name = item.get('audio_path', '')
            if retention_expired(item) or not re.fullmatch(r'[a-f0-9]{32}', name) or not (audio_dir / name).is_file():
                raise HTTPException(404, '录音不存在或已删除。')
            tx.audit(user['workspace'], user['id'], 'visit.audio_read', 'visit', item_id)
            return FileResponse(audio_dir / name, media_type=item['audio_type'], headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})

    async def run_job(workspace, item_id, token=None):
        def read():
            with store.transaction(workspace, write=False) as tx:
                return tx.get(workspace, 'visit', item_id)

        async with slots:
            item = await work(read)
            if not item or item.get('audio_status') not in ('queued', 'transcribing'):
                return
            job_id = item['transcription_job_id']

            def finish(status):
                with store.transaction(workspace) as tx:
                    item = tx.get(workspace, 'visit', item_id)
                    if item and item.get('audio_status') == 'transcribing' and item.get('transcription_job_id') == job_id:
                        tx.update(workspace, 'visit', item_id, {**item, 'audio_status':status,
                            'provider_token_hash':'', 'provider_token_expires':None}, item['version'])
                        remove_provider_files(item.get('audio_path', ''))

            headers = {'X-Api-Key': settings.asr_api_key, 'X-Api-Resource-Id': 'volc.seedasr.auc',
                       'X-Api-Request-Id': job_id, 'X-Api-Sequence': '-1'}
            async with httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
                if token:
                    origins = [origin for origin in settings.origins if origin.startswith('https://')]
                    if not origins or not settings.asr_api_key:
                        return
                    def begin():
                        with store.transaction(workspace) as tx:
                            item = tx.get(workspace, 'visit', item_id)
                            if not item or item.get('audio_status') != 'queued' or item.get('transcription_job_id') != job_id:
                                return None
                            return tx.update(workspace, 'visit', item_id, {**item, 'audio_status':'transcribing', 'provider_token_expires':(datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()}, item['version'])
                    item = await work(begin)
                    if item is None:
                        return
                    body = {'user':{'uid':job_id}, 'audio':{'url':f'{origins[0]}/api/visits/{item_id}/provider-audio?token={token}',
                        'format':{'audio/webm':'ogg', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/x-m4a':'m4a', 'audio/wav':'wav', 'audio/x-wav':'wav'}[item['audio_type']]},
                        'request':{'model_name':'bigmodel', 'enable_speaker_info':True, 'show_utterances':True,
                                   'ssd_version':'200', 'ssd_mode':1 if item['audio_duration'] > 180 else 0}}
                    if item['audio_type'] == 'audio/webm':
                        body['audio']['codec'] = 'opus'
                    try:
                        response = await client.post('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', headers=headers, json=body)
                        # A timeout may have accepted the paid request; only query its existing ID.
                        if response.headers.get('X-Api-Status-Code') != '20000000':
                            raise ValueError('provider rejected job')
                    except (httpx.HTTPError, ValueError):
                        pass
                for _ in range(720):
                    item = await work(read)
                    if not item or item.get('audio_status') != 'transcribing' or item.get('transcription_job_id') != job_id:
                        return
                    try:
                        response = await client.post('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', headers=headers, json={})
                        code = response.headers.get('X-Api-Status-Code', '')
                        if code in ('20000001', '20000002'):
                            await asyncio.sleep(15)
                            continue
                        if code and code not in ('20000000', '20000001', '20000002'):
                            await work(finish, 'transcription_failed')
                            return
                        data = response.json() if code == '20000000' else None
                        result = data.get('result', {}) if isinstance(data, dict) else {}
                        text = result.get('text', '') if isinstance(result, dict) else ''
                        utterances = result.get('utterances', []) if isinstance(result, dict) else []
                        if not isinstance(text, str) or not text.strip() or len(text) > 30000 or not isinstance(utterances, list):
                            raise ValueError('invalid transcription')
                        segments = []
                        for part in utterances[:1000]:
                            if not isinstance(part, dict) or not isinstance(part.get('text'), str):
                                continue
                            extra = part.get('additions') if isinstance(part.get('additions'), dict) else {}
                            segments.append({'text':part['text'][:4000], 'start_time':part.get('start_time'),
                                             'end_time':part.get('end_time'), 'speaker_id':str(extra.get('speaker', 'unknown'))[:100]})
                        def persist():
                            replacement, old_file = '', ''
                            try:
                                with store.transaction(workspace) as tx:
                                    item = tx.get(workspace, 'visit', item_id)
                                    if item and item.get('audio_status') == 'transcribing' and item.get('transcription_job_id') == job_id:
                                        raw = private_read(item)
                                        old_file = item.get('transcript_file', '')
                                        replacement = private_write({'text':raw.get('text') or text, 'transcription_text':text, 'segments':segments})
                                        tx.update(workspace, 'visit', item_id, {**item, 'audio_status':'transcribed',
                                            'transcript_file':replacement, 'provider_token_hash':'', 'provider_token_expires':None}, item['version'])
                                private_delete(old_file)
                                if replacement:
                                    remove_provider_files(item.get('audio_path', ''))
                            except BaseException:
                                private_delete(replacement)
                                raise
                        await work(persist)
                        return
                    except (httpx.HTTPError, ValueError, TypeError):
                        await asyncio.sleep(15)
                await work(finish, 'transcription_interrupted')

    def launch(workspace, item_id, token=None):
        task = asyncio.create_task(run_job(workspace, item_id, token))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    @router.post('/{item_id}/transcription', status_code=202)
    async def transcribe(item_id: str, user=Depends(current_user)):
        if not settings.asr_api_key or not any(origin.startswith('https://') for origin in settings.origins):
            raise HTTPException(503, '录音转写服务尚未配置可访问的 HTTPS 地址或凭据。')
        token = secrets.token_urlsafe(32)
        job_id = str(uuid4())
        item = None

        def enqueue():
            nonlocal item
            with store.transaction(user['workspace']) as tx:
                current = get_item(tx, user, item_id)
                if current['owner_id'] != user['id']:
                    raise HTTPException(403, '仅记录本人可发起转写。')
                if current.get('audio_status') not in ('transcription_unavailable', 'transcription_interrupted', 'transcription_failed'):
                    raise HTTPException(409, '录音不存在或转写正在进行。')
                if not current.get('audio_path') or retention_expired(current):
                    raise HTTPException(409, '录音已删除或已到保留期限。')
                updated = tx.update(user['workspace'], 'visit', item_id, {**current, 'audio_status':'queued',
                    'transcription_job_id':job_id, 'provider_token_hash':hashlib.sha256(token.encode()).hexdigest(),
                    'provider_token_expires':(datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()}, current['version'])
                tx.audit(user['workspace'], user['id'], 'visit.transcription_start', 'visit', item_id)
            item = updated
            return item

        def interrupt():
            with store.transaction(user['workspace']) as tx:
                current = tx.get(user['workspace'], 'visit', item_id)
                if current and current.get('audio_status') == 'queued' and current.get('transcription_job_id') == job_id:
                    tx.update(user['workspace'], 'visit', item_id, {**current, 'audio_status':'transcription_interrupted',
                        'provider_token_hash':'', 'provider_token_expires':None}, current['version'])
                    tx.audit(user['workspace'], user['id'], 'visit.transcription_cancel', 'visit', item_id)

        async with lifecycle:
            if closing:
                raise HTTPException(503, '服务正在停止，请稍后重试。')
            try:
                await work(enqueue)
            except asyncio.CancelledError:
                if item is not None:
                    await work(interrupt)
                raise
            launch(user['workspace'], item_id, token)
            return public(item)

    @router.post('/{item_id}/transcription/cancel')
    def cancel_transcription(item_id: str, user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            item = get_item(tx, user, item_id)
            if item['owner_id'] != user['id']:
                raise HTTPException(403, '仅记录本人可取消转写。')
            if item.get('audio_status') not in ('queued', 'transcribing'):
                raise HTTPException(409, '当前没有进行中的转写。')
            updated = tx.update(user['workspace'], 'visit', item_id, {**item, 'audio_status':'transcription_interrupted',
                'provider_token_hash':'', 'provider_token_expires':None}, item['version'])
            tx.audit(user['workspace'], user['id'], 'visit.transcription_cancel', 'visit', item_id)
            remove_provider_files(item.get('audio_path', ''))
            return public(updated)

    @router.get('/{item_id}/provider-audio')
    def provider_audio(item_id: str, token: str, user=Depends(current_user)):
        # Only the ASR provider gets this expiring random token, stored as a hash.
        if len(token) > 100:
            raise HTTPException(404, '录音不存在。')
        digest = hashlib.sha256(token.encode()).hexdigest()
        def authorized():
            with store.transaction(user['workspace'], write=False) as tx:
                item = tx.get(user['workspace'], 'visit', item_id)
                expires = item.get('provider_token_expires') if item else None
                if (not item or not secrets.compare_digest(item.get('provider_token_hash', ''), digest)
                    or not expires or datetime.fromisoformat(expires) <= datetime.now(timezone.utc)
                    or item.get('audio_status') != 'transcribing' or retention_expired(item)):
                    raise HTTPException(404, '录音不存在。')
                name = item.get('audio_path', '')
                if not re.fullmatch(r'[a-f0-9]{32}', name) or not (audio_dir / name).is_file():
                    raise HTTPException(404, '录音不存在。')
                return item, name
        item, name = authorized()
        headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'}
        if item['audio_type'] != 'audio/webm':
            return FileResponse(audio_dir / name, media_type=item['audio_type'], headers=headers)
        encoder = shutil.which('ffmpeg')
        if not encoder:
            raise HTTPException(503, '音频转码服务未配置。')
        converted = audio_dir / (name + '_' + uuid4().hex + '.provider.ogg')
        try:
            fd = os.open(converted, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            subprocess.run([encoder, '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(audio_dir / name),
                '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k',
                '-f', 'ogg', '-y', str(converted)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=True, timeout=120)
            if not converted.stat().st_size or converted.stat().st_size > MAX_AUDIO:
                raise ValueError
            authorized()
        except HTTPException:
            converted.unlink(missing_ok=True)
            raise
        except (OSError, subprocess.SubprocessError, ValueError):
            converted.unlink(missing_ok=True)
            raise HTTPException(503, '音频转码失败，请稍后重试。') from None
        return FileResponse(converted, media_type='audio/ogg', headers=headers,
                            background=BackgroundTask(converted.unlink, missing_ok=True))

    def recover(workspace):
        if audio_dir.is_dir():
            for path in audio_dir.glob('*.provider.ogg'):
                if re.fullmatch(r'[a-f0-9]{32}_[a-f0-9]{32}\.provider\.ogg', path.name):
                    path.unlink(missing_ok=True)
        with store.transaction(workspace) as tx:
            for item in tx.list(workspace, 'visit'):
                if has_private_text(item) and any(k in item for k in ('text', 'transcription_text', 'segments')):
                    raw = {k:item[k] for k in ('text', 'transcription_text', 'segments') if k in item}
                    existing = private_read(item)
                    name = private_write({**raw, **existing})
                    clean = {k:v for k,v in item.items() if k not in ('text', 'transcription_text', 'segments')}
                    item = tx.update(workspace, 'visit', item['id'], {**clean, 'transcript_file':name}, item['version'])
                if item.get('audio_status') == 'queued':
                    tx.update(workspace, 'visit', item['id'], {**item, 'audio_status':'transcription_interrupted',
                        'provider_token_hash':'', 'provider_token_expires':None}, item['version'])
                elif item.get('audio_status') == 'transcribing':
                    launch(workspace, item['id'])

    async def close():
        nonlocal closing
        async with lifecycle:
            closing = True
            for task in tasks.copy():
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    def cleanup(workspace):
        cutoff = datetime.now(timezone.utc)
        with store.transaction(workspace) as tx:
            for item in tx.list(workspace, 'visit'):
                if not has_private_text(item):
                    continue
                uploaded = item.get('audio_uploaded_at') or item.get('created_at')
                if not uploaded:
                    continue
                deadline = datetime.fromisoformat(uploaded) + timedelta(days=30)
                if item.get('confirmed_at'):
                    deadline = min(deadline, datetime.fromisoformat(item['confirmed_at']) + timedelta(days=7))
                if cutoff < deadline or item.get('audio_status') == 'deleted':
                    continue
                name = item.get('audio_path', '')
                if re.fullmatch(r'[a-f0-9]{32}', name):
                    (audio_dir / name).unlink(missing_ok=True)
                    remove_provider_files(name)
                private_delete(item.get('transcript_file', ''))
                clean = {k:v for k,v in item.items() if k not in ('text', 'transcription_text', 'segments')}
                tx.update(workspace, 'visit', item['id'], {**clean, 'audio_path':'', 'audio_status':'deleted', 'transcript_file':'', 'provider_token_hash':'', 'provider_token_expires':None}, item['version'])
                tx.audit(workspace, 'system', 'visit.audio_delete', 'visit', item['id'])
            # Files orphaned by a crash are not referenced by any committed visit.
            referenced = {row.get('transcript_file') for row in tx.list(workspace, 'visit')}
            if audio_dir.is_dir():
                for path in audio_dir.glob('*.transcript'):
                    if path.name not in referenced:
                        private_delete(path.name)
                for path in audio_dir.glob('*.provider.ogg'):
                    try:
                        if re.fullmatch(r'[a-f0-9]{32}_[a-f0-9]{32}\.provider\.ogg', path.name) and path.stat().st_mtime < cutoff.timestamp() - 3600:
                            path.unlink(missing_ok=True)
                    except FileNotFoundError:
                        pass

    router.visit_cleanup = cleanup
    router.visit_recover = recover
    router.visit_close = close
    router.visit_run_job = run_job
    return router
