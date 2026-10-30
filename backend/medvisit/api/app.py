import asyncio
import base64
import contextlib
import json
import logging
import sqlite3
from pathlib import Path
from tempfile import TemporaryFile
from time import monotonic
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from ..voice.asr import AsrStream, asr_connection, request_packet, run_practice
from ..services.practice import PracticeDialogue
from ..services.final_review import review_training
from ..services.visit_summary import build_visit_summary
from ..services.service_status import check_services
from ..voice.protocol import BridgeError, DUPLEX_MODEL, GREETING, MAX_MESSAGE_BYTES, event, parse_client_message, session_config
from ..storage.records import FileRecords, SessionRecord
from ..storage.checkpoints import SessionCheckpoint, read_checkpoint
from ..storage.postgres import PostgresRecords

from ..core.config import Settings
from ..core.identity import current_actor, current_role
from ..agents.doctor import DOCTOR_PROFILE
from ..platform.store import PlatformStore, Conflict
from ..platform.api import platform_router
from ..platform.training import prepare_training, prepare_free_context, snapshot, check_materials, check_free_context, doctor_instructions, opening as training_opening
from ..platform.progress import capture_prices
from ..platform.compliance import assess_policy
from ..research.api import research_router
from ..research.service import ResearchService
from ..knowledge.corpus import MedicalCorpus, platform_approved_documents
from ..knowledge.verify import MedicalVerifier
from ..knowledge.api import medical_router
from ..knowledge.live import LiveMedicalChecks
from .middleware import ApiMiddleware
from .auth import Authentication, AuthenticationMiddleware
from .admin_records import admin_records_router
from ..visits.api import visits_router

logger = logging.getLogger("medvisit")
MEDICAL_SNAPSHOT = Path(__file__).resolve().parents[1] / 'knowledge/snapshot'


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    store = PostgresRecords(settings.database_url) if settings.database_url else FileRecords(settings.records)
    platform = PlatformStore(settings.records / 'platform.sqlite3', pool=getattr(store, 'pool', None))
    router, initialize, current_user, operations = platform_router(platform, settings, store)
    research = ResearchService(platform, settings, current_user)
    medical_corpus = MedicalCorpus(settings.records / 'medical-wiki', seed=MEDICAL_SNAPSHOT, approved_documents=platform_approved_documents(platform, current_user))
    medical_verifier = MedicalVerifier(settings, medical_corpus)
    visits = visits_router(platform, settings, current_user)
    service_check_task = None
    readiness_task = None

    @contextlib.asynccontextmanager
    async def lifespan(app):
        async with contextlib.AsyncExitStack() as cleanup:
            cleanup.push_async_callback(asyncio.to_thread, store.close)
            await asyncio.to_thread(settings.records.mkdir, mode=0o700, parents=True, exist_ok=True)
            await asyncio.to_thread(store.open)
            await asyncio.to_thread(platform.open)
            await asyncio.to_thread(initialize)
            await asyncio.to_thread(visits.visit_cleanup, current_user()['workspace'])
            visits.visit_recover(current_user()['workspace'])
            cleanup.push_async_callback(visits.visit_close)
            async def cleanup_visits():
                while True:
                    await asyncio.sleep(3600)
                    try:
                        await visits.visit_work(visits.visit_cleanup, current_user()['workspace'])
                    except Exception as exc:
                        logger.error('visit_cleanup_failed error_type=%s', type(exc).__name__)
                        if asyncio.current_task().cancelling():
                            raise asyncio.CancelledError
            visit_cleanup_task = asyncio.create_task(cleanup_visits())
            async def close_visit_cleanup():
                visit_cleanup_task.cancel()
                await asyncio.gather(visit_cleanup_task, return_exceptions=True)
            cleanup.push_async_callback(close_visit_cleanup)
            cleanup.push_async_callback(research.close)
            await research.start_scheduler()
            async def close_checks():
                if service_check_task is not None and not service_check_task.done():
                    service_check_task.cancel()
                # Cancelling a readiness waiter cannot stop its thread; drain it before closing storage.
                tasks = [task for task in (service_check_task, readiness_task) if task is not None]
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            cleanup.push_async_callback(close_checks)
            async def close_sessions():
                sessions = list(active.values())
                for session in sessions:
                    session.cancel()
                if sessions:
                    draining = asyncio.gather(*sessions, return_exceptions=True)
                    cancelled = False
                    while not draining.done():
                        try:
                            await asyncio.shield(draining)
                        except asyncio.CancelledError:
                            cancelled = True
                    if cancelled:
                        raise asyncio.CancelledError
            cleanup.push_async_callback(close_sessions)
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False

    app = FastAPI(title="BreathOn", lifespan=lifespan)
    app.state.records = store
    app.state.platform = platform
    app.state.local_user = current_user()
    app.state.research = research
    app.state.medical_corpus = medical_corpus
    app.state.medical_verifier = medical_verifier
    app.state.ready = False
    auth = Authentication(settings)
    app.include_router(auth.router)
    app.include_router(router)
    app.include_router(research_router(research))
    app.include_router(medical_router(medical_corpus, medical_verifier))
    app.include_router(admin_records_router(store, platform, current_user))
    app.include_router(visits)
    active: dict[str, asyncio.Task] = {}
    active_users: set[str] = set()
    finishing: set[str] = set()

    app.add_middleware(AuthenticationMiddleware, auth=auth)
    app.add_middleware(ApiMiddleware, origins=settings.origins)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Unknown field names can themselves contain private input; bound and redact validation output.
        errors = []
        for error in exc.errors()[:20]:
            location = list(error['loc'][:8])
            if error['type'] == 'extra_forbidden' and location:
                location[-1] = '<extra_field>'
            errors.append({'loc':[item[:80] if isinstance(item, str) else item for item in location],
                'msg':error['msg'][:200], 'type':error['type']})
        return JSONResponse(status_code=422, content={'detail':errors})

    @app.exception_handler(Conflict)
    async def version_conflict(request, exc):
        return JSONResponse(status_code=409, content={'detail': str(exc)})

    @app.exception_handler(DatabaseError)
    @app.exception_handler(sqlite3.Error)
    @app.exception_handler(PoolTimeout)
    async def database_error(request, exc):
        message = '记录数据库暂时不可用，请稍后重试。'
        if isinstance(request, WebSocket):
            await asyncio.wait_for(request.send_json({'type':'error', 'code':'storage_unavailable', 'message':message}), 5)
            await asyncio.wait_for(request.close(code=1013), 5)
            return
        return JSONResponse(status_code=503, content={"detail": message})

    @app.get('/api/live')
    async def live():
        return {'status':'ok'}

    def check_storage():
        store.check()
        with platform.transaction(write=False) as tx:
            tx.execute('SELECT id FROM platform_entities LIMIT 1').fetchone()
        # PostgreSQL stores metadata; original documents also require writable local storage.
        with TemporaryFile(dir=settings.records) as probe:
            probe.write(b'healthcheck')
            probe.flush()

    @app.get('/api/ready')
    async def ready():
        nonlocal readiness_task
        if not app.state.ready:
            return JSONResponse({'status':'not_ready'}, status_code=503)
        if readiness_task is None or readiness_task.done():
            readiness_task = asyncio.create_task(asyncio.to_thread(check_storage))
            readiness_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        try:
            # A timed-out request cannot stop filesystem/database work in its thread.
            await asyncio.wait_for(asyncio.shield(readiness_task), 3)
        except Exception:
            return JSONResponse({'status':'not_ready'}, status_code=503)
        return {'status':'ok'}

    @app.get("/api/health")
    async def health():
        await asyncio.to_thread(store.check)
        analysis = bool(settings.deepseek_api_key and settings.deepseek_model)
        tts = bool(settings.tts_api_key and settings.tts_voice)
        return {"status": "ok", "storage": "postgresql" if settings.database_url else "json", "agent_framework": "agentscope", "voice_configured": bool(settings.api_key), "asr_configured": bool(settings.asr_api_key), "tts_configured": tts, "analysis_configured": analysis, "practice_configured": bool(settings.asr_api_key and analysis and tts), "combat_configured": bool(settings.api_key and settings.asr_api_key and analysis), "analysis_model": settings.deepseek_model, "model": DUPLEX_MODEL}

    @app.get("/api/doctor")
    async def doctor_profile():
        return DOCTOR_PROFILE

    @app.post('/api/services/check')
    async def services_check():
        nonlocal service_check_task
        if service_check_task is None or service_check_task.done():
            service_check_task = asyncio.create_task(check_services(settings))
        return await asyncio.shield(service_check_task)

    @app.get("/api/sessions")
    async def get_sessions():
        user = current_user()
        scope = {'workspace':user['workspace'], 'owner_id':user['id']} if current_actor.get() else {}
        def collect():
            rows = store.list(**scope)
            count = len(rows)
            for path in (settings.records / 'checkpoints').glob('*.json'):
                try:
                    session_id = UUID(path.stem)
                except ValueError:
                    continue
                item = read_checkpoint(settings.records, session_id)
                if (not item or item.get('workspace') != user['workspace'] or
                        current_actor.get() and item.get('owner_id') != user['id'] or
                        any(row['id'] == item['id'] for row in rows)):
                    continue
                rows.append({**{key:item.get(key) for key in ('id','experience','mode','started_at','ended_at','status')},
                    'message_count':len(item.get('messages', [])),
                    'scenario_title':(item.get('training') or {}).get('scenario', {}).get('title')})
            return sorted(rows, key=lambda row:row.get('started_at') or '', reverse=True)[:50] if len(rows) != count else rows
        return await asyncio.to_thread(collect)

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: UUID):
        user = current_user()
        try:
            return await asyncio.to_thread(operations.record, user, str(session_id))
        except HTTPException as exc:
            record = await asyncio.to_thread(read_checkpoint, settings.records, session_id)
            if (exc.status_code != 404 or not record or record.get('workspace') != user['workspace']
                    or current_actor.get() and record.get('owner_id') != user['id']):
                raise
            return record

    @app.get('/api/sessions/{session_id}/status')
    async def session_status(session_id: UUID):
        user = current_user()
        record = await asyncio.to_thread(store.get, session_id)
        if not record:
            record = await asyncio.to_thread(read_checkpoint, settings.records, session_id)
        if (not record or record.get('workspace') != user['workspace']
                or current_actor.get() and current_role.get() != 'admin' and record.get('owner_id') != user['id']):
            raise HTTPException(404, '记录不存在。')
        if current_role.get() == 'admin' and record.get('owner_id') != user['id']:
            def audit_status():
                with platform.transaction(user['workspace']) as tx:
                    tx.audit(user['workspace'], user['id'], 'session.status', 'session', str(session_id))
            await asyncio.to_thread(audit_status)
        identifier = str(session_id)
        state = 'finalizing' if identifier in finishing else 'active' if identifier in active else 'saved' if record.get('ended_at') else 'interrupted'
        return {'session_id': identifier, 'state': state, 'status':record.get('status')}

    @app.websocket("/api/realtime")
    async def realtime(client: WebSocket):
        async def send_client(payload):
            await asyncio.wait_for(client.send_json(payload), 5)

        if client.headers.get("origin") not in settings.origins:
            await client.close(code=1008)
            return
        user = current_user()
        await client.accept()
        experience = client.query_params.get("experience", "combat")
        if experience not in ("practice", "combat"):
            await client.close(code=1008)
            return
        training = None
        free_context = None
        remediation = None
        scenario_id = client.query_params.get('scenario_id')
        stage = client.query_params.get('stage', 'full')
        if client.query_params.get('assignment_id'):
            await send_client({'type':'error','code':'unsupported_task','message':'课程任务功能已移除，请直接选择场景演练。'})
            await client.close(code=1008)
            return
        if any(key in client.query_params for key in ('drug_id', 'doctor_id')):
            try:
                if scenario_id or client.query_params.get('remediation_id'):
                    raise HTTPException(422, '已发布场景和针对性重练不能更换绑定的药品或医生。')
                free_context = await asyncio.to_thread(prepare_free_context, platform, user,
                    client.query_params.get('drug_id'), client.query_params.get('doctor_id'))
            except HTTPException as exc:
                await send_client({'type':'error', 'code':'invalid_practice', 'message':exc.detail})
                await client.close(code=1008)
                return
        try:
            if client.query_params.get('remediation_id'):
                remediation = await asyncio.to_thread(operations.remediation_choice, user, client.query_params['remediation_id'])
                scenario_id, stage = remediation['scenario_id'], remediation['stage']
        except HTTPException as exc:
            await send_client({'type':'error','code':'invalid_task','message':exc.detail})
            await client.close(code=1008)
            return
        if scenario_id:
            try:
                training = await asyncio.to_thread(prepare_training, platform, user,
                    scenario_id, stage)
            except HTTPException as exc:
                await send_client({'type':'error','code':'invalid_scenario','message':exc.detail})
                await client.close(code=1008)
                return
        missing = [name for name, value in [("SEEDASR_API_KEY", settings.asr_api_key), ("DEEPSEEK_API_KEY", settings.deepseek_api_key), ("DEEPSEEK_MODEL", settings.deepseek_model)] if not value]
        if experience == "combat" and not settings.api_key:
            missing.insert(0, "DOUBAO_API_KEY")
        if experience == "practice":
            missing.extend(name for name, value in [("DOUBAO_TTS_API_KEY", settings.tts_api_key), ("DOUBAO_TTS_VOICE", settings.tts_voice)] if not value)
        if missing:
            await send_client({"type": "error", "code": "not_configured", "message": "请在 backend/.env 配置 " + "、".join(missing) + " 后重启后端"})
            await client.close(code=1013)
            return
        if not app.state.ready:
            await send_client({'type':'error', 'code':'not_ready', 'message':'服务暂未就绪，请稍后重新开始。'})
            await client.close(code=1013)
            return
        if len(active) >= settings.max_sessions or current_actor.get() and user['id'] in active_users:
            await send_client({"type": "error", "code": "busy", "message": "当前演练连接已满，请稍后重试"})
            await client.close(code=1013)
            return
        session_id = str(uuid4())
        record = SessionRecord(session_id, "assisted")
        record.medical_checks = LiveMedicalChecks(client, record, medical_verifier)
        record.data["experience"] = experience
        record.data.update(workspace=user['workspace'], owner_id=user['id'], team=user['team'])
        record.checkpoint = SessionCheckpoint(settings.records, record)
        record.data["doctor"] = {key: DOCTOR_PROFILE[key] for key in ("id", "version", "display_name")}
        if training:
            record.policy_assess = lambda text, context: assess_policy(settings, platform, user['workspace'], text, [p['id'] for p in training.get('policies', [])], context)
            if remediation:
                training['focus_dimensions'] = [remediation['focus_key']] if remediation['focus_key'] else []
            record.training = training
            record.validate_training = lambda: check_materials(platform, user['workspace'], training)
            record.data['training'] = snapshot(training)
            record.data['doctor'] = {key: training['doctor'][key] for key in ('id','version','display_name')}
        if free_context:
            record.data['free_context'] = free_context
            record.data['doctor'] = {key: free_context['doctor'][key] for key in ('id', 'version', 'display_name')}
            record.validate_training = lambda: check_free_context(platform, user['workspace'], free_context)
        if remediation:
            record.data['remediation_id'] = remediation['id']
        status = "interrupted"
        tasks = []
        dialogue = None
        active[session_id] = asyncio.current_task()
        active_users.add(user['id'])
        try:
            await record.checkpoint.save()
            record.data['pricing'] = await asyncio.to_thread(capture_prices, platform, user)
            async with asyncio.timeout(settings.handshake_seconds):
                first = await client.receive_text()
                if len(first.encode()) > MAX_MESSAGE_BYTES:
                    raise BridgeError("invalid_start", "启动消息过大")
                start = json.loads(first)
                if not isinstance(start, dict) or start.get("type") != "start" or start.get("mode") not in ("assisted", "independent"):
                    raise BridgeError("invalid_start", "请先发送有效的演练启动消息")
                record.data["mode"] = start["mode"]
                if experience == "combat":
                    upstream = await connect(
                        settings.endpoint, additional_headers={"X-Api-Key": settings.api_key},
                        open_timeout=10, close_timeout=2, max_size=2**20, max_queue=16,
                        ping_interval=20, ping_timeout=20, proxy=None,
                    )
            if experience == "practice":
                status = await run_practice(client, settings, record)
                return
            async with upstream, asr_connection(settings, session_id) as asr:
                record.data["provider"] = "seeduplex+seedasr"
                dialogue = PracticeDialogue(client, settings, record)
                recognition = AsrStream(asr, dialogue, record)
                await recognition.send(request_packet(session_id))
                send_lock = asyncio.Lock()
                stopping = asyncio.Event()

                async def send_upstream(payload: dict):
                    async with send_lock:
                        await asyncio.wait_for(upstream.send(json.dumps(payload, ensure_ascii=False)), 5)

                await send_upstream(session_config(session_id, settings.voice, instructions=doctor_instructions(training, free_context=free_context)))
                async with asyncio.timeout(settings.handshake_seconds):
                    while True:
                        ack = json.loads(await upstream.recv())
                        if ack.get("type") == "error":
                            raise BridgeError("provider_error", "豆包拒绝创建会话，请核对服务权限和音色")
                        if ack.get("type") == "session.created":
                            break
                record.data["provider_session_id"] = ack.get("session", {}).get("id")
                record.data["status"] = "active"
                await send_client({"type": "ready", "session_id": session_id, "input_rate": 16000, "output_rate": 24000, 'doctor':record.data['doctor'], 'training':record.data.get('training'), 'free_context':free_context, 'mode':record.data['mode']})
                greeting = '你好，这是训练模拟。' + training_opening(training) if training else training_opening(free_context=free_context) if free_context else GREETING
                await send_upstream(event("speech_text_buffer.commit", speech_id=str(uuid4()), text=greeting))

                async def from_client():
                    muted = False
                    # Allow scheduling jitter, but reject bulk/file-speed audio input.
                    frame_budget, last_tick = 100.0, monotonic()
                    control_budget, control_tick = 20.0, monotonic()
                    while True:
                        raw = await client.receive_text()
                        data = parse_client_message(raw)
                        now = monotonic()
                        if data["type"] == "audio":
                            frame_budget = min(100, frame_budget + (now - last_tick) * 50)
                            last_tick = now
                            frame_budget -= 1
                            if frame_budget < 0:
                                raise BridgeError("audio_rate", "音频发送过快，请使用实时麦克风输入")
                            await recognition.audio(data["pcm"], playing=data.get("playing"), muted=muted)
                            if not muted:
                                await send_upstream({"type": "input_audio_buffer.append", "audio": data["audio"]})
                        else:
                            control_budget = min(20, control_budget + (now - control_tick) * 5)
                            control_tick = now
                            control_budget -= 1
                            if control_budget < 0:
                                raise BridgeError("control_rate", "操作过于频繁")
                            if data["type"] == "mute":
                                muted = data["muted"]
                                await send_upstream(event("input_audio_mute.commit" if muted else "input_audio_unmute.commit"))
                                await send_client({"type": "muted", "muted": muted})
                            elif data["type"] == "interrupt":
                                if len(record.data["interaction_events"]) < 1000:
                                    record.data["interaction_events"].append({"type": "manual_interrupt", "audio_ms": len(dialogue.speech.frames) * 20})
                                await send_upstream(event("response.cancel"))
                            elif data["type"] in ("retry", "retry_speech"):
                                raise ValueError("实战模式仅在结束后整理分析")
                            elif data["type"] == "stop":
                                stopping.set()
                                await send_upstream(event("session.close"))
                                await recognition.finish()
                                return "completed"

                async def from_provider():
                    async for raw in upstream:
                        data = json.loads(raw)
                        kind = data.get("type", "")
                        if kind == "error":
                            raise BridgeError("provider_error", "豆包语音服务返回错误，请核对额度、权限或服务状态")
                        if kind == "session.closed":
                            return "completed"
                        if kind == "conversation.item.input_audio_transcription.started":
                            await send_client({"type": "user_started"})
                        elif kind in ("response.output_text.delta", "response.output_text.done"):
                            final = kind.endswith(("completed", ".done"))
                            item_id = data.get("response_id")
                            if not isinstance(item_id, str) or not item_id:
                                raise BridgeError("provider_protocol", "语音事件缺少话轮标识")
                            text = (data.get("transcript") or data.get("text") or "") if final else data.get("delta", "")
                            if not isinstance(text, str) or len(text) > 100000:
                                raise BridgeError("provider_protocol", "无效的语音转录内容")
                            role = "doctor"
                            # An empty final event seals the accumulated deltas instead of erasing them.
                            if final and not text:
                                previous = next((m for m in record.data["messages"] if m["id"] == item_id), None)
                                text = previous["text"] if previous else ""
                            record.transcript(item_id, role, text, final=final)
                            if final:
                                await record.checkpoint.save()
                            await send_client({"type": "transcript", "id": item_id, "role": role, "text": text, "final": final})
                        elif kind == "response.output_audio.delta":
                            audio = data.get("delta", "")
                            try:
                                decoded = base64.b64decode(audio, validate=True)
                            except (ValueError, TypeError) as exc:
                                raise BridgeError("provider_protocol", "无效的回复音频") from exc
                            if len(decoded) % 2:
                                raise BridgeError("provider_protocol", "回复音频必须是 PCM int16")
                            await send_client({"type": "audio", "audio": audio, "response_id": data.get("response_id")})
                        elif kind == "response.output_audio.started":
                            await send_client({"type": "response_started", "response_id": data.get("response_id")})
                        elif kind == "response.canceled":
                            await send_client({"type": "interrupted", "response_id": data.get("response_id")})
                        elif kind == "conversation.item.input_audio_transcription.failed":
                            await send_client({"type": "notice", "message": "本轮语音未识别成功，请重说"})
                        elif kind == "response.done":
                            response = data.get("response")
                            usage = data.get("usage") or (response.get("usage") if isinstance(response, dict) else None)
                            if isinstance(usage, dict):
                                record.data["usage"].append({**usage, "provider":"doubao-duplex", "model":DUPLEX_MODEL})
                    return "interrupted"

                tasks = [asyncio.create_task(from_client()), asyncio.create_task(from_provider()), asyncio.create_task(recognition.receive())]
                async with asyncio.timeout(min(settings.session_seconds, training['scenario']['duration_seconds'] if training else settings.session_seconds)):
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    # Inspect every completed task so simultaneous upstream errors are not swallowed.
                    for task in done:
                        task.result()
                    status = "interrupted"
                    if stopping.is_set():
                        # Both providers must drain before the saved record can claim completion.
                        try:
                            await asyncio.wait_for(asyncio.shield(tasks[0]), 10)
                            drained = await asyncio.wait_for(asyncio.gather(*tasks[1:]), 3)
                            status = "completed" if all(result == "completed" for result in drained) else "interrupted"
                        except TimeoutError:
                            status = "interrupted"
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                record.data["capture_status"] = status
                if not training and not free_context:
                    await dialogue.finish_combat()
        except WebSocketDisconnect:
            pass
        except TimeoutError:
            status = "timeout"
            with contextlib.suppress(Exception):
                await send_client({"type": "error", "code": "timeout", "message": "连接等待超时或演练已达 10 分钟上限"})
        except (BridgeError, ValueError, KeyError, TypeError) as exc:
            status = "error"
            with contextlib.suppress(Exception):
                await send_client({"type": "error", "code": exc.code if isinstance(exc, BridgeError) else "invalid_message", "message": str(exc) if isinstance(exc, BridgeError) else "无效的语音协议消息"})
        except (ConnectionClosed, OSError, InvalidStatus):
            status = "error"
            with contextlib.suppress(Exception):
                await send_client({"type": "error", "code": "upstream_unavailable", "message": "无法连接豆包，请核对网络、API Key 和服务开通状态"})
        except Exception:
            status = "error"
            logger.error("session bridge failed: %s", session_id)
            with contextlib.suppress(Exception):
                await send_client({"type": "error", "code": "internal_error", "message": "语音会话异常，请重新开始"})
        finally:
            finishing.add(session_id)
            try:
                finalization_cancelled = False
                try:
                    for task in tasks:
                        task.cancel()
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                    if dialogue:
                        await dialogue.close()
                    await record.medical_checks.finish()
                    if training or free_context:
                        record.data['capture_status'] = status
                        try:
                            with contextlib.suppress(Exception):
                                await send_client({'type':'practice_state','state':'thinking'})
                            coach = await review_training(settings, record)
                            if coach:
                                with contextlib.suppress(Exception):
                                    await send_client({'type':'coaching','coach':coach})
                        except BridgeError as exc:
                            record.data['analysis_status'] = 'error'
                            with contextlib.suppress(Exception):
                                await send_client({'type':'notice','message':exc.message})
                        except Exception:
                            record.data['analysis_status'] = 'error'
                            logger.error('final training review failed: %s', session_id)
                except asyncio.CancelledError:
                    if (training or free_context) and record.data.get('analysis_status') not in ('completed', 'error'):
                        record.data['analysis_status'] = 'interrupted'
                    finalization_cancelled = True
                except Exception:
                    if training or free_context:
                        record.data['analysis_status'] = 'error'
                    logger.error('session cleanup failed: %s', session_id)
                try:
                    record.data['capture_status'] = status
                    record.data['summary_card'] = await build_visit_summary(settings, record)
                    with contextlib.suppress(Exception):
                        await send_client({'type':'summary_card','card':record.data['summary_card']})
                except asyncio.CancelledError:
                    finalization_cancelled = True
                except Exception:
                    logger.error('visit summary failed: %s', session_id)
                def persist():
                    saved, recovery_saved = True, False
                    try:
                        store.save(record, status)
                    except (OSError, DatabaseError):
                        saved = False
                        logger.error("session record save failed: %s", session_id)
                        if settings.database_url:
                            try:
                                record.save(settings.records/'recovery', status)
                                recovery_saved = True
                            except OSError:
                                logger.error('session recovery copy failed: %s', session_id)
                    try:
                        if saved:
                            operations.finish_remediation(user, record)
                    except Exception:
                        logger.error('retraining status update failed: %s', session_id)
                    return saved, recovery_saved

                # Cancellation cannot stop a write thread or release its slot before recovery finishes.
                saving = asyncio.create_task(asyncio.to_thread(persist))
                while not saving.done():
                    try:
                        await asyncio.shield(saving)
                    except asyncio.CancelledError:
                        finalization_cancelled = True
                saved, recovery_saved = saving.result()
                if saved or recovery_saved:
                    with contextlib.suppress(OSError):
                        await record.checkpoint.remove()
                with contextlib.suppress(Exception):
                    await send_client({"type": "ended", "session_id": session_id, "status": status, "saved": saved, "recovery_saved": recovery_saved, "analysis_status": record.data.get("analysis_status")})
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(client.close(), 5)
                if finalization_cancelled:
                    raise asyncio.CancelledError
            finally:
                finishing.discard(session_id)
                active.pop(session_id, None)
                active_users.discard(user['id'])

    return app

