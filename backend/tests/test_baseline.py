from tools.prepare_training import baseline_rubric, prepare
from medvisit.platform.models import Rubric
from test_platform import client, pdf_fixture
from test_storage import database_url


def test_baseline_is_idempotent_and_keeps_expert_review_separate(client):
    def call(method, path, body=None, *, raw=None):
        response = client.request(method, '/api'+path, **({'content':raw,'headers':{'content-type':'application/pdf'}} if raw is not None else {'json':body} if body is not None else {}))
        assert response.is_success, response.text
        return response.json()
    first = prepare(call, pdf_fixture())
    second = prepare(call, pdf_fixture())
    assert first['document_id'] == second['document_id'] and first['scenario_id'] == second['scenario_id']
    assert first['source_checked'] and not first['medical_expert_review']
    assert first['calibration_status'] == 'uncalibrated'
    assert len(client.get('/api/catalog/content').json()) == 1
    package = call('GET', '/scenarios/'+first['scenario_id']+'/export')
    imported = call('POST', '/scenarios/import', package)
    repeated = prepare(call, pdf_fixture())
    for key in ('document_id','doctor_id','rubric_id','scenario_id'):
        assert repeated[key] == first[key]
    for kind, key in (('doctor','doctor_id'),('rubric','rubric_id'),('scenario','scenario_id')):
        assert call('GET', '/catalog/'+kind+'/'+imported[key])['status'] == 'draft'
    assert call('GET', '/catalog/content/'+imported['document_ids'][0])['status'] == 'draft'
    rubric = Rubric(**baseline_rubric())
    assert sum(item.weight for item in rubric.dimensions) == 100
    assert {'objections','closing','needs','evidence'} <= {item.key for item in rubric.dimensions}
