from fastapi.testclient import TestClient

from medvisit.api.app import create_app
from medvisit.api.auth import hash_password
from medvisit.core.config import Settings

PROFILE = {'name': '肿瘤线代表', 'audience_type': 'representative', 'task': '准备循证拜访',
           'needs': ['正确证据'], 'metrics': ['证据匹配度']}


def test_audience_persistence_validation_conflicts_permissions_and_workspace(tmp_path):
    password = 'example secure password'
    encoded = hash_password(password)
    origin = 'https://example.test'
    config = Settings(records=tmp_path, auth_required=True,
                      login_users={'admin': encoded, 'rep': encoded}, origins=(origin,))
    with TestClient(create_app(config), base_url=origin, headers={'Origin': origin}) as client:
        assert client.get('/api/catalog/audience').status_code == 401
        client.post('/api/auth/login', json={'username': 'admin', 'password': password})
        assert client.get('/api/catalog/audience').json() == []
        for invalid in ({'name': ' '}, {'audience_type': 'invalid'}, {'needs': [' ']}, {'needs': ['x'*201]}, {'metrics': ['x']*21}):
            assert client.post('/api/catalog/audience', json={**PROFILE, **invalid}).status_code == 422
        response = client.post('/api/catalog/audience', json=PROFILE)
        assert response.status_code == 201
        row = response.json()
        path = '/api/catalog/audience/' + row['id']
        assert client.get(path).json()['name'] == PROFILE['name']
        updated = client.put(path, json={**PROFILE, 'name': '更新后的画像', 'version': row['version']})
        assert updated.status_code == 200
        assert client.put(path, json={**PROFILE, 'version': row['version']}).status_code == 409
        tenant = client.app.state.local_user['workspace']
        with client.app.state.platform.transaction('other') as tx:
            tx.create('other', 'audience', {**PROFILE, 'status': 'draft'}, item_id='other-profile')
        assert client.get('/api/catalog/audience/other-profile').status_code == 404
        assert [item['id'] for item in client.get('/api/catalog/audience').json()] == [row['id']]
        with client.app.state.platform.transaction(tenant, write=False) as tx:
            assert {'audience.create', 'audience.edit'} <= {item['action'] for item in tx.list(tenant, 'audit')}
        client.post('/api/auth/logout')
        client.post('/api/auth/login', json={'username': 'rep', 'password': password})
        assert client.get('/api/catalog/audience').json() == []
        assert client.get(path).status_code == 404
        assert client.post('/api/catalog/audience', json=PROFILE).status_code == 403
        assert client.put(path, json={**PROFILE, 'version': 2}).status_code == 403
    with TestClient(create_app(config), base_url=origin, headers={'Origin': origin}) as client:
        client.post('/api/auth/login', json={'username': 'admin', 'password': password})
        assert client.get(path).json()['name'] == '更新后的画像'
