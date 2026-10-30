import asyncio
from io import BytesIO
from unittest.mock import AsyncMock
from zipfile import ZipFile

from medvisit.research import archive
from medvisit.research.models import ResearchRequest
from test_platform import client, pdf_fixture
from test_storage import database_url
from test_research_archive import URL, TEXT, page


def test_import_policy_archive_rechecks_original_and_is_idempotent(client, monkeypatch):
    service = client.app.state.research
    service.settings.deepseek_search_enabled = True
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(TEXT), URL, {'content-type':'text/html'})))
    metadata, original_text = asyncio.run(archive.archive_source(service.archives, URL))
    captured = {'queries':['政策', '政策更新'], 'search_results':[], 'archives':[metadata], 'errors':[]}
    monkeypatch.setattr(service, '_observations', lambda _:captured)
    job = service._create_job(ResearchRequest(kind='policy', query='政策 文件'))
    service._finish(job, {'findings':[{'title':'政策','details':[],'caveats':[]}], 'further_checks':[]}, {}, '', False, captured)
    body = {'source_id':metadata['id'], 'source_version':metadata['raw_sha256']}
    path = f'/api/research/jobs/{job["id"]}/policy-draft'
    result = client.post(path, json=body)
    assert result.status_code == 201, result.text
    draft = result.json()
    assert draft['status'] == 'draft' and draft['legal_status'] == 'unknown'
    assert draft['pages'][0]['text'] == original_text and draft['pagination'] == 'text_document'
    assert client.post(path, json=body).json()['id'] == draft['id']
    (service.archives/metadata['id']/metadata['raw_sha256']/'content.txt').write_text('damaged')
    assert client.post(path, json=body).status_code == 409


def test_upload_word_to_policy_draft_preserves_original_and_rejects_fake_file(client):
    doc = BytesIO()
    with ZipFile(doc, 'w') as z:
        z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>政策正文须由审核人核对。</w:t></w:r></w:p></w:body></w:document>')
    raw = doc.getvalue()
    result = client.post('/api/research/policy-file?title=测试政策', content=raw, headers={'content-type':'application/octet-stream'})
    assert result.status_code == 201, result.text
    draft = result.json()
    assert draft['status'] == 'draft' and draft['pagination'] == 'text_document'
    assert '政策正文须由审核人核对。' in draft['pages'][0]['text']
    original = client.get(f'/api/research/policy-file/{draft["research_upload_id"]}/original')
    assert original.status_code == 200 and original.content == raw
    assert client.post('/api/research/policy-file?title=测试政策', content=b'not a word document').status_code == 415


def test_upload_pdf_preserves_actual_page_and_separate_size_limit(client):
    raw = pdf_fixture(b'Official policy text for testing.')
    result = client.post('/api/research/policy-file?title=政策原文', content=raw, headers={'content-type':'application/pdf'})
    assert result.status_code == 201, result.text
    draft = result.json()
    assert draft['pagination'] == 'pdf_pages' and draft['pages'][0]['number'] == 1
    assert 'Official policy text' in draft['pages'][0]['text']
    assert draft['asset_id'] == draft['research_upload_id']
    assert client.get(f'/api/research/policy-file/{draft["research_upload_id"]}/original').content == raw
    assert client.get(f'/api/catalog/policy/{draft["id"]}/file').content == raw
    oversized_json = b'x' * 8_000_001
    assert client.post('/api/research/policy-file?title=政策', content=oversized_json,
                       headers={'content-type':'application/octet-stream'}).status_code == 415
    assert client.post('/api/research/policy-file?title=政策', content=b'x' * 20_000_001,
                       headers={'content-type':'application/octet-stream'}).status_code == 413
    assert client.post('/api/research/jobs', content=oversized_json,
                       headers={'content-type':'application/json'}).status_code == 413
