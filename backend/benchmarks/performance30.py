"""Offline equivalence checks and median timings against a Git revision; no services or user data."""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import hashlib
from heapq import nlargest
import json
from pathlib import Path
from statistics import median
from random import Random
import subprocess
import sys
from timeit import repeat
import tracemalloc
from types import ModuleType, SimpleNamespace
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from medvisit.platform import cases, curriculum, management, operations, training
from medvisit.services import visit_summary
from medvisit.storage.records import SessionRecord

revision = sys.argv[1] if len(sys.argv) > 1 else 'a124527'
root = Path(__file__).resolve().parents[2]


def baseline(module):
    path = Path(module.__file__).relative_to(root)
    source = subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=root, text=True)
    loaded = ModuleType(module.__name__ + '_baseline')
    loaded.__package__ = module.__package__
    loaded.__file__ = module.__file__
    exec(compile(source, str(path), 'exec'), loaded.__dict__)
    return loaded


def measure(name, before, after, number=20):
    assert before() == after(), f'{name}: output changed'
    samples = {before:[], after:[]}
    for index in range(5):
        for run in ((before,after) if index%2 == 0 else (after,before)):
            samples[run].append(repeat(run, number=number, repeat=1)[0] / number * 1000)
    old, new = median(samples[before]), median(samples[after])
    return {'case':name, 'before_ms':round(old, 4), 'after_ms':round(new, 4), 'speedup':round(old/new, 2)}


class Store:
    def __init__(self, entities):
        self.entities = entities

    @contextmanager
    def transaction(self, *args, **kwargs):
        yield self

    def get(self, workspace, kind, item_id):
        return next((row for row in self.entities.get(kind, []) if row['id'] == item_id), None)

    def list(self, workspace, kind):
        return self.entities.get(kind, [])

    def create(self, workspace, kind, data):
        return {**data, 'id':'synthetic'}

    def audit(self, *args):
        pass


results = []
user = {'workspace':'synthetic', 'id':'rep'}
lessons = [{'id':str(i), 'level':f'L{i%4+1}', 'status':'draft' if i%5 == 0 else 'published', 'title':'Synthetic'} for i in range(2000)]
state = {'id':'rep', 'plan':[row['id'] for row in lessons], 'completed':{}, 'settings':{}, 'version':1}
store = Store({'lesson':lessons, 'member_state':[state]})
rows = [{'id':str(i), 'started_at':datetime(2026, 10, i%31+1, tzinfo=timezone.utc).isoformat(),
         'valid':i%5 != 0, 'assessment':{'total':i%101}} for i in range(10000)]
records = SimpleNamespace(activity=lambda **scope: rows)
old_cur = baseline(curriculum)
results.append(measure('home_10000_records', lambda:old_cur.home_summary(store, records, user, date(2026,10,31)),
                       lambda:curriculum.home_summary(store, records, user, date(2026,10,31))))
results.append(measure('curriculum_2000_lessons', lambda:old_cur.curriculum(store, user), lambda:curriculum.curriculum(store, user)))
visits = [{'id':str(i), 'owner_id':'rep', 'status':'submitted', 'updated_at':str(i%99)} for i in range(10000)]
queue = Store({'visit':visits})
results.append(measure('review_queue_10000', lambda:old_cur.review_queue(queue, user), lambda:curriculum.review_queue(queue, user)))

text = '合成训练原文，需要核对适用范围。 ' * 2000
pages = [{'number':i+1, 'text':text} for i in range(200)]
document = {'id':'doc', 'version':1, 'status':'approved', 'pages':pages}
digest = hashlib.sha256(json.dumps(pages, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
captured = [{'id':'doc', 'version':1, 'sha256':digest}]
citations = [{'document_id':'doc', 'document_version':1, 'page':200, 'quote':'需要核对适用范围'}] * 12
case = {'documents':captured, 'citations':citations}
docs = Store({'content':[document]})
old_cases = baseline(cases)
results.append(measure('case_12_citations_200_pages', lambda:old_cases.Cases(docs,None).validate_sources(docs,user,case),
                       lambda:cases.Cases(docs,None).validate_sources(docs,user,case), 3))

record = {'id':str(UUID(int=1)), 'workspace':'synthetic', 'messages':[],
          'training':{'documents':captured, 'rubric':{'dimensions':[{'key':str(i), 'requires_content':True} for i in range(10)]}}}
body = operations.Review(comment='Synthetic', overrides=[{'key':str(i), 'score':2, 'reason':'Synthetic',
    'citations':[{k:v for k,v in citation.items() if k != 'document_version'} for citation in citations[:3]]} for i in range(10)])
record_store = SimpleNamespace(get=lambda _:record)
old_ops = baseline(operations)
results.append(measure('review_30_citations', lambda:old_ops.Operations(docs,record_store).review(user,record['id'],body),
                       lambda:operations.Operations(docs,record_store).review(user,record['id'],body), 5))

session = SessionRecord('synthetic','independent')
session.data['capture_status'] = 'completed'
for i in range(500):
    session.transcript(str(i), 'trainee', f'{i} 合成原话。 '*50, final=True)
session.data['medical_checks'] = [{'message_id':str(i), 'text':m['text'], 'status':'supported', 'statements':[]}
                                  for i,m in enumerate(session.data['messages'])]
raw = {'dimensions':[{'key':key, 'score':80, 'reason':'Synthetic', 'quotes':[{'message_id':'0', 'quote':'合成原话。'}]*4}
                      for key in ('compliance','communication')], 'edits':[]}
old_summary = baseline(visit_summary)
def summary(module):
    output = module.validate_summary(raw,session,'test')
    output.pop('created_at')
    return output
results.append(measure('summary_500_turns', lambda:summary(old_summary), lambda:summary(visit_summary)))

policy = {'id':'admin', 'version':1, 'review_rules':{'content':'medical_compliance'},
          'medical_reviewers':['m'], 'compliance_reviewers':['c']}
# Only the settings fields consumed by approval_state are required by workspace_settings.
policy = {**management.WorkspaceSettings(version=1).model_dump(), **policy}
votes = [{'actor':f'other{i}', 'role':'medical', 'decision':'approve'} for i in range(100)]
approvals = Store({'workspace_settings':[policy], 'publication_approval':[{'id':'content:doc:1:1','votes':votes}]})
old_management = baseline(management)
results.append(measure('approval_100_ineligible_votes', lambda:old_management.approval_state(approvals,'synthetic','content',document),
                       lambda:management.approval_state(approvals,'synthetic','content',document), 5))

materials = [{'id':'doc', 'version':1, 'title':'Synthetic', 'version_label':'1', 'source_url':'',
              'pages':[{'number':1, 'text':'SYNTHETIC 示例文本。 '*200000}]}]
old_training = baseline(training)
results.append(measure('retrieve_empty_query', lambda:old_training.retrieve(materials,''), lambda:training.retrieve(materials,''), 3))
random = Random(0)
blocks = [{'id':i, 'text':str(random.randrange(100)) + (' alpha beta gamma delta' if i%5 == 0 else ' plain')}
          for i in range(30000)]
def rank(block):
    folded = block['text'].casefold()
    return sum(term in folded for term in ('alpha','beta','gamma','delta'))
old_selection = lambda:sorted(blocks, key=rank, reverse=True)[:8]
new_selection = lambda:nlargest(8, blocks, key=rank)
selection = measure('archive_top8_of_30000_blocks', old_selection, new_selection, 5)
for label, select in [('before',old_selection), ('after',new_selection)]:
    tracemalloc.start()
    try:
        select()
        selection[label+'_peak_bytes'] = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
results.append(selection)
print(json.dumps({'baseline':revision, 'timing':'median of 5 repeats, milliseconds per call; synthetic local data', 'results':results}, indent=2))
