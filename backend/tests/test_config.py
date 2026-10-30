from pathlib import Path

import pytest

from medvisit.core.config import Settings


def test_sensitive_settings_are_omitted_from_repr():
    config = Settings(api_key='duplex-secret', asr_api_key='asr-secret', deepseek_api_key='model-secret',
        tts_api_key='tts-secret', database_url='postgresql://user:database-secret@localhost/app')
    shown = repr(config)
    for secret in ('duplex-secret', 'asr-secret', 'model-secret', 'tts-secret', 'database-secret'):
        assert secret not in shown
    assert 'deepseek_model=' in shown


@pytest.mark.parametrize('name', ['deepseek_max_concurrency', 'deepseek_search_qps', 'deepseek_fetch_qps', 'max_sessions'])
@pytest.mark.parametrize('value', [0, -1, 1.5, True, float('inf'), float('nan')])
def test_limits_reject_invalid_integers_before_building_runtime_resources(name, value):
    with pytest.raises(ValueError, match=name.upper()):
        Settings(**{name:value})


@pytest.mark.parametrize('name', ['session_seconds', 'handshake_seconds'])
@pytest.mark.parametrize('value', [0, -1, True, float('inf'), float('nan'), '0.1'])
def test_timeouts_require_finite_positive_numbers(name, value):
    with pytest.raises(ValueError, match=name.upper()):
        Settings(**{name:value})


def test_short_test_timeouts_and_unconfigured_providers_remain_supported():
    config = Settings(api_key='', asr_api_key='', deepseek_api_key='', tts_api_key='',
        handshake_seconds=.08, session_seconds=.1)
    assert config.handshake_seconds == .08 and config.session_seconds == .1


def test_invalid_environment_integer_does_not_echo_its_value(monkeypatch):
    monkeypatch.setenv('DEEPSEEK_MAX_CONCURRENCY', 'accidentally-pasted-secret')
    with pytest.raises(ValueError, match='DEEPSEEK_MAX_CONCURRENCY') as error:
        Settings()
    assert 'accidentally-pasted-secret' not in str(error.value)


@pytest.mark.parametrize('origin', ['*', 'https://*.example.com', 'https://user:secret@example.com',
    'https://example.com/', 'https://example.com/path', 'https://example.com?key=secret',
    'https://example.com#fragment', 'https://example.com?', 'https://example.com#',
    'ftp://example.com', 'https://example.com:invalid', 'https://example.com:70000',
    'https://exa mple.com', 'https://example.com\n', 'https://example.com\x7f',
    'https://example.com\\path', 'https://exa%6dple.com', 'null'])
def test_invalid_origin_fails_fast_without_exposing_configuration(origin):
    with pytest.raises(ValueError, match='ALLOWED_ORIGINS') as error:
        Settings(origins=(origin,))
    assert origin not in str(error.value)


@pytest.mark.parametrize('origins', [(), 'https://example.com', (1,)])
def test_origins_require_a_nonempty_collection_of_origin_strings(origins):
    with pytest.raises(ValueError, match='ALLOWED_ORIGINS'):
        Settings(origins=origins)


def test_valid_origins_are_canonicalized_without_broadening_access():
    config = Settings(origins=('http://localhost:5173', 'https://EXAMPLE.com:443', 'http://[::1]:8080'))
    assert config.origins == ('http://localhost:5173', 'https://example.com', 'http://[::1]:8080')
    assert 'https://child.example.com' not in config.origins


def test_records_directory_is_configurable_and_explicit_argument_takes_priority(tmp_path, monkeypatch):
    monkeypatch.setenv('RECORDS_DIR', str(tmp_path/'mounted-records'))
    assert Settings().records == tmp_path/'mounted-records'
    assert Settings(records=tmp_path/'explicit').records == tmp_path/'explicit'
    monkeypatch.setenv('RECORDS_DIR', '')
    assert Settings().records == Path(__file__).resolve().parents[1]/'data/sessions'
