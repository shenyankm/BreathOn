"""Exercise capacity, ownership and release without contacting providers."""
import time
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch
from uuid import UUID

from medvisit.api.app import create_app
from medvisit.api.auth import COOKIE, AuthenticationMiddleware, hash_password
from test_bridge import ORIGIN, Provider, receive_until, settings
from test_practice import REPLY
from test_protocol import response
from conftest import LocalClient


def test_ten_users_capacity_disconnect_release_and_isolated_transcripts(tmp_path):
    password_hash = hash_password('capacity test password')
    names = ['admin', *(f'rep{i}' for i in range(1, 11))]
    config = settings(tmp_path, auth_required=True, max_sessions=10,
                      login_users={name:password_hash for name in names})
    app = create_app(config)
    auth = next(m.kwargs['auth'] for m in app.user_middleware if m.cls is AuthenticationMiddleware)
    tokens = {name:f'test-token-{name}' for name in names}
    for name, token in tokens.items():
        auth.sessions[auth.token_key(token)] = {'username':name, 'expires_at':time.time() + 300}

    async def voice(*args, **kwargs):
        return Provider()

    def asr(settings, session_id):
        class UniqueAsr(Provider):
            async def send(self, raw):
                if raw[1] >> 4 == 2 and raw[1] & 2:
                    self.queue.put_nowait(response({'result': {'text':f'语音记录 {session_id}'},
                                                   'audio_info': {'duration':200}}, True))
        return UniqueAsr(asr=True)

    def headers(name):
        return {**ORIGIN, 'cookie':f'{COOKIE}={tokens[name]}'}

    with patch('medvisit.api.app.connect', voice), \
         patch('medvisit.api.app.asr_connection', asr), \
         patch('medvisit.services.practice.generate_reply', AsyncMock(return_value=(REPLY, {}))), \
         LocalClient(app) as client, ExitStack() as sockets:
        open_sockets, session_ids = {}, {}
        first = sockets.enter_context(client.websocket_connect('/api/realtime', headers=headers(names[0])))
        first.send_json({'type':'start', 'mode':'assisted'})
        session_ids[names[0]] = receive_until(first, 'ready')['session_id']
        open_sockets[names[0]] = first
        # Duplicate owner is refused even though nine global slots remain.
        with client.websocket_connect('/api/realtime', headers=headers(names[0])) as duplicate:
            assert duplicate.receive_json()['code'] == 'busy'
        for name in names[1:10]:
            socket = sockets.enter_context(client.websocket_connect('/api/realtime', headers=headers(name)))
            socket.send_json({'type':'start', 'mode':'assisted'})
            session_ids[name] = receive_until(socket, 'ready')['session_id']
            open_sockets[name] = socket
        assert len(set(session_ids.values())) == 10
        with client.websocket_connect('/api/realtime', headers=headers(names[10])) as full:
            assert full.receive_json()['code'] == 'busy'
        # A disconnected session releases its slot after its interrupted record is saved.
        first.close()
        assert receive_until(first, 'ended')['status'] == 'interrupted'
        replacement = sockets.enter_context(client.websocket_connect('/api/realtime', headers=headers(names[10])))
        replacement.send_json({'type':'start', 'mode':'assisted'})
        session_ids[names[10]] = receive_until(replacement, 'ready')['session_id']
        open_sockets[names[10]] = replacement
        for name in names[1:]:
            socket = open_sockets[name]
            socket.send_json({'type':'stop'})
            assert receive_until(socket, 'ended')['saved'] is True
        for name, item_id in session_ids.items():
            record = app.state.records.get(UUID(item_id))
            assert record['owner_id'] == name
            if name != names[0]:
                assert any(message['text'] == f'语音记录 {item_id}' for message in record['messages'])
                assert not any(other_id in message['text'] for message in record['messages']
                               for other_id in session_ids.values() if other_id != item_id)
