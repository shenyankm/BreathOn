import asyncio
from unittest.mock import AsyncMock

from medvisit.research import archive
from medvisit.research.models import ResearchRequest
from test_platform import client
from test_research_archive import URL, page
from test_storage import database_url


def test_doctor_draft_requires_identity_and_preserves_verified_evidence(client, monkeypatch):
    service = client.app.state.research
    service.settings.deepseek_search_enabled = True
    text = '张三医生在某医院内分泌科从事临床研究，致力于改善相关疾病的临床诊疗与学术交流。' * 2
    monkeypatch.setattr(archive, 'download_public', AsyncMock(return_value=(page(text), URL, {'content-type':'text/html'})))
    metadata, _ = asyncio.run(archive.archive_source(service.archives, URL))
    _, source_text = archive.read_source(service.archives, metadata['id'], metadata['raw_sha256'])
    evidence_id = archive.evidence_blocks(source_text, metadata['raw_sha256'])[0]['id']
    captured = {'queries':['张三 某医院', '张三 内分泌科'], 'search_results':[], 'archives':[metadata],
                'errors':[], 'evidence_seen':{metadata['id']:[evidence_id]}}
    monkeypatch.setattr(service, '_observations', lambda _: captured)
    details = [{'label':label, 'value':value, 'source_id':metadata['id'], 'evidence_id':evidence_id}
               for label,value in [('姓名','张三'), ('医院','某医院'), ('科室','内分泌科')]]
    result = {'findings':[{'title':'张三','details':details,'caveats':['身份待核对']}], 'further_checks':[]}
    job = service._create_job(ResearchRequest(kind='doctor', query='张三 某医院'))
    service._finish(job, result, {}, '', False, captured)
    endpoint = f'/api/research/jobs/{job["id"]}/doctor-draft'
    assert client.post(endpoint, json={'finding_index':0,'confirmed_identity':False,'confirmed_name':'张三'}).status_code == 422
    assert client.post(endpoint, json={'finding_index':0,'confirmed_identity':True,'confirmed_name':'李四'}).status_code == 422
    response = client.post(endpoint, json={'finding_index':0,'confirmed_identity':True,'confirmed_name':'张三'})
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft['status'] == 'draft' and draft['name'] == '张三'
    assert draft['research_evidence'][0]['source_version'] == metadata['raw_sha256']
    assert draft['research_evidence'][0]['quote'] in source_text
    assert client.post(endpoint, json={'finding_index':0,'confirmed_identity':True,'confirmed_name':'张三'}).json()['id'] == draft['id']
    (service.archives/metadata['id']/metadata['raw_sha256']/'content.txt').write_text('corrupted')
    assert client.post(endpoint, json={'finding_index':0,'confirmed_identity':True,'confirmed_name':'张三'}).status_code == 409
