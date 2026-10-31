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


def test_nothing_archived_is_reported_as_such_even_when_the_model_cited_evidence():
    from medvisit.research.agents import PROFILES, validate_result
    from medvisit.research.models import ResearchResult
    result = ResearchResult.model_validate({'findings': [{'title': 't', 'details': [{'label': '通用名', 'value': 'v',
        'source_id': 'a'*24, 'evidence_id': 'E1-'+'b'*12}], 'caveats': []}], 'further_checks': []})
    with pytest.raises(NoArchivedSource):
        validate_result(result, PROFILES['drug'], None, {'archives': [], 'queries': ['a', 'b']})


async def test_research_jobs_beyond_the_concurrency_limit_wait_instead_of_running(tmp_path):
    import asyncio
    from medvisit.research.service import ResearchService
    running, peak = 0, 0
    async def fake_run(*args, **kwargs):
        nonlocal running, peak
        running += 1; peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1
        raise ValueError('stop after measuring')
    config = settings(tmp_path, research_max_concurrency=2)
    service = ResearchService.__new__(ResearchService)
    service.settings, service._slots, service._closing = config, asyncio.Semaphore(config.research_max_concurrency), False
    async def hold():
        async with service._slots:
            await fake_run()
    await asyncio.gather(*[hold() for _ in range(6)], return_exceptions=True)
    assert peak == 2
