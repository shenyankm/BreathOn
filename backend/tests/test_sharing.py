import copy
from unittest.mock import patch

from medvisit.platform.training import prepare_training

from test_generation import setup_generation
from test_platform import client
from test_storage import database_url


def published_scene(client):
    body = setup_generation(client)
    scene = client.post('/api/catalog/scenario',json={**body,'title':'可分享的证据沟通训练','stages':['evidence']}).json()
    return client.post('/api/catalog/scenario/'+scene['id']+'/publish',json={'version':scene['version']}).json()


def test_template_roundtrip_rebinds_ids_and_never_inherits_approval_or_calibration(client):
    scene = published_scene(client)
    exported = client.get('/api/scenarios/'+scene['id']+'/export')
    assert exported.status_code == 200, exported.text
    package = exported.json()
    assert 'status' not in package['doctor'] and 'calibration_status' not in package['rubric']
    assert package['documents'][0]['asset_id'] is None
    imported = client.post('/api/scenarios/import',json=package)
    assert imported.status_code == 201, imported.text
    receipt = imported.json()
    assert receipt['scenario_id'] != scene['id']
    assert client.post('/api/scenarios/import',json=package).json()['scenario_id'] == receipt['scenario_id']
    next_scene = client.get('/api/catalog/scenario/'+receipt['scenario_id']).json()
    assert next_scene['status'] == 'draft' and next_scene['doctor_id'] == receipt['doctor_id']
    assert next_scene['content_ids'] == receipt['document_ids'] and next_scene['content_ids'] != scene['content_ids']
    assert client.get('/api/catalog/doctor/'+receipt['doctor_id']).json()['status'] == 'draft'
    rubric = client.get('/api/catalog/rubric/'+receipt['rubric_id']).json()
    assert rubric['status'] == 'draft' and rubric['calibration_status'] == 'uncalibrated'
    assert client.get('/api/catalog/content/'+receipt['document_ids'][0]).json()['status'] == 'draft'
    assert client.post('/api/catalog/scenario/'+next_scene['id']+'/publish',json={'version':next_scene['version']}).status_code == 409


def test_invalid_packages_cannot_create_partial_entities_or_claim_local_assets(client):
    scene = published_scene(client)
    package = client.get('/api/scenarios/'+scene['id']+'/export').json()
    before = {kind:len(client.get('/api/catalog/'+kind).json()) for kind in ('doctor','rubric','content','scenario')}
    for mutation in ('asset','binding','approval','duplicate'):
        invalid = copy.deepcopy(package)
        if mutation == 'asset':invalid['documents'][0]['asset_id'] = 'local-private-asset'
        elif mutation == 'binding':invalid['scenario']['content_ids'] = ['foreign']
        elif mutation == 'approval':invalid['rubric']['calibration_status'] = 'calibrated'
        else:invalid['documents'].append(copy.deepcopy(invalid['documents'][0]))
        assert client.post('/api/scenarios/import',json=invalid).status_code == 422
    assert {kind:len(client.get('/api/catalog/'+kind).json()) for kind in before} == before


def test_oversized_export_returns_an_actionable_error(client):
    scene = published_scene(client)
    training = prepare_training(client.app.state.platform, client.app.state.local_user, scene['id'])
    template = training['documents'][0]
    training['documents'] = [{**template, 'id':str(index),
        'pages':[{'number':page+1,'text':'合'*20000} for page in range(50)]} for index in range(3)]
    with patch('medvisit.platform.sharing.prepare_training', return_value=training):
        response = client.get('/api/scenarios/'+scene['id']+'/export')
    assert response.status_code == 422 and '7.5MB' in response.json()['detail']
