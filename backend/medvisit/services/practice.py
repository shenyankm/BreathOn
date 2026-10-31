"""Text doctor and live coaching, driven by finalized ASR turns."""
import asyncio
import base64
import contextlib
import sqlite3
from time import monotonic
from uuid import uuid4

from psycopg import Error as DatabaseError
from websockets.exceptions import ConnectionClosed, InvalidStatus

from ..agents.coach import OPENING, generate_reply
from ..knowledge.live import checked_snapshot, validate_snapshot, coaching_snapshot, validate_coaching_snapshot
from ..voice.protocol import BridgeError
from ..voice.speech import SpeechEvidence
from ..voice.tts import synthesize
from ..platform.training import opening, speech_instructions
from fastapi import HTTPException

class PracticeDialogue:
    def __init__(self, client, settings, record):
        self.client, self.settings, self.record = client, settings, record
        self.pending: asyncio.Task | None = None
        self.voice_task: asyncio.Task | None = None
        self.voice_failed = False
        self.revision = 0
        self.responded: set[str] = set()
        self.last_request = -100.0
        self.stopping = False
        self.segmented = False
        self.combat = record.data.get("experience") == "combat"
        self.speech = SpeechEvidence()
        self.policy_tasks: dict[str, asyncio.Task] = {}
        record.data['policy_checks'] = []
        record.data["coaching"] = []
        record.data["interaction_events"] = []
        if self.combat:
            record.data["analysis_status"] = "not_started"

    async def send_client(self, payload):
        await asyncio.wait_for(self.client.send_json(payload), 5)

    async def open(self):
        if self.combat:
            return
        text = opening(self.record.training, free_context=self.record.data.get('free_context')) or OPENING
        self.record.transcript("practice-opening", "doctor", text, final=True)
        if getattr(self.record, 'checkpoint', None):
            await self.record.checkpoint.save()
        await self.send_client({"type": "transcript", "id": "practice-opening", "role": "doctor", "text": text, "final": True})
        self.start_speech(text, "practice-opening")

    def start_speech(self, text: str, item_id: str):
        self.voice_failed = False
        self.voice_task = asyncio.create_task(self.speak(text, item_id))

    async def speak(self, text: str, item_id: str):
        # Each playback attempt has its own ID, so a retried utterance is not retired by the browser.
        response_id = f"tts-{uuid4()}"
        message = next(m for m in self.record.data["messages"] if m["id"] == item_id)
        message["speech_status"] = "speaking"
        try:
            await self.send_client({"type": "response_started", "response_id": response_id, "message_id": item_id})
            await self.send_client({"type": "tts_state", "state": "speaking"})
            async def send_audio(pcm):
                if not self.stopping:
                    await self.send_client({"type": "audio", "response_id": response_id, "audio": base64.b64encode(pcm).decode()})
            speech_context = self.record.training
            if not speech_context and self.record.data.get('free_context'):
                speech_context = {'doctor': self.record.data['free_context']['doctor'], 'scenario': {}}
            usage = await synthesize(self.settings, text, self.record.data["id"], send_audio,
                                     instruction=speech_instructions(speech_context))
            message["speech_status"] = "completed"
            if usage:
                self.record.data["usage"].append({"provider": "doubao-tts", **usage})
            await self.send_client({"type": "tts_state", "state": "done"})
        except asyncio.CancelledError:
            message["speech_status"] = "interrupted"
            with contextlib.suppress(Exception):
                await self.send_client({"type": "interrupted", "response_id": response_id})
            raise
        except (BridgeError, OSError, ConnectionClosed, InvalidStatus, TimeoutError, ValueError, TypeError):
            message["speech_status"] = "error"
            self.voice_failed = True
            await self.send_client({"type": "interrupted", "response_id": response_id})
            await self.send_client({"type": "tts_state", "state": "error"})
            await self.send_client({"type": "notice", "message": "医生朗读暂时失败，文字已保留。可重试朗读或继续练习；请核对语音合成权限和额度。"})

    async def cancel_speech(self):
        if self.voice_task:
            self.voice_task.cancel()
            await asyncio.gather(self.voice_task, return_exceptions=True)
            self.voice_task = None

    async def observe(self, result: dict, final: bool):
        utterances = result.get("utterances")
        if isinstance(utterances, list) and utterances:
            self.segmented = True
        if utterances is None:
            # Keep unsegmented results visible, but only advance the doctor after a confirmed boundary.
            utterances = [] if self.segmented else [{"start_time": "fallback", "text": result.get("text", ""), "definite": final}]
        if not isinstance(utterances, list) or len(utterances) > 2000:
            raise ValueError("无效 ASR 分句")
        changed = False
        corrected = False
        invalidated = False
        latest = None
        messages = {message['id']: message for message in self.record.data['messages']}
        for index, utterance in enumerate(utterances):
            if not isinstance(utterance, dict):
                raise ValueError("无效 ASR 分句")
            start, text = utterance.get("start_time"), utterance.get("text", "")
            words = utterance.get("words")
            if start is None and isinstance(words, list) and words and isinstance(words[0], dict):
                start = words[0].get("start_time")
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError("无效 ASR 分句内容")
            if not text.strip():
                continue
            # Full ASR snapshots have stable segment positions; word timestamps may be corrected or absent.
            item_id = f"{'combat' if self.combat else 'practice'}-u-{index}"
            complete = utterance.get("definite") is True or final
            previous = messages.get(item_id)
            was_final = bool(previous and previous.get('final'))
            latest = {"id": item_id, "role": "trainee", "text": text, "final": complete}
            if previous and previous["text"] == text and previous["final"] == complete:
                continue
            if previous and previous["text"] != text and not self.combat and not invalidated:
                # The first correction already covers every later segment in this snapshot.
                invalidated = True
                affected = {f'practice-u-{position}' for position in range(index, len(utterances))}
                for coach in self.record.data["coaching"]:
                    if coach['based_on'] in affected:
                        coach['superseded'] = True
                        corrected = True
                self.responded.difference_update(affected)
            if not changed:
                self.revision += 1
            changed = True
            self.record.transcript(item_id, "trainee", text, final=True)
            stored = previous if previous is not None else self.record.data['messages'][-1]
            stored["final"] = complete
            stored["speech"] = self.speech.describe(start, utterance.get("end_time"))
            if isinstance(start, int) and isinstance(utterance.get("end_time"), int):
                stored["speech"].update(start_ms=start, end_ms=utterance["end_time"])
            if (complete or was_final) and getattr(self.record, 'checkpoint', None):
                await self.record.checkpoint.save()
            await self.send_client({"type": "transcript", **latest, "replace": True})
            await self.schedule_policy_check(item_id, text, complete)
            if getattr(self.record, 'medical_checks', None):
                self.record.medical_checks.observe(item_id, text, complete)
        if final:
            for message in self.record.data["messages"]:
                if message["role"] == "trainee" and not message["final"]:
                    message["final"] = True
                    if not changed:
                        self.revision += 1
                    changed = True
                    latest = dict(message)
                    if getattr(self.record, 'checkpoint', None):
                        await self.record.checkpoint.save()
                    await self.send_client({"type": "transcript", **message, "replace": True})
                    await self.schedule_policy_check(message['id'], message['text'], True)
                    if getattr(self.record, 'medical_checks', None):
                        self.record.medical_checks.observe(message['id'], message['text'], True)
        if changed and latest and latest['final'] and self.record.data.get('free_context') and self.record.validate_training:
            try:
                await asyncio.to_thread(self.record.validate_training)
            except HTTPException as exc:
                raise BridgeError('training_material_changed', exc.detail) from exc
        if changed:
            if self.combat:
                return
            # New trainee text cancels stale speech as well as a pending text reply.
            await self.cancel_speech()
            self.voice_failed = False
            await self.send_client({"type": "user_started", "coaching_invalidated": corrected})
            await self.cancel_pending()
            if not self.stopping:
                if latest and latest["final"] and latest["id"] not in self.responded and all(m["final"] for m in self.record.data["messages"] if m["role"] == "trainee"):
                    self.pending = asyncio.create_task(self.respond(self.revision, latest["id"]))
                else:
                    await self.state("listening")

    async def schedule_policy_check(self, item_id, text, final):
        old = self.policy_tasks.pop(item_id, None)
        if old:
            old.cancel()
        self.record.data['policy_checks'] = [row for row in self.record.data['policy_checks'] if row['message_id'] != item_id]
        if not final or not getattr(self.record, 'policy_assess', None):
            return
        self.policy_tasks[item_id] = asyncio.create_task(self.check_policy(item_id, text))

    async def check_policy(self, item_id, text):
        try:
            context = '\n'.join(message['text'] for message in self.record.data['messages'][-8:])
            result = await self.record.policy_assess(text, context)
            findings = result.get('findings', []) if isinstance(result, dict) else result
            status = result.get('status', 'complete') if isinstance(result, dict) else 'complete'
            if isinstance(result, dict) and result.get('usage'):
                self.record.data['usage'].append(result['usage'])
            message = next((row for row in self.record.data['messages'] if row['id'] == item_id), None)
            if not message or not message['final'] or message['text'] != text:
                return
            rows = [{**finding, 'message_id':item_id, 'text':text} for finding in findings]
            self.record.data['policy_checks'] = [row for row in self.record.data['policy_checks'] if row['message_id'] != item_id] + rows
            await self.send_client({'type':'policy_check', 'message_id':item_id, 'text':text, 'status':status, 'findings':rows})
        except asyncio.CancelledError:
            raise
        except Exception:
            message = next((row for row in self.record.data['messages'] if row['id'] == item_id), None)
            if message and message['final'] and message['text'] == text:
                await self.send_client({'type':'policy_check', 'message_id':item_id, 'text':text, 'status':'unavailable', 'findings':[]})

    async def state(self, state: str):
        await self.send_client({"type": "practice_state", "state": state})

    async def cancel_pending(self):
        if self.pending and not self.pending.done():
            self.pending.cancel()
        if self.pending:
            await asyncio.gather(self.pending, return_exceptions=True)
        self.pending = None

    async def respond(self, revision: int, based_on: str):
        await asyncio.sleep(max(0.4, 3 - (monotonic() - self.last_request)))
        if self.stopping:
            return
        await self.state("thinking")
        self.last_request = monotonic()
        try:
            # Snapshot before awaiting: ASR keeps running and may correct or extend the turn.
            history = [dict(m) for m in self.record.data["messages"] if self.combat or m["final"]]
            if self.record.validate_training:
                try:
                    await asyncio.to_thread(self.record.validate_training)
                except HTTPException as exc:
                    raise BridgeError('training_material_changed', exc.detail) from exc
            checks = await checked_snapshot(self.record)
            options = {'training': self.record.training} if self.record.training else {}
            if self.record.data.get('free_context'):
                options['free_context'] = self.record.data['free_context']
            if self.record.data.get('medical_checks'):
                options['medical_checks'] = checks
            reference = await coaching_snapshot(self.record)
            if reference is not None:
                options['reference_context'] = reference
            if not await asyncio.to_thread(getattr(self.record, 'scoring_enabled', lambda: True)):
                options['scoring_enabled'] = False
            result, usage = await generate_reply(self.settings, history, speak=not self.combat, interactions=list(self.record.data["interaction_events"]), **options)
            if usage:
                self.record.data["usage"].append({"provider": "deepseek", **usage})
            await validate_snapshot(self.record, checks)
            await validate_coaching_snapshot(self.record, reference)
            if self.record.validate_training:
                try:
                    await asyncio.to_thread(self.record.validate_training)
                except HTTPException as exc:
                    raise BridgeError('training_material_changed', exc.detail) from exc
        except (BridgeError, OSError, sqlite3.Error, DatabaseError) as exc:
            if revision == self.revision and not self.stopping:
                if self.combat:
                    self.record.data["analysis_status"] = "error"
                await self.state("error")
                await self.send_client({"type": "notice", "message": exc.message if isinstance(exc, BridgeError) else "暂时无法读取训练资料，请稍后重试；已识别文字仍会保留。"})
            return
        if revision != self.revision or self.stopping:
            return
        self.responded.update(m["id"] for m in history if m["role"] == "trainee")
        item_id = "" if self.combat else f"practice-d-{uuid4()}"
        if not self.combat:
            self.record.transcript(item_id, "doctor", result["doctor_reply"], final=True)
        if not await asyncio.to_thread(getattr(self.record, 'scoring_enabled', lambda: True)):
            result['coach'].pop('assessment', None)
        coaching = {"based_on": based_on, "doctor_id": item_id, **result["coach"]}
        if reference is not None:
            coaching["reference_context"] = reference
        if self.combat:
            coaching["incomplete"] = self.record.data.get("capture_status") != "completed" or sum(len(m["text"]) for m in history) > 64000 or any(len(m["text"]) > 4000 for m in history)
        self.record.data["coaching"].append(coaching)
        if self.combat:
            self.record.data["analysis_status"] = "completed"
            await self.send_client({"type": "coaching", "coach": coaching})
            await self.state("listening")
            return
        # Publish doctor and coach together so a new ASR correction cannot split the pair.
        await self.send_client({"type": "practice_turn", "message": {
            "id": item_id, "role": "doctor", "text": result["doctor_reply"], "final": True,
        }, "coach": coaching if self.record.data["mode"] == "assisted" else None})
        if getattr(self.record, 'checkpoint', None):
            await self.record.checkpoint.save()
        self.start_speech(result["doctor_reply"], item_id)
        await self.state("listening")

    async def retry(self):
        if self.stopping or (self.pending and not self.pending.done()):
            return
        latest = next((m for m in reversed(self.record.data["messages"]) if m["role"] == "trainee"), None)
        if latest and latest["final"] and latest["id"] not in self.responded and all(m["final"] for m in self.record.data["messages"] if m["role"] == "trainee"):
            self.pending = asyncio.create_task(self.respond(self.revision, latest["id"]))

    async def close(self):
        self.stopping = True
        try:
            await self.cancel_pending()
        finally:
            await self.cancel_speech()
            for task in self.policy_tasks.values():
                task.cancel()
            await asyncio.gather(*self.policy_tasks.values(), return_exceptions=True)

    async def retry_speech(self):
        if self.stopping or self.combat or not self.voice_failed or (self.pending and not self.pending.done()):
            return
        latest = next((m for m in reversed(self.record.data["messages"]) if m["role"] == "doctor"), None)
        if latest:
            await self.cancel_speech()
            self.start_speech(latest["text"], latest["id"])

    async def finish_combat(self):
        latest = next((m for m in reversed(self.record.data["messages"]) if m["role"] == "trainee"), None)
        if not latest:
            self.record.data["analysis_status"] = "no_speech"
            return
        self.record.data["analysis_status"] = "thinking"
        self.record.data["interaction_events"].append({"type": "capture_end", "status": self.record.data.get("capture_status", "interrupted")})
        await self.respond(self.revision, latest["id"])
