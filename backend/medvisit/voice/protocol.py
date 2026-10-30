"""The official Seeduplex JSON protocol, restricted to this training scenario."""
import base64
import binascii
import json
from uuid import uuid4

from ..agents.doctor import DOCTOR_PROMPT, GREETING

UPSTREAM_URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue"
DUPLEX_MODEL = "1.2.6.1"
INPUT_RATE = 16000
OUTPUT_RATE = 24000
FRAME_BYTES = 640  # 20 ms, mono PCM signed int16, little endian.
MAX_MESSAGE_BYTES = 4096

class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def event(kind: str, **fields) -> dict:
    return {"type": kind, "event_id": str(uuid4()), **fields}


def session_config(session_id: str, voice: str, *, instructions=None) -> dict:
    return event("session.create", session={
        "id": session_id,
        "model": DUPLEX_MODEL,
        "instructions": instructions or DOCTOR_PROMPT,
        "audio": {
            "input": {"format": {"type": "pcm", "rate": INPUT_RATE}},
            "output": {"format": {"type": "pcm_s16le", "rate": OUTPUT_RATE}, "voice": voice},
        },
    })


def parse_client_message(raw: str) -> dict:
    if len(raw.encode()) > MAX_MESSAGE_BYTES:
        raise ValueError("消息过大")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("消息必须是 JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("消息必须是对象")
    kind = data.get("type")
    if kind == "audio":
        try:
            audio = base64.b64decode(data.get("audio", ""), validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError("无效音频编码") from exc
        if len(audio) != FRAME_BYTES:
            raise ValueError("音频必须是 20ms / 640 字节 PCM 帧")
        result = {"type": kind, "audio": base64.b64encode(audio).decode(), "pcm": audio}
        if "playing" in data:
            if not isinstance(data["playing"], bool):
                raise ValueError("无效的播放状态")
            result["playing"] = data["playing"]
        return result
    if kind == "mute" and isinstance(data.get("muted"), bool):
        return {"type": kind, "muted": data["muted"]}
    if kind in ("interrupt", "stop", "retry", "retry_speech"):
        return {"type": kind}
    raise ValueError("不支持的消息类型")
