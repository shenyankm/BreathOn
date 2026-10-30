"""SeedASR recognition feeds text roleplay and coaching without interrupting capture."""
import asyncio
import gzip
import io
import json
import struct
from time import monotonic

from websockets.asyncio.client import connect

from .protocol import BridgeError, parse_client_message
from ..services.practice import PracticeDialogue, OPENING
from ..platform.training import opening

ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
RESOURCE_ID = "volc.seedasr.sauc.duration"
ASR_MODEL = "bigmodel"
PRACTICE_QUESTION = OPENING


def packet(payload: bytes, *, audio=False, final=False) -> bytes:
    compressed = gzip.compress(payload)
    header = bytes((0x11, (0x20 if audio else 0x10) | (2 if final else 0), 0x01 if audio else 0x11, 0))
    return header + struct.pack(">I", len(compressed)) + compressed


def request_packet(session_id: str) -> bytes:
    return packet(json.dumps({
        "user": {"uid": session_id},
        "audio": {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
        "request": {"model_name": ASR_MODEL, "enable_itn": True, "enable_punc": True,
                    "enable_nonstream": True, "result_type": "full", "show_utterances": True, "end_window_size": 1500},
    }).encode())


def parse_response(raw: bytes) -> tuple[dict, bool]:
    if not isinstance(raw, bytes) or len(raw) < 8 or raw[0] >> 4 != 1:
        raise ValueError("无效 ASR 协议头")
    offset = (raw[0] & 15) * 4
    kind, flags = raw[1] >> 4, raw[1] & 15
    if offset < 4 or kind not in (9, 15) or flags > 3:
        raise ValueError("无效 ASR 消息类型")
    if kind == 15:
        raise BridgeError("asr_provider_error", "SeedASR 返回错误，请核对 API Key、资源权限和额度")
    if flags & 1:
        offset += 4
    if len(raw) < offset + 4:
        raise ValueError("ASR 消息不完整")
    size = struct.unpack_from(">I", raw, offset)[0]
    payload = raw[offset + 4:]
    if size != len(payload) or raw[2] >> 4 != 1 or raw[2] & 15 not in (0, 1):
        raise ValueError("无效 ASR 负载")
    if raw[2] & 15:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as zipped:
            payload = zipped.read(2**20 + 1)
    if len(payload) > 2**20:
        raise ValueError("ASR 结果过大")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("ASR 结果必须是对象")
    if data.get("code", 20000000) not in (0, 20000000):
        raise BridgeError("asr_provider_error", "SeedASR 识别失败，请核对服务状态")
    return data, bool(flags & 2)


def asr_connection(settings, session_id):
    return connect(settings.asr_endpoint, additional_headers={
        "X-Api-Key": settings.asr_api_key, "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Connect-Id": session_id, "X-Api-Request-Id": session_id,
    }, open_timeout=10, close_timeout=2, max_size=2**20, max_queue=16, proxy=None)


class AsrStream:
    def __init__(self, upstream, dialogue, record):
        self.upstream, self.dialogue, self.record = upstream, dialogue, record
        self.frames = bytearray()
        self.usage = {'provider':'seedasr', 'model':RESOURCE_ID, 'audio_seconds':0.0}
        self.audio_bytes = 0
        self.record.data['usage'].append(self.usage)

    async def send(self, data):
        await asyncio.wait_for(self.upstream.send(data), 5)

    async def audio(self, pcm, *, playing=None, muted=False):
        self.dialogue.speech.observe(pcm, playing=playing, muted=muted)
        self.frames.extend(bytes(640) if muted else pcm)
        if len(self.frames) >= 6400:
            await self.send(packet(bytes(self.frames), audio=True))
            self.audio_bytes += len(self.frames)
            self.usage['audio_seconds'] = self.audio_bytes/32000
            self.frames.clear()

    async def finish(self):
        await self.send(packet(bytes(self.frames), audio=True, final=True))
        self.audio_bytes += len(self.frames)
        self.usage['audio_seconds'] = self.audio_bytes/32000
        self.frames.clear()

    async def receive(self):
        async for raw in self.upstream:
            data, final = parse_response(raw)
            result = data.get("result", {})
            if not isinstance(result, dict):
                raise ValueError("无效 ASR 结果")
            text = result.get("text", "")
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError("无效 ASR 文字")
            await self.dialogue.observe(result, final)
            if isinstance(data.get("audio_info"), dict):
                self.record.data["audio_info"] = data["audio_info"]
            if final:
                return "completed"
        return "interrupted"


async def run_practice(client, settings, record):
    session_id = record.data["id"]
    record.data.update(provider="seedasr-streaming", speech_provider="doubao-tts-2.0", question=opening(record.training, free_context=record.data.get('free_context')) if record.training or record.data.get('free_context') else PRACTICE_QUESTION)
    tasks = []
    dialogue = PracticeDialogue(client, settings, record)
    async with asr_connection(settings, session_id) as upstream:
        recognition = AsrStream(upstream, dialogue, record)
        await recognition.send(request_packet(session_id))
        # The optimized API may send nothing until speech changes; WebSocket handshake establishes readiness.
        record.data["status"] = "active"
        await dialogue.send_client({"type": "ready", "session_id": session_id, "input_rate": 16000, "output_rate": 24000, 'doctor': record.data.get('doctor'), 'training':record.data.get('training'), 'free_context':record.data.get('free_context'), 'mode':record.data['mode']})

        await dialogue.open()

        async def from_client():
            muted = False
            budget, tick = 100.0, monotonic()
            control_budget, control_tick = 20.0, tick
            while True:
                data = parse_client_message(await client.receive_text())
                now = monotonic()
                if data["type"] == "audio":
                    budget = min(100, budget + (now - tick) * 50) - 1
                    tick = now
                    if budget < 0:
                        raise BridgeError("audio_rate", "音频发送过快，请使用实时麦克风输入")
                    await recognition.audio(data["pcm"], playing=data.get("playing"), muted=muted)
                else:
                    control_budget = min(20, control_budget + (now - control_tick) * 5) - 1
                    control_tick = now
                    if control_budget < 0:
                        raise BridgeError("control_rate", "操作过于频繁")
                    if data["type"] == "mute":
                        muted = data["muted"]
                        await dialogue.send_client({"type": "muted", "muted": muted})
                    elif data["type"] == "retry":
                        await dialogue.retry()
                    elif data["type"] == "retry_speech":
                        await dialogue.retry_speech()
                    elif data["type"] == "stop":
                        await dialogue.close()
                        await recognition.finish()
                        return "completed"
                    else:
                        raise ValueError("练习模式不支持打断医生")

        try:
            tasks = [asyncio.create_task(from_client()), asyncio.create_task(recognition.receive())]
            async with asyncio.timeout(min(settings.session_seconds, record.training['scenario']['duration_seconds'] if record.training else settings.session_seconds)):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                results = [task.result() for task in done]
                if tasks[0] in done and tasks[0].result() == "completed":
                    # Missing the final ASR response means the saved text may still be partial.
                    return await asyncio.wait_for(asyncio.shield(tasks[1]), 3)
                return "completed" if "completed" in results else "interrupted"
        finally:
            try:
                await dialogue.close()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
