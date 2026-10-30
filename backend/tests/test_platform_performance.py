import hashlib
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
from uuid import uuid4

from medvisit.platform.cases import Cases
from medvisit.platform.progress import estimate_cost, personal_progress
from medvisit.storage.records import SessionRecord, activity_record


def test_pricing_indexes_rates_once_and_keeps_first_matching_snapshot():
    class Prices(list):
        visits = 0

        def __iter__(self):
            for value in super().__iter__():
                self.visits += 1
                yield value

    def rate(model, unit, amount='1'):
        return {'provider':'deepseek', 'model':model, 'unit':unit, 'amount':amount,
                'per_units':1_000_000, 'currency':'USD'}

    prices = Prices([rate(f'other-{i}', 'input_tokens') for i in range(47)] + [
        rate('used', 'input_tokens'), rate('used', 'output_tokens', '2'), rate('used', 'input_tokens', '9')])
    usage = [{'provider':'deepseek', 'model':'used', 'prompt_tokens':1000, 'completion_tokens':500}] * 100
    result = estimate_cost(usage, prices)
    assert result['status'] == 'estimated' and result['totals'] == {'USD':'0.200000'}
    assert len(result['lines']) == 200
    assert result['lines'][0]['rate']['amount'] == '1'
    assert prices.visits == 50


def test_case_citations_reuse_document_read_within_each_validation():
    document = {'id':'source', 'version':1, 'status':'approved',
                'pages':[{'number':1, 'text':'合成教学资料：应核对研究人群、边界与原文。'}]}
    digest = hashlib.sha256(json.dumps(document['pages'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    case = {'documents':[{'id':'source', 'version':1, 'sha256':digest}],
            'citations':[{'document_id':'source', 'document_version':1, 'page':1,
                          'quote':'应核对研究人群、边界与原文'}] * 12}
    tx = Mock()
    tx.get.return_value = document
    cases = Cases(None, None)
    cases.validate_sources(tx, {'workspace':'test'}, case)
    assert tx.get.call_count == 1
    cases.validate_sources(tx, {'workspace':'test'}, case)
    assert tx.get.call_count == 2


def test_progress_batches_detail_reads_and_skips_missing_or_old_records():
    current = datetime.now(timezone.utc)
    rows, documents = [], {}
    for index in range(202):
        record = SessionRecord(str(uuid4()), 'assisted')
        record.data.update(workspace='test', status='completed', ended_at=current.isoformat(),
            started_at=(current-timedelta(days=31) if index == 201 else current-timedelta(minutes=index)).isoformat())
        rows.append(activity_record(record.data))
        if index != 200:
            documents[record.data['id']] = record.data
    records = Mock()
    records.activity.return_value = rows
    records.get.side_effect = lambda item_id: documents.get(str(item_id))
    records.get_many.side_effect = lambda ids: {str(item_id):documents[str(item_id)] for item_id in ids if str(item_id) in documents}
    report = personal_progress(None, records, {'workspace':'test'})
    assert report['session_count'] == 200
    assert report['sessions'][0]['id'] == rows[0]['id']
    assert report['sessions'][-1]['id'] == rows[199]['id']
    records.activity.assert_called_once_with(workspace='test')
    records.get.assert_not_called()
    assert records.get_many.call_count == 5
    assert all(len(call.args[0]) <= 50 for call in records.get_many.call_args_list)
