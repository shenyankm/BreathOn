import pytest


@pytest.fixture(autouse=True)
def isolate_doctor_speech(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DEEPSEEK_SEARCH_ENABLED", "false")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173")
    async def speech(settings, text, section_id, send_audio, *, instruction=None):
        await send_audio(bytes(640))
        return {"text_words": len(text)}
    monkeypatch.setattr('medvisit.services.practice.synthesize', speech)
    # Transport fixtures must not send synthetic utterances to real medical-inference providers.
    monkeypatch.setattr('medvisit.api.app.MEDICAL_SNAPSHOT', None)


from fastapi.testclient import TestClient as RawTestClient


def clear_test_database(url):
    import psycopg
    with psycopg.connect(url) as connection:
        for table in ('platform_entities', 'sessions'):
            if connection.execute('SELECT to_regclass(%s)', (table,)).fetchone()[0]:
                connection.execute(f'TRUNCATE {table}')


class LocalClient(RawTestClient):
    """Browser requests still include an allowed origin in single-user mode."""
    def __enter__(self):
        super().__enter__()
        self.headers['origin'] = 'http://127.0.0.1:5173'
        return self
