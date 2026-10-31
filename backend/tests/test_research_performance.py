import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from medvisit.research import agents, archive, mcp_server
from medvisit.research.models import ResearchResult
from medvisit.research.service import ResearchService
from test_bridge import settings
from test_research_archive import TEXT, URL, page


async def test_archive_lookup_casefolds_each_block_once_and_preserves_rank_order(tmp_path, monkeypatch):
    calls = []
    class CountedText(str):
        def casefold(self):
            calls.append(self)
            return super().casefold()

    texts = ['Straße α beta Gamma DELTA epsilon ZETA eta', 'Gamma delta', 'plain'] * 100
    blocks = [{'id':f'E{i+1}-'+('a'*12), 'text':CountedText(text)} for i, text in enumerate(texts)]
    metadata = {'id':'b'*24, 'raw_sha256':'a'*64, 'title':'test', 'retrieved_at':'now'}
    monkeypatch.setattr(mcp_server, 'AsyncOpenAI', lambda **kwargs: SimpleNamespace())
    monkeypatch.setattr(mcp_server, 'save_source', AsyncMock(return_value=(metadata, 'unused')))
    monkeypatch.setattr(mcp_server, 'read_source', lambda *args: (metadata, 'unused'))
    monkeypatch.setattr(mcp_server, 'evidence_blocks', lambda *args: blocks)
    server = mcp_server.build_server(settings(tmp_path), tmp_path/'sources', tmp_path/'job', seeds=[URL])
    await server.call_tool('archive_source', {'url':URL})
    query = 'STRASSE α beta gamma delta epsilon zeta eta'
    response = await server.call_tool('read_archive', {'source_id':metadata['id'], 'query':query})
    evidence = json.loads(response.content[0].text)['evidence']
    assert len(calls) == len(blocks)
    expected = sorted(blocks, key=lambda block:sum(term in str(block['text']).casefold()
        for term in query.casefold().split()), reverse=True)[:8]
    assert evidence == expected
    calls.clear()
    read = Mock(side_effect=AssertionError('Empty queries must not read the archive'))
    monkeypatch.setattr(mcp_server, 'read_source', read)
    for empty in ('', ' \t\n', '\u3000'):
        response = await server.call_tool('read_archive', {'source_id':metadata['id'], 'query':empty})
        assert 'error' in json.loads(response.content[0].text)
    read.assert_not_called()
    assert calls == []


async def test_validation_reads_each_archived_version_once_without_relaxing_source_checks(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    metadata, text = await archive.archive_source(tmp_path, URL)
    block = archive.evidence_blocks(text, metadata['raw_sha256'])[0]
    result = ResearchResult(findings=[{'title':'测试', 'details':[{'label':'通用名', 'value':'测试材料',
        'source_id':metadata['id'], 'evidence_id':block['id']}], 'caveats':[]}], further_checks=[])
    captured = {'archives':[dict(metadata) for _ in range(8)], 'queries':['查询原文', '查询更新'],
        'evidence_seen':{metadata['id']:[block['id']]}}
    read = Mock(wraps=archive.read_source)
    split = Mock(wraps=archive.evidence_blocks)
    monkeypatch.setattr(agents, 'read_source', read)
    monkeypatch.setattr(agents, 'evidence_blocks', split)
    output = agents.validate_result(result, agents.PROFILES['drug'], tmp_path, captured)
    assert read.call_count == split.call_count == 1
    assert TEXT in output['findings'][0]['details'][0]['quote']
    captured['archives'][-1]['resolved_url'] = 'https://news.example.com/article'
    with pytest.raises(ValueError, match='政府'):
        agents.validate_result(result, agents.PROFILES['drug'], tmp_path, captured)
    captured['archives'][-1]['resolved_url'] = URL
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(TEXT+' 修订正文。'), URL, {'content-type':'text/html'})))
    newer, _ = await archive.archive_source(tmp_path, URL)
    captured['archives'].append(newer)
    read.reset_mock(); split.reset_mock()
    assert agents.validate_result(result, agents.PROFILES['drug'], tmp_path, captured) == output
    assert read.call_count == split.call_count == 2
    (tmp_path/newer['id']/newer['raw_sha256']/'content.txt').write_text('damaged uncited version')
    with pytest.raises(ValueError, match='损坏'):
        agents.validate_result(result, agents.PROFILES['drug'], tmp_path, captured)
    (tmp_path/metadata['id']/metadata['raw_sha256']/'content.txt').write_text('damaged')
    with pytest.raises(ValueError, match='损坏'):
        agents.validate_result(result, agents.PROFILES['drug'], tmp_path, captured)


def test_checkpoint_does_not_serialize_discarded_quotes_or_modify_result(tmp_path):
    service = ResearchService(None, settings(tmp_path), lambda: {'workspace':'test'})
    result = {'findings':[{'title':'测试', 'details':[{'label':'通用名', 'value':'测试材料',
        'source_id':'a'*24, 'evidence_id':'E1-'+('b'*12), 'quote':TEXT*12, 'source_version':'b'*64}],
        'caveats':['待核对']}], 'further_checks':['后续更新']}
    original = copy.deepcopy(result)
    serialized = []
    dumps = json.dumps
    def capture(value, *args, **kwargs):
        serialized.append(copy.deepcopy(value))
        return dumps(value, *args, **kwargs)
    with patch('medvisit.research.service.json.dumps', side_effect=capture):
        service._save_result({'id':'test-job'}, result, {'total_tokens':10})
    assert len(serialized) == 1
    assert result == original
    saved = json.loads((service.base/'jobs/test-job/result.json').read_text())
    assert saved == serialized[0]
    assert saved['usage']['total_tokens'] == 10
    assert saved['result']['findings'][0]['details'][0] == {
        key:value for key, value in original['findings'][0]['details'][0].items()
        if key not in ('quote','source_version')}
