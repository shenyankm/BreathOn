"""Exercise the actual websockets library against a local fake vendor, without credentials."""
import asyncio
import json
from unittest.mock import patch, AsyncMock

import pytest
from conftest import LocalClient as TestClient
from websockets.asyncio.server import serve

from medvisit.api.app import create_app
from test_bridge import AUDIO, ORIGIN, receive_until, settings
from test_protocol import response
from test_practice import REPLY


@pytest.mark.parametrize('experience', ['practice', 'combat'])
async def test_real_upstream_transport(tmp_path, experience):
    seen = []
    async def vendor(socket):
        assert socket.request.headers['X-Api-Key'].startswith('fake-')
        async for raw in socket:
            seen.append(raw)
            if isinstance(raw, bytes):
                if raw[1] >> 4 == 2:
                    final = bool(raw[1] & 2)
                    await socket.send(response({'result': {'text': '本地链路测试。', 'utterances': [{'start_time': 0, 'text': '本地链路测试。', 'definite': True}]}}, final))
                    if final:
                        return
            else:
                data = json.loads(raw)
                if data['type'] == 'session.create':
                    await socket.send(json.dumps({'type': 'session.created'}))
                elif data['type'] == 'input_audio_buffer.append':
                    await socket.send(json.dumps({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': 'u1', 'transcript': '本地链路测试。'}))
                elif data['type'] == 'session.close':
                    await socket.send(json.dumps({'type': 'session.closed'}))
                    return

    async with serve(vendor, '127.0.0.1', 0) as server:
        endpoint = f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        config = settings(tmp_path, endpoint=endpoint, asr_endpoint=endpoint)
        def exercise():
            with TestClient(create_app(config)) as client:
                with client.websocket_connect(f'/api/realtime?experience={experience}', headers=ORIGIN) as ws:
                    ws.send_json({'type': 'start', 'mode': 'assisted'})
                    receive_until(ws, 'ready')
                    for _ in range(10):
                        ws.send_json({'type': 'audio', 'audio': AUDIO})
                    if experience == 'practice':
                        receive_until(ws, 'transcript')  # Opening doctor question.
                    assert receive_until(ws, 'transcript')['text'] == '本地链路测试。'
                    if experience == 'practice':
                        turn = receive_until(ws, 'practice_turn')
                        assert turn['message']['role'] == 'doctor' and turn['coach']['points']
                    else:
                        assert not model.called
                    ws.send_json({'type': 'stop'})
                    if experience == 'combat':
                        assert receive_until(ws, 'coaching')['coach']['delivery']['logic']
                    ended = receive_until(ws, 'ended')
                    assert ended['saved'] and ended['status'] == 'completed'
        with patch('medvisit.services.practice.generate_reply', AsyncMock(return_value=(REPLY, {}))) as model:
            await asyncio.wait_for(asyncio.to_thread(exercise), 10)
    assert seen
