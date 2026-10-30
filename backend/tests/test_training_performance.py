from collections import Counter
import copy
import tracemalloc
from unittest.mock import MagicMock

from fastapi import HTTPException
import pytest

from medvisit.platform import evaluation
from medvisit.platform.training import check_materials, retrieve
from test_training import training


def test_retrieval_retains_only_selected_chunks(training):
    documents = training['documents']
    documents[0]['pages'][0]['text'] = '教学 evidence 绝对变化。' * 220_000
    tracemalloc.start()
    try:
        rows = retrieve(documents, 'evidence')
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert len(rows) == 10
    assert peak < 2_000_000


@pytest.mark.parametrize('limit', [-1, 0, 1, 10, 30])
def test_retrieval_preserves_tie_order_and_slice_semantics(training, limit):
    document = training['documents'][0]
    documents = [{**document, 'id': item_id, 'pages':[
        {'number': page, 'text': f'{item_id}-{page}-' + '合成教学。' * 500}
        for page in (2, 1)]} for item_id in ('z', 'a')]
    expected = [(doc['id'], page['number'], page['text'][offset:offset+1300])
        for doc in documents for page in doc['pages'] for offset in range(0, len(page['text']), 1100)]
    expected.sort(key=lambda row: (row[0], row[1]))
    actual = retrieve(documents, '', limit=limit)
    assert [(row['document_id'], row['page'], row['text']) for row in actual] == expected[:limit]
    assert [row['id'] for row in actual] == [f'D{i+1}' for i in range(len(actual))]


def test_assessment_normalizes_reused_evidence_once_per_validation(monkeypatch):
    text = '固定一年，绝对下降 3 个百分点。' * 2000
    source = '合成材料；绝对下降 3 个百分点。' * 80
    quote = '绝对下降3个百分点'
    history = [{'id':'u', 'speaker':'trainee', 'final':True, 'text':text}]
    dimensions = [{'key':str(i), 'label':str(i), 'weight':10, 'requires_content':True, 'anchors':['a']*5}
                  for i in range(10)]
    view = {'rubric':{'id':'r', 'name':'量表', 'calibration_status':'uncalibrated', 'dimensions':dimensions},
            'evidence':[{'id':'D1', 'text':source, 'page':1}]}
    raw = {'dimensions':[{'key':d['key'], 'score':4, 'reason':'核对',
            'utterances':[{'message_id':'u', 'quote':quote}]*4,
            'citations':[{'source_id':'D1', 'quote':quote}]*3} for d in dimensions]}
    calls = Counter()
    normalize = evaluation.normalize

    def track(value):
        calls[value] += 1
        return normalize(value)

    monkeypatch.setattr(evaluation, 'normalize', track)
    result = evaluation.validate_assessment(raw, view, history, 'model')
    assert result['total'] == 100
    assert calls == {text:1, source:1, quote:1}
    changed = copy.deepcopy(view)
    changed['evidence'][0]['text'] = '资料已经改变，不含旧数值。'
    result = evaluation.validate_assessment(raw, changed, history, 'model')
    assert result['total'] is None and all(row['score'] is None for row in result['dimensions'])
    assert calls[text] == 2


def test_evidence_free_validation_does_not_open_a_database_transaction():
    store = MagicMock()
    check_materials(store, 'workspace', {'documents':[]})
    store.transaction.assert_not_called()


@pytest.mark.parametrize('current', [None, {'version':1, 'status':'retired'},
    {'version':2, 'status':'approved'}, {'version':1, 'status':'approved', 'expires_at':'2000-01-01T00:00:00+00:00'}])
def test_nonempty_material_validation_still_rejects_changed_sources(current):
    store = MagicMock()
    transaction = store.transaction.return_value.__enter__.return_value
    transaction.get.return_value = current
    with pytest.raises(HTTPException) as error:
        check_materials(store, 'workspace', {'documents':[{'id':'doc', 'version':1}]})
    assert error.value.status_code == 409
    transaction.get.assert_called_once_with('workspace', 'content', 'doc')
