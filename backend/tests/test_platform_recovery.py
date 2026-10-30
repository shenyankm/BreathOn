import base64

import pytest

from conftest import LocalClient
from medvisit.api.app import create_app
from test_bridge import settings
from test_platform import DOC, pdf_fixture


@pytest.mark.parametrize('method', ['post', 'put'])
@pytest.mark.parametrize('nested', [False, True])
def test_catalog_validation_is_bounded_redacted_and_does_not_write(tmp_path, method, nested):
    with LocalClient(create_app(settings(tmp_path))) as client:
        path = '/api/catalog/content'
        body = dict(DOC)
        if method == 'put':
            original = client.post(path, json=DOC).json()
            path += '/' + original['id']
            body['version'] = original['version']
        before = client.get('/api/catalog/content').json()
        private_key = 'private-field-name-' + 'x' * 10000
        extra = {private_key: 'private-field-value', **{f'extra-{i}': 'value' for i in range(40)}}
        if nested:
            body['pages'] = [{**DOC['pages'][0], **extra}]
        else:
            body.update(extra)
        response = getattr(client, method)(path, json=body)
        assert response.status_code == 422
        assert len(response.content) < 4000
        assert 'private-field-name' not in response.text and 'private-field-value' not in response.text
        errors = response.json()['detail']
        assert len(errors) == 20
        assert all(error['loc'][-1] == '<extra_field>' for error in errors)
        assert client.get('/api/catalog/content').json() == before
        if method == 'put':
            assert client.get(path).json() == original


@pytest.mark.parametrize('damage', ['base64', 'body', 'size', 'hash', 'missing'])
def test_pdf_download_rejects_corruption_and_recovers_after_asset_restore(tmp_path, damage):
    with LocalClient(create_app(settings(tmp_path))) as client:
        raw = pdf_fixture()
        uploaded = client.post('/api/content/pdf', content=raw, headers={'Content-Type':'application/pdf'}).json()
        content = client.post('/api/catalog/content', json={**DOC, 'asset_id':uploaded['asset_id']}).json()
        path = '/api/catalog/content/' + content['id'] + '/file'
        store, workspace = client.app.state.platform, client.app.state.local_user['workspace']
        with store.transaction(workspace) as tx:
            original = tx.get(workspace, 'asset', uploaded['asset_id'])
            damaged = dict(original)
            if damage == 'base64':
                damaged['data'] += '!!'
            elif damage == 'body':
                damaged['data'] = base64.b64encode(raw.replace(b'Training', b'Damaged!')).decode()
            elif damage == 'size':
                damaged['size'] += 1
            elif damage == 'hash':
                damaged['sha256'] = '0' * 64
            else:
                del damaged['sha256']
            corrupted = tx.update(workspace, 'asset', original['id'], damaged, original['version'])
        response = client.get(path)
        assert response.status_code == 409
        assert '恢复' in response.json()['detail'] and '重新上传' in response.json()['detail']
        assert client.get('/api/catalog/content/' + content['id']).json() == content
        with store.transaction(workspace) as tx:
            assert tx.get(workspace, 'asset', original['id']) == corrupted
            tx.update(workspace, 'asset', original['id'], original, corrupted['version'])
        restored = client.get(path)
        assert restored.status_code == 200 and restored.content == raw
