from fastapi.testclient import TestClient
from uuid import uuid4

from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings
from test_medical import corpus_fixture


def test_representative_cannot_read_unreviewed_sources_or_manage_exports(tmp_path):
    password = 'example secure password'
    encoded = hash_password(password)
    origin = 'https://example.test'
    app = create_app(Settings(records=tmp_path, auth_required=True,
        login_users={'admin':encoded, 'rep':encoded}, origins=(origin,)))
    corpus_fixture(app.state.medical_corpus.root)
    with TestClient(app, base_url=origin, headers={'Origin':origin}) as client:
        item_id = str(uuid4())
        assert client.get(f'/api/visits/{item_id}/provider-audio?token=invalid').status_code == 404
        assert client.get(f'/api/visits/{item_id}/audio').status_code == 401
        assert client.post('/api/auth/login', json={'username':'rep','password':password}).status_code == 200
        assert client.get('/api/research/sources/' + 'a'*24 + '/' + 'b'*64 + '/html').status_code == 403
        assert client.get('/api/medical/wiki.zip').status_code == 403
        assert client.get('/api/medical/sources/test-source').status_code == 404
        assert client.get('/api/medical/sources/test-source/original').status_code == 404
        assert client.get('/api/scenarios/known-draft/export').status_code == 403
        assert client.post('/api/content/import', json={}).status_code == 403
        assert client.post('/api/scenarios/import', json={}).status_code == 403
        assert client.put('/api/usage/prices', json={}).status_code == 403
