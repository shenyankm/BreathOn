import copy
import json
import struct
from unittest.mock import AsyncMock, patch

import httpx2 as httpx
from openai import AsyncClient
import pytest

from medvisit.agents.coach import HUMANIZER_SKILL, PRACTICE_PROMPT, generate_reply
from medvisit.services.practice import PracticeDialogue
from medvisit.voice.protocol import BridgeError
from medvisit.storage.records import SessionRecord
from medvisit.voice.speech import SpeechEvidence
from test_bridge import settings
from test_practice import Client, REPLY, result


def test_capture_measurements_are_bounded_and_do_not_infer_tone():
    capture = SpeechEvidence()
    pcm = struct.pack('<320h', *([1000] * 320))
    capture.observe(pcm, playing=True)
    capture.observe(pcm, playing=False, muted=True)
    evidence = capture.describe(0, 40)
    assert evidence['duration_ms'] == 40 and evidence['playback_overlap_ms'] == 20
    assert evidence['rms_dbfs'] == pytest.approx(-30.3)
    assert evidence['playback_observed'] and evidence['tone_audio_assessed'] is False
    for start, end in [(None, 20), (-1, 20), (0, float('nan')), (True, 20), (0, 100000)]:
        assert capture.describe(start, end) == {'available': False}


@pytest.mark.parametrize('failed', [False, True])
async def test_combat_only_analyses_after_capture_and_keeps_original_on_failure(tmp_path, failed):
    record = SessionRecord('test', 'independent')
    record.data.update(experience='combat', capture_status='completed')
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    model = AsyncMock(side_effect=BridgeError('model_error', '测试失败')) if failed else AsyncMock(return_value=(copy.deepcopy(REPLY), {}))
    with patch('medvisit.services.practice.generate_reply', model):
        await dialogue.open()
        await dialogue.observe(result('研究人', complete=False), False)
        await dialogue.observe(result('研究人群', complete=True), False)
        assert not model.called and not record.data['coaching']
        await dialogue.observe(result('研究人群与局限', complete=True), True)
        assert not model.called
        await dialogue.finish_combat()
        assert model.await_count == 1 and model.call_args.kwargs['speak'] is False
        assert len(record.data['messages']) == 1
        assert record.data['messages'][0]['text'] == '研究人群与局限'
        assert record.data['analysis_status'] == ('error' if failed else 'completed')
        record.save(tmp_path, 'completed')
        assert json.loads((tmp_path / 'test.json').read_text())['messages']
        await dialogue.close()


async def test_summary_uses_early_and_late_turns_with_the_same_analysis_prompt(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    humanizer, = await HUMANIZER_SKILL.list_skills()
    assert humanizer.name == 'humanizer'
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(REPLY)}, 'finish_reason': 'stop', 'index': 0}]})
    client = httpx.AsyncClient
    messages = [{'role': 'trainee', 'text': f'第{i}条证据', 'final': True} for i in range(25)]
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=client(transport=httpx.MockTransport(handler)), **kw)):
        await generate_reply(settings(tmp_path), messages, speak=False)
        await generate_reply(settings(tmp_path), messages)
    record = json.loads(seen[0]['messages'][-1]['content'][0]['text'])
    turns = [message for message in record['transcript'] if message['speaker'] == 'trainee']
    assert len(turns) == 25
    assert '第0条' in json.dumps(turns[0], ensure_ascii=False) and '第24条' in json.dumps(turns[-1], ensure_ascii=False)
    coaches = [payload for payload in seen if PRACTICE_PROMPT in payload['messages'][0]['content'][0]['text']]
    assert len(coaches) == 2 and len(seen) == 3
    for payload in coaches:
        prompt = payload['messages'][0]['content'][0]['text']
        assert humanizer.markdown in prompt
        assert prompt.index(humanizer.markdown) < prompt.index('只润色生成的措辞') < prompt.index('练习与实战使用完全相同')
        assert '最终遵循末尾唯一的 JSON 输出结构' in prompt
        assert '不适用虚构内容豁免' in prompt
        assert 'tools' not in payload
        assert '练习与实战使用完全相同' in json.dumps(payload['messages'][0], ensure_ascii=False)
        assert payload['model'] == 'fake-model'


async def test_combat_without_speech_skips_model(tmp_path):
    record = SessionRecord('test', 'independent')
    record.data['experience'] = 'combat'
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    with patch('medvisit.services.practice.generate_reply', AsyncMock()) as model:
        await dialogue.finish_combat()
        assert record.data['analysis_status'] == 'no_speech'
        model.assert_not_called()


async def test_real_asr_shape_without_segment_start_and_with_corrected_word_times(tmp_path):
    record = SessionRecord('test', 'independent')
    record.data['experience'] = 'combat'
    dialogue = PracticeDialogue(Client(), settings(tmp_path), record)
    for _ in range(50):
        dialogue.speech.observe(bytes(640), playing=False)
    for start, text, definite in [(340, 'Hello.', False), (320, 'Hello, doctor.', True)]:
        await dialogue.observe({'utterances': [{'text': text, 'definite': definite, 'end_time': 600, 'words': [{'start_time': start, 'end_time': 420, 'text': 'Hello'}]}]}, False)
    assert len(record.data['messages']) == 1
    message = record.data['messages'][0]
    assert message['id'] == 'combat-u-0' and message['text'] == 'Hello, doctor.'
    assert message['speech']['available'] and message['speech']['start_ms'] == 320
