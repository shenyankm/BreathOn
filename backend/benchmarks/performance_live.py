"""Offline equivalence, CPU and allocation checks against a Git revision; no providers."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
from statistics import median
import subprocess
import sys
from timeit import repeat
import tracemalloc
from types import ModuleType, SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from medvisit.knowledge import corpus
from medvisit.services import practice
from medvisit.storage.records import SessionRecord

revision = sys.argv[1] if len(sys.argv) > 1 else '60ab402'
root = Path(__file__).resolve().parents[2]


def baseline(module):
    path = Path(module.__file__).relative_to(root)
    source = subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=root, text=True)
    loaded = ModuleType(module.__name__ + '_baseline')
    loaded.__package__ = module.__package__
    exec(compile(source, str(path), 'exec'), loaded.__dict__)
    return loaded


def measure(name, before, after, number=5, *, memory=False):
    assert before() == after(), f'{name}: output changed'
    samples = {before:[], after:[]}
    for index in range(5):
        for run in ((before, after) if index % 2 == 0 else (after, before)):
            samples[run].append(repeat(run, number=number, repeat=1)[0] / number * 1000)
    old, new = median(samples[before]), median(samples[after])
    result = {'case':name, 'before_ms':round(old, 4), 'after_ms':round(new, 4),
              'speedup':round(old / new, 2)}
    if memory:
        for label, run in [('before', before), ('after', after)]:
            tracemalloc.start()
            try:
                run()
                result[label + '_peak_bytes'] = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
    return result


async def snapshot(module):
    events = []
    async def send(payload):
        events.append(payload)
    record = SessionRecord('synthetic', 'assisted')
    record.data['started_at'] = '2026-11-05T00:00:00+00:00'
    record.data['messages'] = [{'id':f'practice-u-{i}', 'role':'trainee', 'text':f'原话 {i}',
                                'final':True} for i in range(1800)]
    dialogue = module.PracticeDialogue(SimpleNamespace(send_json=send), None, record)
    dialogue.stopping = True
    record.data['coaching'] = [{'based_on':f'practice-u-{i}'} for i in range(1800)]
    dialogue.responded = {f'practice-u-{i}' for i in range(1800)}
    await dialogue.observe({'utterances':[{'text':f'修正 {i}', 'definite':i % 2 == 0}
                                          for i in range(2000)]}, False)
    return record.data, events, dialogue.revision, dialogue.responded


old_practice, old_corpus = baseline(practice), baseline(corpus)
results = [measure('asr_1800_corrections_200_appends',
    lambda:asyncio.run(snapshot(old_practice)), lambda:asyncio.run(snapshot(practice)), number=2)]

pages = [{'number':i, 'text':'合成原文，必须核对适用范围。 ' * 100} for i in range(1, 101)]
documents = [{'id':f'doc-{i:02}', 'title':'Synthetic', 'version':1, 'version_label':'v1',
              'status':'approved', 'source_url':'https://example.org/test', 'pages':pages}
             for i in range(20)]
data = {'sources':[{'id':'synthetic', 'url':'https://example.org/test', 'pages':pages}]}
before = old_corpus.MedicalCorpus(root, approved_documents=lambda: documents)
after = corpus.MedicalCorpus(root, approved_documents=lambda: documents)
results.append(measure('approval_20_receipts_100_pages',
    lambda:before.approval_snapshot(data), lambda:after.approval_snapshot(data)))

# Isolate chunk selection from approval reads and whole-document hashing.
documents = [{**documents[0], 'source_url':'',
              'pages':[{'number':1, 'text':'无关合成材料。' * 200_000}]}]
derived = after.approved_sources()
approvals = after.approval_snapshot({'sources':[]})
before.approved_sources = after.approved_sources = lambda: derived
data = {'sources':[], 'products':[], 'chunks':[]}
results.append(measure('search_rejected_chunks_1400000_chars',
    lambda:before.search('unmatched', data=data, approvals=approvals),
    lambda:after.search('unmatched', data=data, approvals=approvals), memory=True))

# Positive matches, stable ties, varying limits and stale approval receipts stay equivalent.
source = derived[0]
source['pages'] = [{'number':2, 'text':'合成相关材料。 ' * 1000},
                   {'number':1, 'text':'合成相关材料。 ' * 1000}]
source['sha256'] = 'synthetic'
approvals = {(source['id'], page['number']):{'document_id':'doc-00', 'document_version':1,
    'version_label':'v1', 'document_sha256':'synthetic'} for page in source['pages']}
for query in ('合成相关', 'unmatched', ''):
    for limit in (-1, 0, 1, 4, 12):
        assert before.search(query, limit=limit, data=data, approvals=approvals) == after.search(
            query, limit=limit, data=data, approvals=approvals)
stale = deepcopy(approvals)
stale[(source['id'], 1)]['document_sha256'] = 'stale'
assert before.search('合成相关', data=data, approvals=stale) == after.search('合成相关', data=data, approvals=stale)

print(json.dumps({'baseline':revision, 'timing':'median of 5 alternating repeats; local synthetic data',
                  'results':results}, indent=2))
