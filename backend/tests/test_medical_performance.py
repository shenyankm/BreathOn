from unittest.mock import patch
import tracemalloc

from medvisit.knowledge import corpus as module
from test_medical import corpus_fixture


def test_approval_normalizes_source_pages_once_for_multiple_receipts(tmp_path):
    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    documents = [{**document, 'id':f'doc-{i:02}'} for i in range(20)]
    corpus.approved_documents = lambda: list(reversed(documents))
    data = corpus.load()
    with patch.object(module, 'quotation_text', wraps=module.quotation_text) as normalize:
        approvals = corpus.approval_snapshot(data)
    assert normalize.call_count == 21
    assert approvals[('test-source', 1)]['document_id'] == 'doc-00'
    assert len(approvals) == 21
    documents[0]['pages'] = [{'number':1, 'text':'修订后的原文'}]
    assert corpus.approval_snapshot(data)[('test-source', 1)]['document_id'] == 'doc-01'
    for document in documents:
        document['status'] = 'retired'
    assert corpus.approval_snapshot(data) == {}


def test_search_does_not_retain_rejected_derived_chunks(tmp_path, monkeypatch):
    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    document['pages'] = [{'number':1, 'text':'无关合成材料。' * 200_000}]
    # Isolate chunk selection from the mandatory document hash and approval reads.
    sources = corpus.approved_sources()
    approvals = corpus.approval_snapshot()
    monkeypatch.setattr(corpus, 'approved_sources', lambda: sources)
    data = corpus.load()
    tracemalloc.start()
    try:
        assert corpus.search('unmatched', data=data, approvals=approvals) == []
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 500_000


def test_approval_keeps_first_receipt_when_legacy_identifiers_and_pages_repeat(tmp_path):
    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    documents = [{**document, 'pages':[{'number':1, 'text':text}]} for text in ('甲原文', '乙原文')]
    corpus.approved_documents = lambda: documents
    data = corpus.load()
    data['sources'][0]['pages'] = [documents[1]['pages'][0], documents[0]['pages'][0]]
    approvals = corpus.approval_snapshot(data)
    first = corpus.approved_sources()[0]
    assert approvals[('test-source', 1)]['document_sha256'] == first['sha256']
