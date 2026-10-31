"""Synthetic, offline before/after benchmark; run with uv run python benchmarks/performance.py REV."""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
from statistics import median
import subprocess
import sys
from tempfile import TemporaryDirectory
from timeit import repeat
from types import ModuleType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from medvisit.agents import quotes
from medvisit.knowledge import corpus
from medvisit.platform import compliance

revision = sys.argv[1] if len(sys.argv) > 1 else 'bd95a74'
root = Path(__file__).resolve().parents[2]


def baseline(module):
    path = Path(module.__file__).relative_to(root)
    source = subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=root, text=True)
    loaded = ModuleType(module.__name__ + '_baseline')
    loaded.__package__ = module.__package__
    exec(compile(source, str(path), 'exec'), loaded.__dict__)
    return loaded


def measure(name, before, after, number=30):
    assert before() == after(), f'{name}: output changed'
    old = median(repeat(before, number=number, repeat=5)) / number * 1000
    new = median(repeat(after, number=number, repeat=5)) / number * 1000
    return {'case': name, 'before_ms': round(old, 4), 'after_ms': round(new, 4),
            'speedup': round(old / new, 2)}


class PolicyStore:
    def __init__(self):
        self.reads = 0
        self.policy = {'status':'approved', 'legal_status':'effective', 'version':1,
                       'title':'Synthetic', 'source_url':'https://example.org', 'pages':[{'text':'规则原文'}]}
        self.rules = [{'id':str(i), 'status':'published', 'runtime_enforced':True,
                       'policy_id':'p', 'policy_version':1, 'quote':'规则原文'} for i in range(1000)]

    @contextmanager
    def transaction(self, workspace, write=False):
        yield self

    def list(self, workspace, kind):
        return self.rules

    def get(self, workspace, kind, key):
        self.reads += 1
        return self.policy


old_quotes, old_corpus, old_compliance = map(baseline, (quotes, corpus, compliance))
transcript = [{'text':'测试原话，仅供软件测试。 ' * 50} for _ in range(100)]
coach = {'focus':'“测试原话”', 'analysis':'“测试原话”', 'risk':'“未说过的话”',
         'points':['“测试原话”'] * 4, 'delivery':{'logic':'“测试原话”', 'fluency':'“测试原话”'}}


def check(module):
    copy = deepcopy(coach)
    removed = module.apply_quote_check(copy, transcript)
    return copy, removed


results = [measure('quote_check_100_turns', lambda: check(old_quotes), lambda: check(quotes)),
           measure('unquoted_text', lambda: old_quotes.verify_quotes('没有引用的建议', transcript),
                   lambda: quotes.verify_quotes('没有引用的建议', transcript))]
store = PolicyStore()
results.append(measure('policy_rules_1000', lambda: old_compliance.active_rules(store, 'w', ['p']),
                       lambda: compliance.active_rules(store, 'w', ['p'])))
store.reads = 0
old_compliance.active_rules(store, 'w', ['p'])
old_reads, store.reads = store.reads, 0
compliance.active_rules(store, 'w', ['p'])
results[-1].update(before_reads=old_reads, after_reads=store.reads)

with TemporaryDirectory() as directory:
    pages = [{'number':i, 'text':('测试药甲 TEST-ONE 2026 指标和安全性 医保支付。 ' * 60)} for i in range(1, 21)]
    sources = [{'id':f'source-{i}', 'title':'Synthetic', 'url':f'https://example.org/{i % 5}',
                'pages':pages, 'product_ids':['test-drug'], 'kind':['trial','label','policy'][i % 3],
                'quality':'original', 'sha256':'a' * 64, 'trials':['TEST-ONE'], 'published_at':'2026'} for i in range(30)]
    products = [{'id':'test-drug', 'name':'测试药甲', 'brand':'测试品牌', 'aliases':[]}]
    data = {'format':1, 'products':products, 'sources':sources,
            'compiled':{'test-drug':{'facts':[{'claim':'测试药甲 指标和安全性', 'source_id':'source-0', 'page':1}]}}}
    documents = [{'id':f'doc-{i}', 'title':'Synthetic', 'version':1, 'version_label':'v1',
                  'status':'approved', 'source_url':f'https://example.org/{i}', 'pages':pages} for i in range(80)]
    Path(directory, 'corpus.json').write_text(json.dumps(data))
    before = old_corpus.MedicalCorpus(directory, approved_documents=lambda: documents)
    after = corpus.MedicalCorpus(directory, approved_documents=lambda: documents)
    before.load()
    after.load()
    results.append(measure('approval_30_sources_80_documents', before.approval_snapshot, after.approval_snapshot, 5))
    query = '测试药甲 TEST-ONE 2026 指标和安全性 医保支付'
    results.append(measure('search_with_approved_documents', lambda: before.search(query), lambda: after.search(query), 5))
    # Isolate retrieval CPU from the mandatory current-approval lookup.
    approvals = before.approval_snapshot()
    before.approved_documents = after.approved_documents = None
    for query_variant in [query, 'unknown', '测试药甲剂量', '医保支付2025', 'TEST-ONE']:
        assert before.search(query_variant, approvals=approvals) == after.search(query_variant, approvals=approvals)
    results.append(measure('search_1200_chunks', lambda: before.search(query, approvals=approvals),
                           lambda: after.search(query, approvals=approvals), 10))

print(json.dumps({'baseline':revision, 'timing':'median of 5 repeats; milliseconds per call', 'results':results}, indent=2))
