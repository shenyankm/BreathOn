import asyncio
from unittest.mock import AsyncMock

import pytest

from medvisit.services.practice import PracticeDialogue
from medvisit.storage.records import SessionRecord
from medvisit.voice.asr import AsrStream, run_practice
from test_bridge import settings
from test_practice import Client


class Upstream:
    closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed = True

    async def send(self, data):
        pass


@pytest.mark.parametrize('recognition_status', ['completed', 'interrupted'])
async def test_simultaneous_stop_and_asr_end_preserve_capture_status(tmp_path, monkeypatch, recognition_status):
    upstream, client = Upstream(), Client()
    client.receive_text = AsyncMock(return_value='{"type":"stop"}')
    monkeypatch.setattr('medvisit.voice.asr.asr_connection', lambda *_: upstream)
    monkeypatch.setattr(PracticeDialogue, 'open', AsyncMock())
    monkeypatch.setattr(AsrStream, 'finish', AsyncMock())
    monkeypatch.setattr(AsrStream, 'receive', AsyncMock(return_value=recognition_status))
    status = await run_practice(client, settings(tmp_path), SessionRecord('test', 'assisted'))
    assert status == recognition_status
    assert upstream.closed


async def test_cancelled_practice_cleans_up_client_receiver_and_speech(tmp_path, monkeypatch):
    upstream, client = Upstream(), Client()
    started = {name: asyncio.Event() for name in ('client', 'asr', 'speech')}
    stopped = set()

    async def blocked(name):
        started[name].set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.add(name)

    client.receive_text = lambda: blocked('client')
    monkeypatch.setattr('medvisit.voice.asr.asr_connection', lambda *_: upstream)
    monkeypatch.setattr(AsrStream, 'receive', lambda _: blocked('asr'))
    monkeypatch.setattr('medvisit.services.practice.synthesize', lambda *_: blocked('speech'))
    task = asyncio.create_task(run_practice(client, settings(tmp_path), SessionRecord('test', 'assisted')))
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started.values())), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped == {'client', 'asr', 'speech'}
        assert upstream.closed
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_slow_client_cannot_block_cancelled_speech_cleanup(tmp_path, monkeypatch):
    started = asyncio.Event()
    class SlowClient(Client):
        async def send_json(self, event):
            if event['type'] == 'interrupted':
                await asyncio.Event().wait()
            await super().send_json(event)

    async def speech(*args):
        started.set()
        await asyncio.Event().wait()

    wait_for = asyncio.wait_for
    async def shorter_send_timeout(awaitable, timeout):
        return await wait_for(awaitable, .01 if timeout == 5 else timeout)

    monkeypatch.setattr('medvisit.services.practice.synthesize', speech)
    monkeypatch.setattr('medvisit.services.practice.asyncio.wait_for', shorter_send_timeout)
    record = SessionRecord('test', 'assisted')
    dialogue = PracticeDialogue(SlowClient(), settings(tmp_path), record)
    await dialogue.open()
    try:
        await wait_for(started.wait(), 1)
        await wait_for(dialogue.close(), .5)
        assert dialogue.voice_task is None and dialogue.pending is None
        assert record.data['messages'][0]['speech_status'] == 'interrupted'
    finally:
        if dialogue.voice_task:
            dialogue.voice_task.cancel()
            await asyncio.gather(dialogue.voice_task, return_exceptions=True)


async def test_cancelling_dialogue_close_still_stops_speech(tmp_path):
    dialogue = PracticeDialogue(Client(), settings(tmp_path), SessionRecord('test', 'assisted'))
    pending_started, pending_cleanup, speech_started, speech_stopped = (asyncio.Event() for _ in range(4))

    async def pending():
        pending_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            pending_cleanup.set()
            await asyncio.Event().wait()

    async def speech():
        speech_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            speech_stopped.set()

    tasks = [asyncio.create_task(pending()), asyncio.create_task(speech())]
    dialogue.pending, dialogue.voice_task = tasks
    try:
        await asyncio.wait_for(asyncio.gather(pending_started.wait(), speech_started.wait()), 1)
        closing = asyncio.create_task(dialogue.close())
        await asyncio.wait_for(pending_cleanup.wait(), 1)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(closing, 1)
        assert speech_stopped.is_set() and dialogue.voice_task is None
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_repeated_cancellation_still_stops_practice_receivers(tmp_path, monkeypatch):
    upstream, client = Upstream(), Client()
    started = {name: asyncio.Event() for name in ('client', 'asr', 'close')}
    stopped = set()
    receivers = {}

    async def blocked(name):
        if name != 'close':
            receivers[name] = asyncio.current_task()
        started[name].set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.add(name)

    client.receive_text = lambda: blocked('client')
    monkeypatch.setattr('medvisit.voice.asr.asr_connection', lambda *_: upstream)
    monkeypatch.setattr(PracticeDialogue, 'open', AsyncMock())
    monkeypatch.setattr(PracticeDialogue, 'close', lambda _: blocked('close'))
    monkeypatch.setattr(AsrStream, 'receive', lambda _: blocked('asr'))
    task = asyncio.create_task(run_practice(client, settings(tmp_path), SessionRecord('test', 'assisted')))
    try:
        await asyncio.wait_for(asyncio.gather(started['client'].wait(), started['asr'].wait()), 1)
        task.cancel()
        await asyncio.wait_for(started['close'].wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert stopped == {'client', 'asr', 'close'} and upstream.closed
    finally:
        task.cancel()
        for receiver in receivers.values():
            receiver.cancel()
        await asyncio.gather(task, *receivers.values(), return_exceptions=True)
