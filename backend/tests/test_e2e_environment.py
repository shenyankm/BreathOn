from pathlib import Path
from unittest.mock import Mock

import pytest

from tools import e2e_app
from tools.e2e_audio import resample
import struct


def test_e2e_server_requires_fresh_private_storage(tmp_path, monkeypatch):
    monkeypatch.setenv('E2E_DATA_DIR',str(tmp_path))
    (tmp_path/'existing').write_text('Preserve existing data')
    with pytest.raises(ValueError,match='fresh empty'):
        e2e_app.build()
    assert (tmp_path/'existing').read_text()=='Preserve existing data'


@pytest.mark.parametrize('url',['postgresql://server/breathon_e2e','postgresql://127.0.0.1/production','postgresql://localhost/postgres'])
def test_e2e_server_rejects_nonisolated_databases(tmp_path,monkeypatch,url):
    monkeypatch.setenv('E2E_DATA_DIR',str(tmp_path))
    monkeypatch.setenv('E2E_DATABASE_URL',url)
    with pytest.raises(ValueError,match='dedicated local'):
        e2e_app.build()


def test_e2e_server_ignores_normal_record_and_database_configuration(tmp_path,monkeypatch):
    monkeypatch.setenv('E2E_DATA_DIR',str(tmp_path))
    monkeypatch.delenv('E2E_DATABASE_URL',raising=False)
    monkeypatch.setenv('DATABASE_URL','postgresql://real-server/production')
    monkeypatch.setenv('RECORDS_DIR','/do-not-use')
    create=Mock();monkeypatch.setattr(e2e_app,'create_app',create)
    e2e_app.build()
    settings=create.call_args.args[0]
    assert settings.records==Path(tmp_path)/'sessions' and settings.database_url==''
    assert settings.auth_required and len(settings.login_users)==5
    assert settings.origins==('http://127.0.0.1:5187',)


def test_synthetic_audio_resampling_keeps_signed_pcm_range():
    assert resample(struct.pack('<6h',-32768,-32768,32767,32767,0,0))==struct.pack('<4h',-32768,-1,32767,0)
