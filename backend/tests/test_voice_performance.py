import random
import struct

import pytest

from medvisit.services.practice import PracticeDialogue
from medvisit.storage.records import SessionRecord
from medvisit.voice.speech import SpeechEvidence
from test_bridge import settings
from test_practice import Client


def test_capture_power_matches_integer_reference_at_pcm_extremes_and_random_frames():
    rng = random.Random(42)
    frames = [[-32768, -1, 0, 1, 32767] * 64, [0] * 320]
    frames.extend([rng.randrange(-32768, 32768) for _ in range(320)] for _ in range(100))
    capture = SpeechEvidence()
    for samples in frames:
        capture.observe(struct.pack('<320h', *samples), playing=True, muted=False)
        assert capture.frames[-1] == (sum(value * value for value in samples) / 320, True, False)
    with pytest.raises(struct.error):
        capture.observe(bytes(638))


async def test_corrected_snapshot_invalidates_each_coach_only_once(tmp_path):
    class CountedCoaches(list):
        visits = 0

        def __iter__(self):
            for coach in super().__iter__():
                self.visits += 1
                yield coach

    record = SessionRecord('test', 'assisted')
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    dialogue.stopping = True
    count, first_correction = 300, 100
    for index in range(count):
        record.transcript(f'practice-u-{index}', 'trainee', f'原话 {index}', final=True)
    record.data['coaching'] = coaches = CountedCoaches(
        {'based_on': f'practice-u-{index}'} for index in range(count)
    )
    dialogue.responded = {f'practice-u-{index}' for index in range(count)}
    snapshot = {'utterances': [
        {'text': f'{"原话" if index < first_correction else "修正"} {index}', 'definite': True}
        for index in range(count)
    ]}
    snapshot['utterances'][0]['definite'] = False
    await dialogue.observe(snapshot, False)
    assert coaches.visits == count
    assert all(not coach.get('superseded') for coach in coaches[:first_correction])
    assert all(coach['superseded'] for coach in coaches[first_correction:])
    assert dialogue.responded == {f'practice-u-{index}' for index in range(first_correction)}
    assert record.data['messages'][-1]['text'] == f'修正 {count - 1}'
    assert dialogue.client.events[-1] == {'type': 'user_started', 'coaching_invalidated': True}


async def test_asr_snapshot_reuses_message_index_for_corrections_and_appends(tmp_path):
    class Messages(list):
        visits = 0

        def __iter__(self):
            for message in super().__iter__():
                self.visits += 1
                yield message

    record = SessionRecord('test', 'assisted')
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    dialogue.stopping = True
    record.data['messages'] = messages = Messages(
        {'id':f'practice-u-{i}', 'role':'trainee', 'text':f'原话 {i}', 'final':True,
         'retained':'metadata'} for i in range(300)
    )
    original = list(messages)
    messages.visits = 0
    snapshot = {'utterances':[
        {'text':f'修正 {i}', 'definite':i % 2 == 0} for i in range(400)
    ]}
    await dialogue.observe(snapshot, False)
    assert messages.visits == 300
    assert len(messages) == 400
    assert all(messages[i] is original[i] and messages[i]['retained'] == 'metadata' for i in range(300))
    assert [(m['id'], m['text'], m['final']) for m in messages] == [
        (f'practice-u-{i}', f'修正 {i}', i % 2 == 0) for i in range(400)
    ]
    assert len([event for event in dialogue.client.events if event['type'] == 'transcript']) == 400
    dialogue.client.events.clear()
    await dialogue.observe(snapshot, False)
    assert dialogue.client.events == []
