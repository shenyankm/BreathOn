import asyncio
import json
import struct
from time import monotonic
from unittest.mock import AsyncMock, patch

import pytest
from websockets.asyncio.server import serve

from medvisit.services.practice import OPENING, PracticeDialogue
from medvisit.platform.training import speech_instructions
from medvisit.voice.protocol import BridgeError
from medvisit.storage.records import SessionRecord
from medvisit.voice.tts import request, response, synthesize
from test_bridge import settings
from test_practice import Client, REPLY, result


def server_packet(event, payload=b'{}', identity='id', kind=9):
    ident = identity.encode()
    return bytes((0x11, kind << 4 | 4, 0 if kind == 11 else 0x10, 0)) + struct.pack('>II', event, len(ident)) + ident + struct.pack('>I', len(payload)) + payload


def test_protocol_matches_official_start_and_rejects_malformed_frames():
    assert request(1) == bytes.fromhex('1114100000000001000000027b7d')
    assert response(server_packet(352, b'\0\0', kind=11)) == (11, 352, 'id', b'\0\0')
    for raw in [b'', 'text', server_packet(150)[:-1], server_packet(150) + b'extra', b'\x11\x94\x11\0' + bytes(16)]:
        with pytest.raises(ValueError):
            response(raw)
    with pytest.raises(BridgeError) as error:
        response(server_packet(153, b'private-provider-detail fake-tts-key'))
    assert 'fake-tts-key' not in str(error.value) and 'private-provider-detail' not in str(error.value)


@pytest.mark.parametrize('instruction', [None, speech_instructions({'doctor': {'mood': 'skeptical'}, 'scenario': {}})])
async def test_actual_websocket_synthesis_and_realtime_pacing(tmp_path, instruction):
    sent_text = []
    sent_additions = []
    audio = b'\x01\0' * (24000 * 3)
    async def vendor(ws):
        assert ws.request.headers['X-Api-Key'] == 'fake-tts-key'
        assert ws.request.headers['X-Api-Resource-Id'] == 'seed-tts-2.0'
        async for raw in ws:
            event = struct.unpack_from('>I', raw, 4)[0]
            offset = 8
            identity = ''
            if event not in (1, 2):
                size = struct.unpack_from('>I', raw, offset)[0]
                identity = raw[offset + 4:offset + 4 + size].decode()
                offset += size + 4
            data = json.loads(raw[offset + 4:])
            if event in (100, 200):
                sent_additions.append(json.loads(data['req_params']['additions']))
            if event == 1:
                await ws.send(server_packet(50))
            elif event == 100:
                assert data['req_params']['audio_params'] == {'format': 'pcm', 'sample_rate': 24000}
                await ws.send(server_packet(150, identity=identity))
            elif event == 200:
                sent_text.append(data['req_params']['text'])
            elif event == 102:
                await ws.send(server_packet(352, audio, identity, 11))
                await ws.send(server_packet(152, b'{"usage":{"text_words":4}}', identity))
            elif event == 2:
                await ws.send(server_packet(52))
    async with serve(vendor, '127.0.0.1', 0) as server:
        endpoint = f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        chunks = []
        async def receive(pcm):
            chunks.append(pcm)
        start = monotonic()
        usage = await synthesize(settings(tmp_path, tts_endpoint=endpoint), '医生文字', 'practice-id', receive, instruction=instruction)
        assert monotonic() - start >= 2
    assert sent_text == ['医生文字'] and b''.join(chunks) == audio
    assert max(map(len, chunks)) <= 9600 and usage['text_words'] == 4
    assert usage['submitted_characters'] == 4 and usage['output_audio_seconds'] == 3
    assert usage['model'] == 'seed-tts-2.0'
    expected = {'section_id': 'practice-id'}
    if instruction is not None:
        expected['context_texts'] = [instruction]
    assert sent_additions == [expected, expected]


@pytest.mark.parametrize('instruction', ['', '   ', '字' * 501, [], 1])
async def test_invalid_speech_instruction_is_rejected_before_connecting(tmp_path, instruction):
    with patch('medvisit.voice.tts.connect') as connect:
        with pytest.raises(ValueError, match='朗读指令'):
            await synthesize(settings(tmp_path), '医生文字', 'practice-id', AsyncMock(), instruction=instruction)
        connect.assert_not_called()


@pytest.mark.parametrize('configured', [False, True])
async def test_only_doctor_text_is_spoken_and_stop_cleans_up(tmp_path, configured):
    client, record = Client(), SessionRecord('test', 'assisted')
    if configured:
        record.training = {'stage': 'full', 'doctor': {'mood': 'friendly', 'opening': '请先说人群。'}, 'scenario': {}}
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    spoken = []
    instructions = []
    async def speech(config, text, section_id, send_audio, *, instruction=None):
        spoken.append(text)
        instructions.append(instruction)
        await send_audio(bytes(640))
        return {}
    with patch('medvisit.services.practice.synthesize', speech), patch('medvisit.services.practice.generate_reply', AsyncMock(return_value=(REPLY, {}))):
        await dialogue.open()
        await dialogue.voice_task
        await dialogue.observe(result('研究人群', complete=True), False)
        await client.receive('practice_turn')
        await dialogue.pending
        await dialogue.voice_task
        await dialogue.close()
    assert spoken == ['请先说人群。' if configured else OPENING, REPLY['doctor_reply']]
    assert instructions == [speech_instructions(record.training)] * 2
    assert REPLY['coach']['reply'] not in spoken
    assert dialogue.voice_task is None and dialogue.pending is None


async def test_speech_failure_retry_reuses_text_and_has_fresh_playback_id(tmp_path):
    client, record = Client(), SessionRecord('test', 'assisted')
    record.training = {'stage': 'full', 'doctor': {'mood': 'skeptical', 'opening': OPENING}, 'scenario': {}}
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    attempts = 0
    instructions = []
    async def speech(config, text, section_id, send_audio, *, instruction=None):
        nonlocal attempts
        attempts += 1
        instructions.append(instruction)
        if attempts == 1:
            raise BridgeError('tts_provider_error', 'private-provider-detail')
        await send_audio(bytes(640))
        return {}
    with patch('medvisit.services.practice.synthesize', speech), patch('medvisit.services.practice.generate_reply', AsyncMock()) as model:
        await dialogue.open()
        await dialogue.voice_task
        assert dialogue.voice_failed and record.data['messages'][0]['text'] == OPENING
        assert record.data['messages'][0]['speech_status'] == 'error'
        await dialogue.retry_speech()
        await dialogue.voice_task
        assert record.data['messages'][0]['speech_status'] == 'completed'
        ids = [e['response_id'] for e in client.events if e['type'] == 'response_started']
        assert len(ids) == 2 and ids[0] != ids[1]
        assert 'private-provider-detail' not in json.dumps(client.events)
        assert instructions == [speech_instructions(record.training)] * 2
        model.assert_not_called()
        await dialogue.close()


async def test_new_trainee_speech_cancels_stale_synthesis(tmp_path):
    client, record = Client(), SessionRecord('test', 'assisted')
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    started, cancelled = asyncio.Event(), asyncio.Event()
    async def speech(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    with patch('medvisit.services.practice.synthesize', speech):
        await dialogue.open()
        await asyncio.wait_for(started.wait(), 1)
        await dialogue.observe(result('我来回答', complete=False), False)
        assert cancelled.is_set() and record.data['messages'][0]['speech_status'] == 'interrupted'
        await dialogue.close()


async def test_free_practice_voice_style_reaches_synthesis_and_retry(tmp_path):
    record = SessionRecord('test', 'assisted')
    record.data['free_context'] = {
        'doctor': {'display_name': '测试医生', 'mood': 'skeptical'},
        'drug': {'name': '测试药品'},
    }
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    speech = AsyncMock(side_effect=[BridgeError('tts_provider_error', 'failed'), {}])
    with patch('medvisit.services.practice.synthesize', speech):
        await dialogue.open()
        await dialogue.voice_task
        await dialogue.retry_speech()
        await dialogue.voice_task
        assert speech.await_count == 2
        first, retry = speech.await_args_list
        assert first.args[1] == retry.args[1] == '你好，今天想聊测试药品的哪方面？'
        instruction = first.kwargs['instruction']
        assert instruction == retry.kwargs['instruction']
        assert '质疑' in instruction and '认可时稍温和放松' in instruction
        assert '疑问重点' in instruction and '短暂停顿' in instruction
        assert len(instruction) <= 500
        assert '测试医生' not in instruction and '测试药品' not in instruction
        await dialogue.close()
