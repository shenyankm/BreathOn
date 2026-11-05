"""Offline provider-delay and real database benchmarks; never uses configured provider credentials."""
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import platform
import sqlite3
import subprocess
import sys
import tracemalloc
from tempfile import TemporaryDirectory
from time import perf_counter
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import httpx2 as httpx
from openai import AsyncClient
import psycopg

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'backend'))
sys.path.insert(0, str(ROOT/'backend/tests'))
from medvisit.agents import coach
from medvisit.platform import store
from medvisit.services import practice
from medvisit.storage.records import SessionRecord
from test_bridge import settings
from test_practice import REPLY

revision = sys.argv[1] if len(sys.argv) > 1 else '514dcfa'


def baseline(module):
    path = Path(module.__file__).relative_to(ROOT)
    source = subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=ROOT, text=True)
    loaded = ModuleType(module.__name__ + '_baseline')
    loaded.__package__ = module.__package__
    loaded.__file__ = module.__file__
    exec(compile(source, str(path), 'exec'), loaded.__dict__)
    return loaded


def percentiles(samples):
    ordered = sorted(samples)
    return {'n':len(samples), 'p50_ms':round(ordered[len(ordered)//2], 3),
            'p95_ms':round(ordered[(95*len(ordered)+99)//100-1], 3)}


async def latency(module, practice_module, directory):
    events = {}
    provider = {}
    started = perf_counter()
    async def handler(request):
        payload = json.loads(request.content)
        doctor = '本次只扮演医生' in json.dumps(payload['messages'][0], ensure_ascii=False)
        purpose = 'doctor' if doctor else 'coach'
        provider[purpose+'_request_ms'] = (perf_counter()-started)*1000
        await asyncio.sleep(.015 if doctor else .100)
        provider[purpose+'_valid_response_ms'] = (perf_counter()-started)*1000
        return httpx.Response(200, json={'choices':[{'message':{'role':'assistant',
            'content':json.dumps({'doctor_reply':REPLY['doctor_reply']} if doctor else REPLY)},
            'finish_reason':'stop', 'index':0}],
            'usage':{'prompt_tokens':8, 'completion_tokens':4, 'total_tokens':12}})
    async def send(payload):
        if payload['type'] == 'practice_turn':
            events.setdefault('first_valid_doctor_ms', (perf_counter()-started)*1000)
        if payload['type'] == 'audio':
            events.setdefault('first_audio_ms', (perf_counter()-started)*1000)
    async def synthesize(settings, text, section_id, send_audio, **kwargs):
        await asyncio.sleep(.020)
        await send_audio(bytes(960))
        return {'submitted_characters':len(text)}
    real_client = httpx.AsyncClient
    record = SessionRecord('synthetic', 'assisted')
    record.transcript('u', 'trainee', '请核对研究人群和资料范围。', final=True)
    dialogue = practice_module.PracticeDialogue(SimpleNamespace(send_json=send), settings(Path(directory)), record)
    with patch('openai.AsyncClient', lambda **kw:AsyncClient(http_client=real_client(transport=httpx.MockTransport(handler)), **kw)), \
         patch.object(practice_module, 'generate_reply', module.generate_reply), patch.object(practice_module, 'synthesize', synthesize):
        await dialogue.respond(0, 'u')
        if dialogue.voice_task:
            await dialogue.voice_task
        await dialogue.close()
    completed = (perf_counter()-started)*1000
    result = [m['text'] for m in record.data['messages']]
    coaching = [{k:v for k,v in row.items() if k != 'doctor_id'} for row in record.data['coaching']]
    usage = [{k:v for k,v in row.items() if k != 'elapsed_seconds'} for row in record.data['usage']]
    return (result, coaching, usage), {**provider, **events, 'complete_ms':completed,
        'model_request_to_doctor_ms':events['first_valid_doctor_ms']-provider['doctor_request_ms']}


async def voice_benchmark():
    old, old_practice = baseline(coach), baseline(practice)
    samples = {name:{metric:[] for metric in ('doctor_request_ms','doctor_valid_response_ms',
        'first_valid_doctor_ms','model_request_to_doctor_ms','first_audio_ms','complete_ms')}
               for name in ('before','after')}
    with TemporaryDirectory() as directory:
        # Warm imports and skill loaders; every measured call still constructs and closes fresh HTTP clients.
        for module, dialogue_module in ((old,old_practice), (coach,practice)):
            await latency(module, dialogue_module, directory)
        for index in range(20):
            outputs = []
            runs = [('before',old,old_practice), ('after',coach,practice)]
            for label, module, dialogue_module in runs if index % 2 == 0 else reversed(runs):
                result, timings = await latency(module, dialogue_module, directory)
                outputs.append(result)
                for metric in samples[label]:
                    samples[label][metric].append(timings[metric])
            assert outputs[0] == outputs[1]
    return {'scope':'real PracticeDialogue with synthetic HTTP: doctor 15ms, coach 100ms, TTS first PCM 20ms; preserves 400ms turn debounce; no real ASR, microphone or audible playback',
            **{name:{metric:percentiles(values) for metric, values in metrics.items()}
               for name, metrics in samples.items()}}


def catalogue_benchmark(connection, postgres, chars):
    old = baseline(store).Transaction(connection, postgres=postgres)
    new = store.Transaction(connection, postgres=postgres)
    old.execute('CREATE TEMP TABLE IF NOT EXISTS platform_entities (tenant_id TEXT, kind TEXT, id TEXT, document TEXT, updated_at TEXT)')
    old.execute('DELETE FROM platform_entities')
    for i in range(20):
        doc = {'id':str(i), 'title':'合成资料', 'status':'approved',
               'pages':[{'number':1, 'text':'合成内容'*(chars//4)}]}
        old.execute('INSERT INTO platform_entities VALUES (?,?,?,?,?)', ('bench','content',str(i),json.dumps(doc,ensure_ascii=False),str(i)))
    def before():
        return [{k:v for k,v in row.items() if k != 'pages'} for row in old.list('bench','content')]
    def after():
        return new.list('bench','content',include_pages=False)
    assert before() == after()
    samples = {before:[], after:[]}
    for index in range(20):
        for run in (before,after) if index % 2 == 0 else (after,before):
            start = perf_counter(); run(); samples[run].append((perf_counter()-start)*1000)
    result = {'database':'PostgreSQL' if postgres else 'SQLite', 'documents':20, 'chars_per_document':chars,
              'before':percentiles(samples[before]), 'after':percentiles(samples[after])}
    for label, run in [('before',before), ('after',after)]:
        tracemalloc.start()
        try:
            run()
            result[label]['python_peak_bytes'] = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
    return result


database = []
with closing(sqlite3.connect(':memory:')) as connection:
    for chars in (200,500000):
        database.append(catalogue_benchmark(connection,False,chars))
url = os.getenv('TEST_DATABASE_URL')
if url:
    # Every write uses temporary tables scoped to this one connection.
    with psycopg.connect(url) as connection:
        for chars in (200,500000):
            database.append(catalogue_benchmark(connection,True,chars))
print(json.dumps({'baseline':revision, 'platform':platform.platform(),
    'voice':asyncio.run(voice_benchmark()), 'catalogue':database}, ensure_ascii=False, indent=2))
