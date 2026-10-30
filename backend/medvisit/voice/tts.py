"""Doubao bidirectional TTS: speak trusted doctor text as 24 kHz PCM."""
import asyncio
import json
import struct
from time import monotonic
from uuid import uuid4

from websockets.asyncio.client import connect

from .protocol import BridgeError

TTS_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
TTS_RESOURCE = "seed-tts-2.0"


def request(event: int, payload: dict | None = None, session_id="") -> bytes:
    body = json.dumps(payload or {}, ensure_ascii=False).encode()
    frame = bytes.fromhex("11141000") + struct.pack(">I", event)
    if event not in (1, 2):
        identity = session_id.encode()
        frame += struct.pack(">I", len(identity)) + identity
    return frame + struct.pack(">I", len(body)) + body


def response(raw: bytes) -> tuple[int, int, str, bytes]:
    if not isinstance(raw, bytes) or not 12 <= len(raw) <= 2**20 or raw[0] != 0x11 or raw[2] not in (0, 0x10):
        raise ValueError("无效的语音合成协议头")
    kind, flags = raw[1] >> 4, raw[1] & 15
    if kind == 15:
        raise BridgeError("tts_provider_error", "豆包语音合成失败，请核对密钥、音色权限和额度")
    if kind not in (9, 11) or flags != 4:
        raise ValueError("无效的语音合成事件")
    event = struct.unpack_from(">I", raw, 4)[0]
    identity_size = struct.unpack_from(">I", raw, 8)[0]
    if identity_size > 256 or len(raw) < 16 + identity_size:
        raise ValueError("无效的语音合成会话")
    identity = raw[12:12 + identity_size].decode()
    size = struct.unpack_from(">I", raw, 12 + identity_size)[0]
    payload = raw[16 + identity_size:]
    if len(payload) != size:
        raise ValueError("语音合成负载不完整")
    if event in (51, 153):
        raise BridgeError("tts_provider_error", "豆包语音合成失败，请核对密钥、音色权限和额度")
    return kind, event, identity, payload


async def synthesize(settings, text: str, section_id: str, send_audio, *, instruction: str | None = None) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > 1200:
        raise ValueError("无效的医生朗读文字")
    if instruction is not None and (not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 500):
        raise ValueError("无效的医生朗读指令")
    additions = {"section_id": section_id}
    if instruction is not None:
        additions["context_texts"] = [instruction]
    session_id = str(uuid4())
    # shortcut: one connection per doctor turn; reuse it if handshake latency becomes material.
    async with asyncio.timeout(60), connect(settings.tts_endpoint, additional_headers={
        "X-Api-Key": settings.tts_api_key, "X-Api-Resource-Id": TTS_RESOURCE,
        "X-Api-Connect-Id": str(uuid4()), "X-Control-Require-Usage-Tokens-Return": "*",
    }, open_timeout=10, close_timeout=2, max_size=2**20, max_queue=16, proxy=None) as upstream:
        async def send(event, payload=None, identity=""):
            await asyncio.wait_for(upstream.send(request(event, payload, identity)), 5)

        async def receive():
            return response(await asyncio.wait_for(upstream.recv(), 10))

        async def expect(event, identity=None):
            kind, actual, found_id, payload = await receive()
            if kind != 9 or actual != event or (identity is not None and found_id != identity):
                raise ValueError("语音合成事件顺序异常")
            return payload

        await send(1)
        await expect(50)
        params = {"speaker": settings.tts_voice, "audio_params": {"format": "pcm", "sample_rate": 24000},
                  "additions": json.dumps(additions, ensure_ascii=False)}
        await send(100, {"event": 100, "req_params": params}, session_id)
        await expect(150, session_id)
        await send(200, {"event": 200, "req_params": {**params, "text": text}}, session_id)
        await send(102, identity=session_id)
        audio_bytes = 0
        started = None
        usage = {}
        while True:
            kind, event, identity, payload = await receive()
            if identity != session_id:
                raise ValueError("语音合成会话不匹配")
            if kind == 11 and event == 352:
                if not payload or len(payload) % 2 or audio_bytes + len(payload) > 24000 * 2 * 60:
                    raise ValueError("无效的合成 PCM 音频")
                if started is None:
                    started = monotonic()
                for offset in range(0, len(payload), 9600):
                    chunk = payload[offset:offset + 9600]
                    # TTS can generate faster than playback; keep the browser queue below two seconds.
                    await asyncio.sleep(max(0, audio_bytes / 48000 - (monotonic() - started) - 0.5))
                    await send_audio(chunk)
                    audio_bytes += len(chunk)
            elif kind == 9 and event == 152:
                data = json.loads(payload)
                if not isinstance(data, dict):
                    raise ValueError("无效的语音合成结束事件")
                if isinstance(data.get("usage"), dict):
                    usage = data["usage"]
                break
            elif kind != 9 or event not in (350, 351, 364):
                raise ValueError("无效的语音合成响应")
        if not audio_bytes:
            raise ValueError("语音合成未返回音频")
        await send(2)
        await expect(52)
        return {**usage, 'model':TTS_RESOURCE, 'submitted_characters':len(text), 'output_audio_seconds':round(audio_bytes/48000, 3)}
