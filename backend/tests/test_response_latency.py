import asyncio
import copy
import json
from unittest.mock import patch

from fastapi import HTTPException
import pytest

from medvisit.agents.coach import generate_reply
from medvisit.services.practice import PracticeDialogue
from medvisit.storage.records import SessionRecord
from medvisit.voice.protocol import BridgeError
from test_agent_reliability import MESSAGES, is_doctor, ok, serve
from test_bridge import settings
from test_practice import Client, REPLY


async def test_valid_doctor_is_delivered_before_coach_finishes_without_losing_usage(tmp_path):
    delivered, release = asyncio.Event(), asyncio.Event()
    texts = []
    async def handler(request):
        if is_doctor(json.loads(request.content)):
            return ok({'doctor_reply':REPLY['doctor_reply']})
        await release.wait()
        return ok(REPLY)
    async def publish(text, usage):
        texts.append(text)
        delivered.set()
    with serve(handler):
        task = asyncio.create_task(generate_reply(settings(tmp_path), MESSAGES, on_doctor_reply=publish))
        try:
            await asyncio.wait_for(delivered.wait(), 3)
            assert not task.done()
        finally:
            release.set()
        reply, usage = await task
    assert texts == [reply['doctor_reply']] == [REPLY['doctor_reply']]
    assert reply['coach']['focus'] == REPLY['coach']['focus'] and usage['elapsed_seconds'] >= 0


async def test_invalid_doctor_is_never_delivered_early(tmp_path):
    texts = []
    async def publish(text, usage):
        texts.append(text)
    with serve(lambda request: ok({'doctor_reply':''}) if is_doctor(json.loads(request.content)) else ok(REPLY)):
        with pytest.raises(BridgeError):
            await generate_reply(settings(tmp_path), MESSAGES, on_doctor_reply=publish)
    assert texts == []


async def test_invalid_coach_keeps_known_usage_and_does_not_delay_the_doctor(tmp_path):
    def handler(request):
        response = ok({'doctor_reply':REPLY['doctor_reply']} if is_doctor(json.loads(request.content)) else {'coach':{}})
        data = response.json()
        data['usage'] = {'prompt_tokens':8, 'completion_tokens':4, 'total_tokens':12}
        import httpx2
        return httpx2.Response(200, json=data)
    with serve(handler):
        result, usage = await generate_reply(settings(tmp_path), MESSAGES)
    assert result['coach']['degraded'] == 'invalid_output'
    assert usage['total_tokens'] == 24 and not usage.get('incomplete')


async def test_cancelling_after_early_doctor_cancels_the_pending_coach(tmp_path):
    delivered, cancelled = asyncio.Event(), asyncio.Event()
    async def handler(request):
        if is_doctor(json.loads(request.content)):
            return ok({'doctor_reply':REPLY['doctor_reply']})
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    async def publish(text, usage):
        delivered.set()
    with serve(handler):
        task = asyncio.create_task(generate_reply(settings(tmp_path), MESSAGES, on_doctor_reply=publish))
        await asyncio.wait_for(delivered.wait(), 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert cancelled.is_set()


async def test_early_doctor_starts_speech_once_and_coach_remains_bound_to_the_turn(tmp_path):
    client, record = Client(), SessionRecord('test', 'assisted')
    record.transcript('practice-u-0', 'trainee', '请核对研究人群。', final=True)
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    delivered, release = asyncio.Event(), asyncio.Event()
    speech = []
    async def model(*args, on_doctor_reply, **kwargs):
        await on_doctor_reply(REPLY['doctor_reply'], {'prompt_tokens':8, 'completion_tokens':4, 'total_tokens':12})
        delivered.set()
        await release.wait()
        return copy.deepcopy(REPLY), {'total_tokens':12}
    with patch('medvisit.services.practice.generate_reply', model), patch.object(dialogue, 'start_speech', side_effect=lambda *args:speech.append(args)):
        task = asyncio.create_task(dialogue.respond(0, 'practice-u-0'))
        try:
            await asyncio.wait_for(delivered.wait(), 3)
            early = [e for e in client.events if e['type'] == 'practice_turn']
            assert len(early) == len(speech) == 1 and early[0]['coach'] is None
            assert not record.data['coaching']
            assert record.data['usage'][0]['incomplete'] is True
        finally:
            release.set()
        await task
    assert len([m for m in record.data['messages'] if m['role'] == 'doctor']) == 1
    assert len(speech) == 1 and record.data['usage'][0]['total_tokens'] == 12
    assert len(record.data['usage']) == 1 and not record.data['usage'][0].get('incomplete')
    coach = next(e['coach'] for e in client.events if e['type'] == 'coaching')
    assert coach['based_on'] == 'practice-u-0' and coach['doctor_id'] == early[0]['message']['id']


async def test_revoked_training_blocks_early_doctor_and_speech(tmp_path):
    client, record = Client(), SessionRecord('test', 'assisted')
    record.transcript('u', 'trainee', '原话', final=True)
    checks = 0
    def validate():
        nonlocal checks
        checks += 1
        if checks > 1:
            raise HTTPException(409, '资料已撤销')
    record.validate_training = validate
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    async def model(*args, on_doctor_reply, **kwargs):
        await on_doctor_reply(REPLY['doctor_reply'], {'prompt_tokens':8, 'completion_tokens':4, 'total_tokens':12})
        return copy.deepcopy(REPLY), {}
    with patch('medvisit.services.practice.generate_reply', model), patch.object(dialogue, 'start_speech') as speech:
        await dialogue.respond(0, 'u')
    assert not any(e['type'] == 'practice_turn' for e in client.events)
    speech.assert_not_called()
    assert client.events[-1]['message'] == '资料已撤销'


@pytest.mark.parametrize('action', ['correction', 'close'])
async def test_early_voice_and_late_coach_stop_on_correction_or_close(tmp_path, action):
    client, record = Client(), SessionRecord('test', 'assisted')
    record.transcript('practice-u-0', 'trainee', '原话', final=True)
    dialogue = PracticeDialogue(client, settings(tmp_path), record)
    speaking, voice_cancelled, coach_cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def speech(*args, **kwargs):
        speaking.set()
        try:
            await asyncio.Event().wait()
        finally:
            voice_cancelled.set()
    async def model(*args, on_doctor_reply, **kwargs):
        await on_doctor_reply(REPLY['doctor_reply'], {'prompt_tokens':8, 'completion_tokens':4, 'total_tokens':12})
        try:
            await asyncio.Event().wait()
        finally:
            coach_cancelled.set()
    with patch('medvisit.services.practice.generate_reply', model), patch('medvisit.services.practice.synthesize', speech):
        dialogue.pending = asyncio.create_task(dialogue.respond(0, 'practice-u-0'))
        await asyncio.wait_for(speaking.wait(), 3)
        if action == 'correction':
            await dialogue.observe({'utterances':[{'text':'修正后的原话', 'definite':False}]}, False)
        else:
            await dialogue.close()
    assert voice_cancelled.is_set() and coach_cancelled.is_set()
    assert record.data['usage'][0]['total_tokens'] == 12 and record.data['usage'][0]['incomplete'] is True
    assert not record.data['coaching'] and dialogue.pending is None
    assert record.data['messages'][-1]['speech_status'] == 'interrupted'
