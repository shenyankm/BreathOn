import base64
import gzip
import json
import struct

import pytest

from medvisit.voice.asr import packet, parse_response, request_packet
from medvisit.voice.protocol import BridgeError, parse_client_message, session_config
from medvisit.storage.records import SessionRecord
from medvisit.agents.doctor import DOCTOR_PROMPT


def test_client_allowlist_and_audio_frames():
    audio = base64.b64encode(bytes(640)).decode()
    assert parse_client_message(json.dumps({"type": "audio", "audio": audio, "instructions": "attack", "pcm": "attack"})) == {"type": "audio", "audio": audio, "pcm": bytes(640)}
    assert parse_client_message('{"type":"mute","muted":true}') == {"type": "mute", "muted": True}
    assert parse_client_message(json.dumps({'type': 'audio', 'audio': audio, 'playing': True}))['playing'] is True
    assert parse_client_message(json.dumps({'type': 'audio', 'audio': audio[:-4] + 'AB=='}))['audio'] == audio
    with pytest.raises(ValueError):
        parse_client_message(json.dumps({'type': 'audio', 'audio': audio, 'playing': 'yes'}))
    for value in ['[]', '{', '{"type":"session.create"}', '{"type":"mute","muted":1}', '{"type":"audio","audio":"!"}', '{"type":"audio","audio":"AA=="}', 'x' * 4097]:
        with pytest.raises(ValueError):
            parse_client_message(value)


def test_trusted_configuration():
    session = session_config("id", "voice")["session"]
    assert session["audio"]["input"]["format"] == {"type": "pcm", "rate": 16000}
    assert session["audio"]["output"]["format"]["rate"] == 24000
    assert session["instructions"] == DOCTOR_PROMPT
    assert "李小英（训练模拟）" in session["instructions"]
    request = request_packet("id")
    assert request[:4] == bytes.fromhex("11101100")
    assert json.loads(gzip.decompress(request[8:]))["audio"]["format"] == "pcm"
    final = packet(bytes(640), audio=True, final=True)
    assert final[:4] == bytes.fromhex("11220100")
    assert struct.unpack(">I", final[4:8])[0] == len(final[8:])
    assert gzip.decompress(final[8:]) == bytes(640)


def response(data, final=False):
    body = gzip.compress(json.dumps(data).encode())
    return bytes((0x11, 0x93 if final else 0x91, 0x11, 0)) + struct.pack(">iI", -1 if final else 1, len(body)) + body


def test_asr_response_flags_and_validation():
    data = {"result": {"text": "研究人群"}}
    assert parse_response(response(data, True)) == (data, True)
    for raw in [b'', b'12345678', response(data)[:-1], bytes.fromhex('1191010000000001')]:
        with pytest.raises(ValueError):
            parse_response(raw)
    with pytest.raises(BridgeError, match="SeedASR"):
        parse_response(bytes.fromhex('11f01000') + struct.pack('>II', 45000001, 0))
    with pytest.raises(ValueError, match="过大"):
        parse_response(response({"text": "x" * (2**20 + 1)}))


def test_record_correction_and_atomic_save(tmp_path):
    record = SessionRecord("test", "assisted")
    record.transcript("u1", "trainee", "玛仕", final=False)
    record.transcript("u1", "trainee", "度肽", final=False)
    record.transcript("u1", "trainee", "玛仕度肽。", final=True)
    record.save(tmp_path, "completed")
    saved = json.loads((tmp_path / 'test.json').read_text())
    assert saved["messages"] == [{"id": "u1", "role": "trainee", "text": "玛仕度肽。", "final": True}]
    assert saved["ended_at"] and saved["status"] == "completed"
    assert list(tmp_path.glob('*.tmp')) == []
    assert (tmp_path / 'test.json').stat().st_mode & 0o777 == 0o600
    assert 'audio' not in saved
