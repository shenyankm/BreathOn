import asyncio
import hashlib
import json
from pathlib import Path
import socket
from unittest.mock import AsyncMock

from agentscope.skill import LocalSkillLoader
import httpx
import pytest

from medvisit.agents.coach import SKILL_ROOT
from medvisit.core.config import Settings
from medvisit.research import archive
from medvisit.research.agents import PROFILES, research_mcp, validate_result
from medvisit.research.models import ResearchRequest, ResearchResult

URL = 'https://www.example.gov.cn/policy.html'
TEXT = '软件测试用公开原文：本页用于检验来源归档与引文校验，不提供真实政策、医生资质或医学结论。'


def page(text=TEXT, style='color:black'):
    return f'<html><head><meta charset="utf-8"><title>归档测试</title><style>{style}</style></head><body><p>{text}</p><script>fetch("/api/private")</script></body></html>'.encode()


@pytest.mark.parametrize('url', ['file:///etc/passwd', 'http://localhost/private', 'http://127.0.0.1/', 'http://[::1]/',
    'https://example.com:22/', 'https://user:password@example.com/', 'https://example.com/?access_token=secret'])
def test_archive_rejects_nonpublic_or_credentialed_targets(url):
    with pytest.raises(ValueError):
        archive.canonical_url(url)


async def test_dns_rejects_mixed_public_and_private_answers(monkeypatch):
    resolver = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])
    monkeypatch.setattr(asyncio.get_running_loop(), 'getaddrinfo', resolver)
    with pytest.raises(ValueError, match='非公开网络'):
        await archive.resolve_public('example.com', 443)


async def test_tun_fake_dns_uses_public_resolution_without_allowing_private_addresses(monkeypatch):
    monkeypatch.setattr(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.18.5.10', 443))]))
    resolver = AsyncMock(return_value='93.184.216.34')
    monkeypatch.setattr(archive, 'resolve_public_doh', resolver)
    assert await archive.resolve_public('example.com', 443) == '93.184.216.34'
    resolver.assert_awaited_once_with('example.com')


async def test_public_dns_cannot_return_a_private_fetch_target(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={'Status':0, 'Answer':[{'type':1,'data':'10.0.0.1'}]})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(archive.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(ValueError, match='不是公开地址'):
        await archive.resolve_public_doh('example.com')


async def test_download_pins_dns_preserves_tls_name_and_revalidates_redirects(monkeypatch):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(302, headers={'location':'http://127.0.0.1/private'})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(archive.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(archive, 'resolve_public', AsyncMock(return_value='93.184.216.34'))
    with pytest.raises(ValueError, match='公开'):
        await archive.download_public('https://example.com/document')
    assert len(seen) == 1
    assert seen[0].url.host == '93.184.216.34'
    assert seen[0].headers['host'] == 'example.com'
    assert seen[0].extensions['sni_hostname'] == 'example.com'


async def test_html_original_is_immutable_and_reader_escapes_active_content(tmp_path, monkeypatch):
    raw = page(TEXT + ' 文字中的<img src=x onerror=alert(1)>不执行。')
    fetch = AsyncMock(return_value=(raw, URL, {'content-type':'text/html; charset=utf-8', 'etag':'v1'}))
    monkeypatch.setattr(archive, 'download_public', fetch)
    first, text = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / first['id'] / first['raw_sha256']
    assert (folder / 'original.html').read_bytes() == raw
    reader = (folder / 'reader.html').read_text()
    assert '<script>' not in reader and 'onerror=' not in reader
    assert TEXT in reader and '网页文字阅读副本' in reader
    assert 'fetch(' not in text
    assert (folder / 'original.html').stat().st_mode & 0o777 == 0o600
    fetch.return_value = (page(TEXT, 'color:red'), URL, {'content-type':'text/html'})
    second, _ = await archive.archive_source(tmp_path, URL)
    assert first['raw_sha256'] != second['raw_sha256']
    fetch.return_value = (page(TEXT, 'color:blue'), URL, {'content-type':'text/html'})
    third, _ = await archive.archive_source(tmp_path, URL)
    assert second['text_sha256'] == third['text_sha256']
    assert (folder / 'original.html').read_bytes() == raw


async def test_pdf_original_and_per_page_html_are_preserved(tmp_path, monkeypatch):
    raw = b'%PDF- software-test-only'
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(raw, URL, {'content-type':'application/pdf'})))
    monkeypatch.setattr(archive, 'extract_pdf', lambda data: {'pages':[{'number':1,'text':TEXT}, {'number':3,'text':'软件测试第三页'}]})
    metadata, text = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / metadata['id'] / metadata['raw_sha256']
    assert (folder / 'original.pdf').read_bytes() == raw
    html = (folder / 'reader.html').read_text()
    assert '第 1 页' in html and '第 3 页' in html and 'PDF文字转成HTML' in html
    assert '软件测试第三页' in text


async def test_unchanged_pdf_reuses_extraction_and_refreshes_check_metadata(tmp_path, monkeypatch):
    raw = b'%PDF- software-test-only'
    fetch = AsyncMock(return_value=(raw, URL, {'content-type':'application/pdf', 'etag':'first'}))
    calls = []
    def extract(data):
        calls.append(data)
        return {'pages':[{'number':1, 'text':TEXT}]}
    timestamps = iter(('2026-10-28T00:00:00+00:00', '2026-10-29T00:00:00+00:00'))
    monkeypatch.setattr(archive, 'download_public', fetch)
    monkeypatch.setattr(archive, 'extract_pdf', extract)
    monkeypatch.setattr(archive, 'now', lambda: next(timestamps))
    first, first_text = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / first['id'] / first['raw_sha256']
    files = {path.name:path.read_bytes() for path in folder.iterdir()}
    fetch.return_value = (raw, URL, {'content-type':'application/pdf', 'etag':'second'})
    second, second_text = await archive.archive_source(tmp_path, URL)
    assert len(calls) == 1
    assert first_text == second_text and first['raw_sha256'] == second['raw_sha256']
    assert second['retrieved_at'] > first['retrieved_at'] and second['headers']['etag'] == 'second'
    assert {path.name:path.read_bytes() for path in folder.iterdir()} == files


@pytest.mark.parametrize('change', ['resolved_url', 'content_type'])
async def test_archive_reparses_identical_bytes_when_source_context_changes(tmp_path, monkeypatch, change):
    raw = page().replace(b'</body>', b'<a href="attachment.pdf">Attachment</a></body>')
    fetch = AsyncMock(return_value=(raw, URL, {'content-type':'text/html'}))
    monkeypatch.setattr(archive, 'download_public', fetch)
    first, _ = await archive.archive_source(tmp_path, URL)
    if change == 'resolved_url':
        fetch.return_value = (raw, 'https://www.example.gov.cn/changed/index.html', {'content-type':'text/html'})
        second, _ = await archive.archive_source(tmp_path, URL)
        assert second['links'][0]['url'] == 'https://www.example.gov.cn/changed/attachment.pdf'
        assert first['links'][0]['url'] != second['links'][0]['url']
    else:
        fetch.return_value = (raw, URL, {'content-type':'application/octet-stream'})
        with pytest.raises(ValueError, match='仅归档'):
            await archive.archive_source(tmp_path, URL)


@pytest.mark.parametrize('missing', ['original.html', 'reader.html', 'content.txt'])
async def test_unchanged_archive_does_not_hide_missing_cached_files(tmp_path, monkeypatch, missing):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    first, _ = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / first['id'] / first['raw_sha256']
    (folder / missing).unlink()
    with pytest.raises((ValueError, OSError)):
        archive.read_source(tmp_path, first['id'], first['raw_sha256'])
    with pytest.raises((ValueError, OSError)):
        await archive.archive_source(tmp_path, URL)


@pytest.mark.parametrize('corruption', ['text', 'short_text', 'missing_hash', 'invalid_hash'])
async def test_unchanged_archive_rejects_corrupted_cached_text(tmp_path, monkeypatch, corruption):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    first, _ = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / first['id'] / first['raw_sha256']
    if corruption == 'text':
        (folder / 'content.txt').write_text('被修改的正文，不可作为重新核验的原文引文。')
    else:
        metadata = json.loads((folder / 'metadata.json').read_text())
        if corruption == 'short_text':
            (folder / 'content.txt').write_text('too short')
            metadata['text_sha256'] = hashlib.sha256(archive.normalized_text('too short').encode()).hexdigest()
        elif corruption == 'missing_hash':
            del metadata['text_sha256']
        else:
            metadata['text_sha256'] = []
        (folder / 'metadata.json').write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match='损坏'):
        await archive.archive_source(tmp_path, URL)


@pytest.mark.parametrize('corruption', ['list', 'id', 'version', 'kind', 'headers', 'absolute_file', 'relative_file'])
async def test_archive_reads_reject_damaged_metadata_without_changing_files(tmp_path, monkeypatch, corruption):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    first, _ = await archive.archive_source(tmp_path, URL)
    folder = tmp_path / first['id'] / first['raw_sha256']
    metadata = {**first}
    if corruption == 'list':
        metadata = []
    else:
        key, value = {'id':('id', 'a'*24), 'version':('raw_sha256', 'b'*64), 'kind':('kind', 'unknown'),
            'headers':('headers', []), 'absolute_file':('original_file', '/private/file'),
            'relative_file':('original_file', '../../private-file')}[corruption]
        metadata[key] = value
    (folder / 'metadata.json').write_text(json.dumps(metadata))
    files = {path.name:path.read_bytes() for path in folder.iterdir()}
    with pytest.raises(ValueError, match='损坏'):
        archive.read_source(tmp_path, first['id'], first['raw_sha256'])
    assert {path.name:path.read_bytes() for path in folder.iterdir()} == files


@pytest.mark.parametrize('consumer', ['read', 'citations', 'rearchive'])
@pytest.mark.parametrize('filename', ['content.txt', 'original.html'])
async def test_corrupted_archive_text_cannot_be_read_or_used_as_citation(tmp_path, monkeypatch, consumer, filename):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    metadata, text = await archive.archive_source(tmp_path, URL)
    evidence_id = archive.evidence_blocks(text, metadata['raw_sha256'])[0]['id']
    path = tmp_path / metadata['id'] / metadata['raw_sha256'] / filename
    damaged = '被损坏的正文，不是已归档原件中的文字，不应成为检索结果引文。'*3
    path.write_text(damaged)
    result = ResearchResult.model_validate({'findings':[{'title':'软件测试', 'details':[{'label':'发布机关',
        'value':'软件测试材料', 'source_id':metadata['id'], 'evidence_id':evidence_id}], 'caveats':[]}], 'further_checks':[]})
    with pytest.raises(ValueError, match='损坏'):
        if consumer == 'read':
            archive.read_source(tmp_path, metadata['id'], metadata['raw_sha256'])
        elif consumer == 'rearchive':
            await archive.archive_source(tmp_path, URL)
        else:
            validate_result(result, PROFILES['policy'], tmp_path, {'archives':[metadata],
                'queries':['软件测试', '软件测试后续更新'], 'evidence_seen':{metadata['id']:[evidence_id]}})
    assert path.read_text() == damaged


def test_gb_encoded_html_is_decoded_without_changing_original():
    raw = '<meta charset="gb2312"><p>中文原文</p>'.encode('gb2312')
    assert '中文原文' in archive.decode_html(raw, 'text/html')


@pytest.mark.parametrize('charset', ['unknown-encoding', 'rot_13', 'base64_codec'])
async def test_invalid_html_charset_falls_back_to_utf8(tmp_path, monkeypatch, charset):
    raw = page()
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(raw, URL, {'content-type':f'text/html; charset={charset}'})))
    metadata, text = await archive.archive_source(tmp_path, URL)
    assert TEXT in text
    assert (tmp_path / metadata['id'] / metadata['raw_sha256'] / 'original.html').read_bytes() == raw


def test_document_wraps_do_not_merge_distinct_numeric_values():
    assert archive.normalized_text('玛仕度肽\n注射液') == archive.normalized_text('玛仕度肽注射液')
    assert archive.normalized_text('浓度为1 2毫克') != archive.normalized_text('浓度为12毫克')


async def test_all_three_skills_load_and_fake_citations_are_rejected(tmp_path, monkeypatch):
    for profile in PROFILES.values():
        skill, = await LocalSkillLoader(str(SKILL_ROOT / profile['skill'])).list_skills()
        assert skill.name == profile['skill'] and 'source_id' in skill.markdown
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    metadata, _ = await archive.archive_source(tmp_path, URL)
    evidence_id = archive.evidence_blocks(archive.read_source(tmp_path,metadata['id'],metadata['raw_sha256'])[1], metadata['raw_sha256'])[0]['id']
    detail = {'label':'发布机关','value':'软件测试材料','source_id':metadata['id'],'evidence_id':evidence_id}
    raw = {'findings':[{'title':'软件测试','details':[detail],'caveats':[]}], 'further_checks':[]}
    captured = {'archives':[metadata], 'queries':['软件测试','软件测试后续更新'], 'evidence_seen':{metadata['id']:[evidence_id]}}
    assert validate_result(ResearchResult(**raw), PROFILES['policy'], tmp_path, captured)['findings']
    for change in ({'source_id':'a'*24}, {'evidence_id':'E999-'+metadata['raw_sha256'][:12]}, {'label':'自动医学审核通过'}):
        with pytest.raises(ValueError):
            validate_result(ResearchResult(**{**raw,'findings':[{'title':'软件测试','details':[{**detail,**change}],'caveats':[]}]}),
                PROFILES['policy'], tmp_path, captured)
    with pytest.raises(ValueError, match='不同查询'):
        validate_result(ResearchResult(**raw), PROFILES['policy'], tmp_path, {**captured,'queries':['软件测试']})
    with pytest.raises(ValueError, match='政府'):
        validate_result(ResearchResult(**raw), PROFILES['policy'], tmp_path,
            {**captured,'archives':[{**metadata,'resolved_url':'https://news.example.com/article'}]})


async def test_source_links_allow_original_attachments_but_not_private_targets(tmp_path, monkeypatch):
    raw = page().replace(b'</body>', '<a href="/attachment.pdf">政策附件</a><a href="http://127.0.0.1/private">内部</a></body>'.encode())
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(raw, URL, {'content-type':'text/html'})))
    metadata, _ = await archive.archive_source(tmp_path, URL)
    assert metadata['links'] == [{'url':'https://www.example.gov.cn/attachment.pdf','title':'政策附件'}]


async def test_actual_stdio_mcp_exposes_only_bounded_tools_and_blocks_private_url(tmp_path):
    settings = Settings(deepseek_api_key='', deepseek_search_enabled=False, records=tmp_path)
    client = research_mcp(settings, tmp_path/'sources', tmp_path/'job')
    try:
        async with asyncio.timeout(15):
            await client.connect()
            assert {tool.name for tool in await client.list_tools()} == {
                'mcp__medvisit_research__search_public', 'mcp__medvisit_research__archive_source', 'mcp__medvisit_research__read_archive'}
            response = await (await client.get_tool('archive_source')).call(url='http://127.0.0.1/private')
            assert 'error' in str(response.content)
            assert not (tmp_path/'sources').exists()
    finally:
        await client.close()


def test_research_query_requires_public_topic_and_forbids_extra_fields():
    from pydantic import ValidationError
    for body in ({'kind':'policy','query':' x '}, {'kind':'shell','query':'医药代表'}, {'kind':'policy','query':'医药代表','command':'ls'}):
        with pytest.raises(ValidationError):
            ResearchRequest(**body)
