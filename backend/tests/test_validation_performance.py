from collections import Counter
from copy import deepcopy
import hashlib
from itertools import product
import json
from unittest.mock import MagicMock, Mock
from uuid import UUID

from fastapi import HTTPException
import pytest

from medvisit.platform import cases, management, operations
from medvisit.services import visit_summary
from medvisit.storage.records import SessionRecord


def document_case():
    pages = [{'number':i, 'text':'合成原文，核对适用范围。 '*100} for i in range(1,101)]
    doc = {'id':'d', 'status':'approved', 'version':1, 'pages':pages}
    digest = hashlib.sha256(json.dumps(pages, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    item = {'documents':[{'id':'d','version':1,'sha256':digest}],
            'citations':[{'document_id':'d','document_version':1,'page':100,'quote':'核对适用范围'}]*12}
    return doc, item


def test_case_normalizes_repeated_quotes_and_pages_once_and_rechecks_next_call(monkeypatch):
    doc, item = document_case()
    calls = Counter()
    normalize = cases.normalize
    def counted(text):
        calls[text] += 1
        return normalize(text)
    monkeypatch.setattr(cases, 'normalize', counted)
    tx = Mock(); tx.get.return_value = doc
    service = cases.Cases(None,None)
    service.validate_sources(tx, {'workspace':'w'}, item)
    assert calls == {item['citations'][0]['quote']:1, doc['pages'][-1]['text']:1}
    assert tx.get.call_count == 1
    doc['status'] = 'retired'
    with pytest.raises(HTTPException) as error:
        service.validate_sources(tx, {'workspace':'w'}, item)
    assert error.value.status_code == 409 and tx.get.call_count == 2


@pytest.mark.parametrize('damage', ['version','hash','page','quote','uncaptured'])
def test_case_still_rejects_invalid_evidence(damage):
    doc, item = document_case()
    item = deepcopy(item)
    if damage == 'version': item['documents'][0]['version'] = 2
    if damage == 'hash': item['documents'][0]['sha256'] = 'changed'
    if damage == 'page': item['citations'][0] = {**item['citations'][0], 'page':101}
    if damage == 'quote': item['citations'][0] = {**item['citations'][0], 'quote':'虚构的原文999'}
    if damage == 'uncaptured': item['documents'] = []
    tx = Mock(); tx.get.return_value = doc
    with pytest.raises(HTTPException) as error:
        cases.Cases(None,None).validate_sources(tx, {'workspace':'w'}, item)
    assert error.value.status_code in (409,422)


def test_review_reuses_current_documents_and_normalization_without_cross_request_cache(monkeypatch):
    doc, item = document_case()
    record = {'workspace':'w', 'messages':[], 'training':{'documents':item['documents'],
              'rubric':{'dimensions':[{'key':str(i),'requires_content':True} for i in range(10)]}}}
    body = operations.Review(comment='核对', overrides=[{'key':str(i),'score':2,'reason':'核对',
        'citations':[{k:v for k,v in item['citations'][0].items() if k != 'document_version'}]*3} for i in range(10)])
    records, store, tx = Mock(), MagicMock(), Mock()
    records.get.return_value = record
    store.transaction.return_value.__enter__.return_value = tx
    tx.get.return_value = doc
    tx.create.return_value = {'id':'review'}
    calls = Counter(); normalize = operations.normalize
    def counted(value):
        calls[value] += 1
        return normalize(value)
    monkeypatch.setattr(operations,'normalize',counted)
    service = operations.Operations(store,records)
    service.review({'workspace':'w','id':'rep'}, str(UUID(int=1)), body)
    assert tx.get.call_count == 1
    assert calls == {item['citations'][0]['quote']:1,doc['pages'][-1]['text']:1}
    tx.create.assert_called_once(); tx.audit.assert_called_once()
    doc['version'] = 2
    with pytest.raises(HTTPException) as error:
        service.review({'workspace':'w','id':'rep'}, str(UUID(int=1)), body)
    assert error.value.status_code == 422 and tx.get.call_count == 2


def test_approval_linear_matching_keeps_distinct_assigned_actors_and_rejection_gate():
    config = management.WorkspaceSettings(version=1, review_rules={'content':'medical_compliance'},
        medical_reviewers=['a','b'],compliance_reviewers=['a','b']).model_dump()
    pool = [{'actor':actor,'role':role,'decision':'approve'} for actor in ('a','b','unknown') for role in ('medical','compliance')]
    tx = Mock()
    for votes in product(pool, repeat=3):
        tx.get.side_effect = [config, {'votes':votes}]
        expected = any(a['actor'] in config['medical_reviewers'] and a['role']=='medical'
            and b['actor'] in config['compliance_reviewers'] and b['role']=='compliance'
            and a['actor']!=b['actor'] for a in votes for b in votes)
        assert management.approval_state(tx,'w','content',{'id':'d','version':1})['ready'] is expected
    tx.get.side_effect = [config, {'votes':[pool[0],pool[3],{'actor':'x','role':'admin','decision':'reject'}]}]
    assert management.approval_state(tx,'w','content',{'id':'d','version':1})['ready'] is False


def test_summary_indexes_exact_message_text_and_normalizes_once_per_call(monkeypatch):
    class Checks(list):
        visits = 0
        def __iter__(self):
            for row in super().__iter__():
                self.visits += 1
                yield row
        def __reversed__(self):
            for index in range(len(self)-1,-1,-1):
                self.visits += 1
                yield self[index]
    record = SessionRecord('synthetic','independent')
    record.data['capture_status']='completed'
    for i in range(100): record.transcript(str(i),'trainee','合成训练原话。 '*100,final=True)
    checks = Checks({'message_id':str(i),'text':'合成训练原话。 '*100,'status':'supported',
                     'statements':[{'status':'supported'}]} for i in range(100))
    # A newer check for superseded text must not replace the check for the current words.
    checks.append({'message_id':'0','text':'已修正的旧文本','status':'insufficient','statements':[]})
    calls = Counter(); normalize = visit_summary.quotation_text
    def counted(text):
        calls[text] += 1
        return normalize(text)
    monkeypatch.setattr(visit_summary,'quotation_text',counted)
    raw = {'dimensions':[{'key':key,'score':80,'reason':'核对','quotes':[{'message_id':'0','quote':'合成训练原话。'}]*4}
                         for key in ('compliance','communication')]}
    result = visit_summary.validate_summary(raw,record,'test',medical_checks=checks)
    assert result['dimensions'][0]['score']==100 and result['total']==88
    assert checks.visits == len(checks)
    assert calls == {'合成训练原话。':1,'合成训练原话。 '*100:1}
    checks.append({'message_id':'0','text':'合成训练原话。 '*100,'status':'insufficient','statements':[]})
    assert visit_summary.validate_summary(raw,record,'test',medical_checks=checks)['total'] is None


def test_case_keeps_the_first_page_if_legacy_page_numbers_repeat():
    doc, item = document_case()
    doc['pages'].append({'number':100,'text':'其他原文不支持旧引用'})
    item['documents'][0]['sha256'] = hashlib.sha256(json.dumps(doc['pages'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    tx = Mock(); tx.get.return_value = doc
    cases.Cases(None,None).validate_sources(tx, {'workspace':'w'}, item)


def test_summary_deduplicates_normalized_edits_and_preserves_medical_priority():
    record = SessionRecord('synthetic','independent')
    record.transcript('u','trainee','合成 原话。第二条原话。',final=True)
    record.data['medical_checks']=[{'message_id':'u','text':'合成 原话。第二条原话。','status':'contradicted',
        'statements':[{'status':'contradicted','text':'合成原话。','reason':'核对','correction':'核对原文。','citations':[{'id':'s'}]}]}]
    proposed=[{'message_id':'u','quote':quote,'category':'communication','reason':'核对','rewrite':'重新表达。'}
              for quote in ('合成 原话。','第二条原话。','第二条 原话。')]
    result = visit_summary.validate_summary({'edits':proposed},record,'test')
    assert [row['category'] for row in result['edits']] == ['medical','communication']
    assert [row['quote'] for row in result['edits']] == ['合成原话。','第二条原话。']


async def test_summary_only_materializes_the_existing_eighty_turn_prompt_window(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from test_bridge import settings
    class Text(str):
        slices = 0
        def __getitem__(self, key):
            Text.slices += 1
            return super().__getitem__(key)
    record = SessionRecord('synthetic','independent')
    record.data['messages']=[{'id':str(i),'role':'trainee' if i == 0 else 'doctor','text':Text('合成原话。'),'final':True}
                             for i in range(1000)]
    complete = AsyncMock(return_value={})
    monkeypatch.setattr(visit_summary,'json_completion',complete)
    monkeypatch.setattr(visit_summary,'checked_snapshot',AsyncMock(return_value=[]))
    monkeypatch.setattr(visit_summary,'validate_snapshot',AsyncMock())
    await visit_summary.build_visit_summary(settings(tmp_path),record)
    history = complete.call_args.kwargs['user']['transcript']
    assert [row['id'] for row in history] == [str(i) for i in range(920,1000)]
    assert Text.slices == 80 and len(record.data['messages']) == 1000


def test_distinct_practice_filters_invalid_rows_before_sorting_and_keeps_first_tie():
    class Invalid(dict):
        def __getitem__(self, key):
            raise AssertionError('Invalid attempts need no sorting or identity work')
    base = {'owner_id':'rep','scenario_id':'s','stage':'full','transcript_hash':'same','valid':True}
    first = {**base,'id':'first','started_at':'2026-10-30'}
    same = {**base,'id':'same','started_at':'2026-10-30'}
    older = {**base,'id':'older','started_at':'2026-10-29','transcript_hash':'different'}
    assert operations.distinct_valid([Invalid(valid=False),first,same,older]) == [older,first]


def test_summary_does_not_revisit_superseded_checks_after_current_text_is_matched():
    record = SessionRecord('synthetic','independent')
    record.transcript('u','trainee','当前完整原话。',final=True)
    checks = [{'message_id':'u'}, {'message_id':'u','text':'当前完整原话。','status':'supported',
              'statements':[{'status':'supported'}]}]
    assert visit_summary.validate_summary({},record,'test',medical_checks=checks)['dimensions'][0]['score'] == 100
    record.data['messages'] = []
    assert visit_summary.validate_summary({},record,'test',medical_checks=[{}])['dimensions'][0]['score'] is None
