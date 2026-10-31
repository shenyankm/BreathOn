from uuid import uuid4
from unittest.mock import patch

import pytest
from conftest import LocalClient
from medvisit.api.app import create_app
from medvisit.storage.records import SessionRecord
from test_bridge import settings


def recovery(config, **changes):
    record = SessionRecord(str(uuid4()), 'assisted')
    record.data.update(workspace='local', owner_id='local', **changes)
    record.transcript('u1', 'trainee', '保留原话', final=True)
    record.save(config.records / 'recovery', 'completed')
    return record


def test_retry_restores_server_copy_and_is_idempotent(tmp_path):
    config = settings(tmp_path)
    app = create_app(config)
    with LocalClient(app) as client:
        record = recovery(config)
        url = f"/api/sessions/{record.data['id']}/retry-save"
        assert client.post(url).json()['saved'] is True
        original = app.state.records.get(record.data['id'])
        assert original['messages'][0]['text'] == '保留原话'
        assert client.post(url).json()['saved'] is True
        assert app.state.records.get(record.data['id']) == original


@pytest.mark.parametrize('field', ['owner_id', 'workspace'])
def test_retry_cannot_restore_another_users_record(tmp_path, field):
    config = settings(tmp_path)
    app = create_app(config)
    with LocalClient(app) as client:
        record = recovery(config)
        record.data[field] = 'other'
        record.save(config.records / 'recovery', 'completed')
        assert client.post(f"/api/sessions/{record.data['id']}/retry-save").status_code == 404
        assert app.state.records.get(record.data['id']) is None


def test_retry_failure_keeps_recovery_copy(tmp_path):
    config = settings(tmp_path)
    app = create_app(config)
    with LocalClient(app) as client:
        record = recovery(config)
        with patch.object(app.state.records, 'save', side_effect=OSError('storage unavailable')):
            assert client.post(f"/api/sessions/{record.data['id']}/retry-save").status_code == 503
        assert (config.records / 'recovery' / f"{record.data['id']}.json").exists()
