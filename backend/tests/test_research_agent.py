import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from medvisit.research import archive
from medvisit.research.agents import (EvidenceNotReturned, FieldNotAllowed, NoArchivedSource, ResearchValidationError,
    SourceHostNotAllowed, TooFewSearches, failure_kind, run_agent)
from medvisit.research.archive import write_private
from test_bridge import settings
from test_research_archive import URL, TEXT, page


@pytest.mark.parametrize('repair_valid', [True, False])
async def test_bounded_agent_repair_keeps_failed_output_and_never_relaxes_citations(tmp_path, monkeypatch, repair_valid):
    root, job_dir = tmp_path/'sources', tmp_path/'job'
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(), URL, {'content-type':'text/html'})))
    metadata, _ = await archive.archive_source(root, URL)
    evidence_id = archive.evidence_blocks(archive.read_source(root,metadata['id'],metadata['raw_sha256'])[1],metadata['raw_sha256'])[0]['id']
    write_private(job_dir/'observations.json', json.dumps({'archives':[metadata],
        'queries':['公开原文软件测试','后续更新软件测试'], 'search_results':[], 'errors':[],
        'evidence_seen':{metadata['id']:[evidence_id]}}).encode())
    good = {'findings':[{'title':'软件测试','details':[{'label':'通用名','value':'测试发布机关',
        'source_id':metadata['id'],'evidence_id':evidence_id}],'caveats':[]}], 'further_checks':[]}
    bad = json.loads(json.dumps(good))
    bad['findings'][0]['details'][0]['evidence_id'] = 'E999-'+metadata['raw_sha256'][:12]
    def reply(value):
        return SimpleNamespace(get_text_content=lambda:json.dumps(value), usage=SimpleNamespace(input_tokens=3,output_tokens=2))
    agent = SimpleNamespace(reply=AsyncMock(side_effect=[reply(bad), reply(good if repair_valid else bad)]))
    mcp = SimpleNamespace(connect=AsyncMock(), close=AsyncMock(), get_tool=AsyncMock())
    model = SimpleNamespace(client=SimpleNamespace(close=AsyncMock()))
    with patch('medvisit.research.agents.research_mcp', return_value=mcp), \
         patch('medvisit.research.agents.CoachModel', return_value=model), \
         patch('medvisit.research.agents.Toolkit', return_value=None), \
         patch('medvisit.research.agents.Agent', return_value=agent):
        if repair_valid:
            result, usage = await run_agent(settings(tmp_path), 'drug', '公开政策软件测试', root, job_dir)
            detail = result['findings'][0]['details'][0]
            assert TEXT in detail['quote'] and detail['source_version'] == metadata['raw_sha256'] and usage['total_tokens'] == 10
        else:
            with pytest.raises(EvidenceNotReturned, match='引文'):
                await run_agent(settings(tmp_path), 'drug', '公开政策软件测试', root, job_dir)
    assert agent.reply.await_count == 2
    assert json.loads((job_dir/'raw-result-1.json').read_text()) == bad
    assert (job_dir/'validation-error.txt').exists() and (job_dir/'raw-result-2.json').exists()
    assert (job_dir/'validation-kind.txt').read_text() == 'evidence_not_returned'
    mcp.close.assert_awaited_once()
    model.client.close.assert_awaited_once()


async def test_model_client_closes_when_mcp_cleanup_fails(tmp_path):
    mcp = SimpleNamespace(connect=AsyncMock(side_effect=ValueError('connect failed')),
        close=AsyncMock(side_effect=RuntimeError('cleanup failed')))
    model = SimpleNamespace(client=SimpleNamespace(close=AsyncMock()))
    with patch('medvisit.research.agents.research_mcp', return_value=mcp), \
         patch('medvisit.research.agents.CoachModel', return_value=model):
        with pytest.raises(RuntimeError, match='cleanup failed'):
            await run_agent(settings(tmp_path), 'drug', '公开政策软件测试', tmp_path/'sources', tmp_path/'job')
    mcp.close.assert_awaited_once()
    model.client.close.assert_awaited_once()


@pytest.mark.parametrize('error,kind', [
    (FieldNotAllowed('x'), 'field_not_allowed'), (EvidenceNotReturned('x'), 'evidence_not_returned'),
    (SourceHostNotAllowed('x'), 'source_host_not_allowed'), (NoArchivedSource('x'), 'no_archived_source'),
    (TooFewSearches('x'), 'too_few_searches'),
    (TimeoutError(), 'timeout'), (ValueError('bad json'), 'invalid_output'), (RuntimeError('mcp down'), 'service_error'),
])
def test_failures_are_classified_by_cause_so_model_faults_and_source_faults_are_counted_apart(error, kind):
    assert failure_kind(error) == kind


def test_classified_validation_errors_are_still_value_errors_for_existing_handlers():
    assert all(issubclass(cls, ValueError) and issubclass(cls, ResearchValidationError)
               for cls in (FieldNotAllowed, EvidenceNotReturned, SourceHostNotAllowed, NoArchivedSource, TooFewSearches))
