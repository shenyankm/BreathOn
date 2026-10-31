import asyncio
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from medvisit.api.app import create_app
from medvisit.knowledge.corpus import MedicalCorpus, sentences
from medvisit.knowledge.compile import validate_facts
from medvisit.knowledge.live import LiveMedicalChecks
from medvisit.knowledge.verify import MedicalVerifier, validate_result, apply_review
from medvisit.knowledge.api import medical_router
from medvisit.core.identity import current_role
from medvisit.storage.records import SessionRecord
from medvisit.services.visit_summary import build_visit_summary
from test_bridge import settings


def corpus_fixture(root):
    original=root/'raw/sources/test/original.txt';original.parent.mkdir(parents=True)
    original.write_text('Synthetic evidence for software tests only.')
    data={'format':1,'built_at':'2026-10-30','products':[{'id':'test-drug','name':'测试药甲','brand':'测试品牌',
        'sources':['test-source'],'gaps':[]}], 'sources':[{'id':'test-source','title':'Synthetic trial',
        'kind':'trial','product_ids':['test-drug'],'quality':'original','trials':['TEST-ONE'],
        'url':'https://example.org/trial','sha256':'a'*64,'retrieved_at':'2026-10-30',
        'published_at':'2026','jurisdiction':'Synthetic test population','original_path':'raw/sources/test/original.txt',
        'pages':[{'number':1,'text':'软件测试专用：测试药甲在测试人群中的指标为10%，此文本不代表任何真实医学结论。'}]}]}
    (root/'corpus.json').write_text(json.dumps(data))
    for name in ['purpose.md','schema.md','wiki/index.md']:
        p=root/name;p.parent.mkdir(exist_ok=True);p.write_text('Synthetic wiki')
    document={'id':'approved-content','title':'Synthetic trial','version':1,'version_label':'test-v1','status':'approved',
              'source_url':data['sources'][0]['url'],'pages':deepcopy(data['sources'][0]['pages'])}
    return MedicalCorpus(root, approved_documents=lambda:[document])


def model_result(evidence):
    return {'statements':[{'id':'s0','status':'contradicted','reason':'Synthetic numeric mismatch',
        'correction':'测试值应为10%。','citations':[{'chunk_id':evidence[0]['id'],'quote':'测试药甲在测试人群中的指标为10%'}]}]}


def test_approval_receipts_hash_each_document_once_and_refresh_on_change(tmp_path):
    import hashlib

    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    pages = [{'number':page, 'text':f'Synthetic software fixture page {page}.'} for page in range(1, 4)]
    document['pages'] = deepcopy(pages)
    data = corpus.load()
    data['sources'][0]['pages'] = deepcopy(pages)
    expected = {'document_id':document['id'], 'document_version':1, 'version_label':'test-v1',
        'document_sha256':hashlib.sha256(json.dumps(pages, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
    with patch('medvisit.knowledge.corpus.hashlib.sha256', wraps=hashlib.sha256) as digest:
        before = corpus.approval_snapshot(data)
        assert digest.call_count == 1
    assert before == {(source, page):expected for source in ('test-source', 'platform-document-approved-content') for page in range(1, 4)}
    document.update(version=2, version_label='test-v2')
    document['pages'][0]['text'] = 'Changed synthetic fixture.'
    after = corpus.approval_snapshot(data)
    assert ('test-source', 1) not in after and ('test-source', 2) in after
    receipt = after[('test-source', 2)]
    assert receipt['document_version'] == 2 and receipt['version_label'] == 'test-v2'
    assert receipt['document_sha256'] != expected['document_sha256']
    assert all(value == expected for value in before.values())
    document['status'] = 'retired'
    assert corpus.approval_snapshot(data) == {}


def test_quotes_are_bound_to_actual_retrieved_chunks_and_ocr_is_not_authoritative(tmp_path):
    corpus=corpus_fixture(tmp_path)
    evidence=corpus.search('测试药甲的指标是99%。')
    assert evidence
    raw=model_result(evidence)
    checked=validate_result(raw,'测试药甲的指标是99%。',evidence)
    assert checked[0]['status']=='contradicted' and checked[0]['citations'][0]['sha256']=='a'*64
    for bad in ('unknown_id','invented_quote'):
        invalid=deepcopy(raw)
        invalid['statements'][0]['citations'][0].update(
            {'chunk_id':'missing'} if bad=='unknown_id' else {'quote':'这是模型自己编造的原文，不能作为纠错依据。'})
        result=validate_result(invalid,'测试药甲的指标是99%。',evidence)[0]
        assert result['status']=='insufficient' and result['correction']==''
    evidence[0]['source']['quality']='ocr'
    assert validate_result(raw,'测试药甲的指标是99%。',evidence)[0]['status']=='insufficient'


def test_sentence_coverage_and_compiled_fact_receipts_cannot_be_invented(tmp_path):
    corpus=corpus_fixture(tmp_path);evidence=corpus.search('测试药甲99%。')
    assert sentences('第一句。第二句！第三句；')==['第一句。','第二句！','第三句；']
    with pytest.raises(ValueError): validate_result(model_result(evidence),'测试药甲99%。另一句。',evidence)
    facts,gaps=validate_facts({'facts':[{'claim':'Invented','source_id':'missing','page':1,'quote':'虚构引用不能通过原文校验。'}]},corpus.load()['sources'])
    assert not facts and gaps


def test_independent_review_fails_closed_on_missing_duplicate_and_inapplicable_decisions(tmp_path):
    corpus=corpus_fixture(tmp_path);evidence=corpus.search('测试药甲99%。')
    checks=validate_result(model_result(evidence),'测试药甲99%。',evidence)
    for raw in ({},{'judgments':[{'id':'s0','admissible':False}]},
                {'judgments':[{'id':'s0','admissible':True},{'id':'s0','admissible':True}]}):
        result=apply_review(deepcopy(checks),raw)
        assert result[0]['status']=='insufficient' and result[0]['correction']==''
    assert apply_review(deepcopy(checks),{'judgments':[{'id':'s0','admissible':True}]})[0]['status']=='contradicted'


def test_bundled_wiki_works_without_raw_pdfs_but_never_masks_a_broken_runtime_override(tmp_path):
    seed=tmp_path/'seed';corpus_fixture(seed)
    corpus=MedicalCorpus(tmp_path/'runtime',seed=seed)
    assert corpus.status()['sources'] and not corpus.status()['sources'][0]['original_available']
    override=tmp_path/'runtime/corpus.json';override.parent.mkdir();override.write_text('corrupt')
    assert corpus.load()['version']=='unavailable'


def test_corpus_replacement_and_corruption_never_keep_old_evidence(tmp_path):
    corpus=corpus_fixture(tmp_path);first=corpus.load()['version']
    p=tmp_path/'corpus.json';data=json.loads(p.read_text());data['sources'][0]['pages'][0]['text']='新版资料明确不同。'
    p.write_text(json.dumps(data));assert corpus.load()['version']!=first
    p.write_text('broken');assert corpus.load()['version']=='unavailable'
    assert all(row['source_id'].startswith('platform-document-') for row in corpus.search('测试药甲'))


def test_historical_citations_are_pinned_and_do_not_silently_open_a_new_version(tmp_path):
    corpus=corpus_fixture(tmp_path)
    old=deepcopy(corpus.load()['sources'][0])
    p=tmp_path/'corpus.json';data=json.loads(p.read_text())
    data['sources'][0]['sha256']='b'*64;data['sources'][0]['pages'][0]['text']='新版不同文字。'
    p.write_text(json.dumps(data))
    assert corpus.source('test-source','a'*64) is None
    history=tmp_path/'versions/test-source'/('a'*64+'.json');history.parent.mkdir(parents=True);history.write_text(json.dumps(old))
    assert corpus.source('test-source','a'*64)['pages'][0]['text']==old['pages'][0]['text']
    assert corpus.source('test-source','b'*64)['pages'][0]['text']=='新版不同文字。'
    assert corpus.source('../test-source','a'*64) is None

def test_historical_source_authorization_matches_the_selected_version(tmp_path):
    corpus = corpus_fixture(tmp_path)
    archived = deepcopy(corpus.load()['sources'][0])
    archived.update(sha256='b'*64, pages=[{'number':1, 'text':'未审核的旧版软件测试资料。'}])
    history = tmp_path/'versions/test-source'/('b'*64+'.json')
    history.parent.mkdir(parents=True)
    history.write_text(json.dumps(archived))
    source = {route.path:route.endpoint for route in medical_router(corpus, object()).routes}['/api/medical/sources/{source_id}']
    token = current_role.set('representative')
    try:
        assert source('test-source', 'a'*64).status_code == 200
        with pytest.raises(HTTPException) as exc:
            source('test-source', 'b'*64)
        assert exc.value.status_code == 404
    finally:
        current_role.reset(token)
    token = current_role.set('admin')
    try:
        assert archived['pages'][0]['text'].encode() in source('test-source', 'b'*64).body
    finally:
        current_role.reset(token)


def test_lint_detects_modified_originals_and_title_only_citations_are_not_proof(tmp_path):
    import hashlib
    corpus=corpus_fixture(tmp_path)
    p=tmp_path/'corpus.json';data=json.loads(p.read_text())
    original=tmp_path/data['sources'][0]['original_path']
    data['sources'][0]['sha256']=hashlib.sha256(original.read_bytes()).hexdigest();p.write_text(json.dumps(data))
    assert corpus.audit()['ok']
    original.write_text('Changed original');assert not corpus.audit()['ok']
    evidence=corpus.search('测试药甲99%。');raw=model_result(evidence)
    evidence[0]['source']['title']=raw['statements'][0]['citations'][0]['quote']
    assert validate_result(raw,'测试药甲99%。',evidence)[0]['status']=='insufficient'


async def test_empty_corpus_fails_closed_without_model_calls(tmp_path):
    result=await MedicalVerifier(settings(tmp_path),MedicalCorpus(tmp_path)).check('测试药甲适合所有患者。')
    assert result['status']=='insufficient' and result['statements']==[]


async def test_medical_evidence_requires_matching_live_approval_and_revocation_invalidates_result(tmp_path):
    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    query = '测试药甲的指标是99%。'
    evidence = corpus.search(query)
    assert evidence[0]['document_id'] == document['id']
    statement = validate_result(model_result(evidence), query, evidence)[0]
    result = {'text':query, 'status':'contradicted', 'corpus_version':corpus.load()['version'], 'statements':[statement]}
    verifier = MedicalVerifier(settings(tmp_path), corpus)
    await verifier.invalidate_revoked([result])
    assert result['status'] == 'contradicted'
    document['status'] = 'retired'
    assert not corpus.search(query)
    await verifier.invalidate_revoked([result])
    assert result['status'] == 'insufficient' and result['statements'] == []
    document['status'] = 'approved'
    document['pages'][0]['text'] += '不一致'
    assert all(row['source_id'] != 'test-source' for row in corpus.search(query))
    document['pages'][0]['text'] = evidence[0]['text']
    document['source_url'] = 'https://example.org/other'
    assert all(row['source_id'] != 'test-source' for row in corpus.search(query))
    corpus.approved_documents = None
    assert not corpus.search(query)


async def test_uploaded_approved_platform_content_is_searchable_without_corpus(tmp_path):
    document={'id':'new-doc','version':1,'version_label':'v1','title':'测试说明书', 'status':'approved',
        'source_url':'','scope':'测试人群', 'pages':[{'number':1,'text':'测试药乙在测试人群中的数值是10%，仅用于软件测试。'}]}
    corpus=MedicalCorpus(tmp_path/'empty', approved_documents=lambda:[document])
    evidence=corpus.search('测试药乙在测试人群的数值是多少？')
    assert evidence and evidence[0]['source_id']=='platform-document-new-doc'
    assert corpus.source('platform-document-new-doc')['pages'] == document['pages']
    document['status']='retired'
    assert not corpus.search('测试药乙在测试人群的数值是多少？')
    assert corpus.source('platform-document-new-doc') is None


def test_representative_cannot_read_unreviewed_corpus_or_export(tmp_path):
    corpus = corpus_fixture(tmp_path)
    document = corpus.approved_documents()[0]
    router = medical_router(corpus, object())
    routes = {r.path:r.endpoint for r in router.routes}
    token = current_role.set('representative')
    try:
        assert len(routes['/api/medical']()['sources']) == 2
        with pytest.raises(Exception) as exc:
            routes['/api/medical/sources/{source_id}/original']('test-source')
        assert exc.value.status_code == 404
        document['status'] = 'retired'
        assert routes['/api/medical']()['sources'] == []
        for path in ('/api/medical/sources/{source_id}', '/api/medical/sources/{source_id}/original'):
            with pytest.raises(Exception) as exc:
                routes[path]('test-source')
            assert exc.value.status_code == 404
        with pytest.raises(Exception) as exc:
            routes['/api/medical/wiki.zip']()
        assert exc.value.status_code == 403
        with pytest.raises(Exception) as exc:
            routes['/api/medical/audit']()
        assert exc.value.status_code == 403
    finally:
        current_role.reset(token)


async def test_summary_does_not_score_unverifiable_saved_medical_result(tmp_path):
    record = SessionRecord('test', 'assisted')
    record.transcript('u1', 'trainee', '测试药甲指标为99%。', final=True)
    record.data['capture_status'] = 'completed'
    record.data['medical_checks'] = [{'message_id':'u1', 'text':'测试药甲指标为99%。', 'status':'supported',
                                      'statements':[{'status':'supported'}]}]
    config = settings(tmp_path)
    config.deepseek_api_key = ''
    summary = await build_visit_summary(config, record)
    assert summary['dimensions'][0]['score'] is None and summary['total'] is None


async def test_live_checks_cover_each_final_segment_and_drop_corrected_inflight_results():
    entered,release=asyncio.Event(),asyncio.Event()
    async def verify(text,context):
        if text=='旧转录。': entered.set();await release.wait()
        return {'text':text,'status':'contradicted','statements':[]}
    client=type('Client',(),{'send_json':AsyncMock()})()
    record=SessionRecord('test','independent');record.data['experience']='combat'
    verifier=type('Verifier',(),{'check':AsyncMock(side_effect=verify)})()
    checks=LiveMedicalChecks(client,record,verifier)
    checks.observe('u1','旧转录。',True);await asyncio.wait_for(entered.wait(),2)
    checks.observe('u1','修正转录。',True);checks.observe('u2','第二句。',False)
    checks.observe('u2','第二句。',True);release.set()
    await checks.finish()
    assert [row['text'] for row in record.data['medical_checks']]==['修正转录。','第二句。']
    published=[call.args[0]['check'] for call in client.send_json.call_args_list]
    assert not any(row['text']=='旧转录。' and row['status']=='contradicted' for row in published)
    assert len(verifier.check.call_args_list)==3
    assert checks.worker.done()


def test_shared_sources_export_excludes_private_chats_and_reader_escapes_html(tmp_path):
    app=create_app(settings(tmp_path))
    root=app.state.medical_corpus.root
    corpus_fixture(root)
    private=root/'.llm-wiki/chats/private.json';private.parent.mkdir(parents=True);private.write_text('private')
    with TestClient(app) as client:
        result=client.get('/api/medical');assert result.status_code==200 and result.json()['sources']
        response=client.get('/api/medical/wiki.zip');assert response.status_code==200
        with ZipFile(BytesIO(response.content)) as archive:
            assert 'wiki/index.md' in archive.namelist()
            assert all('private' not in name and '.llm-wiki' not in name for name in archive.namelist())
        assert client.get('/api/medical/sources/test-source').status_code==200
        assert client.get('/api/medical/sources/missing/original').status_code==404
        assert client.post('/api/medical/check',json={'text':' '},headers={'Origin':app.state.local_user.get('origin','http://127.0.0.1:5173')}).status_code==422


def test_coaching_reference_requires_live_approval_and_keeps_competitor_identity(tmp_path):
    corpus=corpus_fixture(tmp_path)
    data=json.loads((tmp_path/'corpus.json').read_text())
    peer={**deepcopy(data['products'][0]),'id':'peer','name':'测试竞品','brand':'竞品品牌',
          'ownership':'competitor','compares_with':['test-drug'],'sources':['peer-source']}
    source={**deepcopy(data['sources'][0]),'id':'peer-source','product_ids':['peer'],
            'url':'https://example.org/peer','jurisdiction':'US'}
    data['products'].append(peer);data['sources'].append(source)
    (tmp_path/'corpus.json').write_text(json.dumps(data))
    document=corpus.approved_documents()[0]
    documents=[document]
    corpus.approved_documents=lambda:documents
    first=corpus.coaching_context({'name':'测试药甲'},'指标是多少？')
    assert first['evidence'] and all(r['source_id']=='test-source' for r in first['evidence'])
    assert first['gaps'][0]['product']=='测试竞品'
    documents.append({**deepcopy(document),'id':'peer-approval','source_url':source['url']})
    second=corpus.coaching_context({'name':'测试药甲'},'指标是多少？')
    assert any(r['source_id']=='peer-source' and r['source']['jurisdiction']=='US' for r in second['evidence'])
    assert len(second['evidence'])<=8 and corpus.validate_coaching_context(second)
    documents[1]['status']='retired'
    assert not corpus.validate_coaching_context(second)
    documents[0]['status']='retired'
    assert corpus.coaching_context({'name':'测试药甲'},'指标是多少？')['evidence']==[]


def test_wiki_render_preserves_log_and_detects_broken_navigation(tmp_path):
    from medvisit.knowledge.wiki import render_wiki,lint_wiki
    corpus=corpus_fixture(tmp_path);data=corpus.load()
    render_wiki(tmp_path,data,'ingest')
    original=(tmp_path/'wiki/log.md').read_text()
    render_wiki(tmp_path,data,'lint')
    assert (tmp_path/'wiki/log.md').read_text().startswith(original)
    assert lint_wiki(tmp_path)==[]
    assert '[[entities/test-drug|' in (tmp_path/'wiki/sources/test-source.md').read_text()
    (tmp_path/'wiki/entities/test-drug.md').write_text('[[sources/missing]]')
    assert any('断链' in error for error in lint_wiki(tmp_path))


async def test_reference_revocation_during_model_request_blocks_publication(tmp_path):
    from types import SimpleNamespace
    from medvisit.knowledge.live import coaching_snapshot,validate_coaching_snapshot
    from medvisit.voice.protocol import BridgeError
    corpus=corpus_fixture(tmp_path);document=corpus.approved_documents()[0]
    corpus.approved_documents=lambda:[document]
    record=SessionRecord('ref-test','assisted')
    record.data['free_context']={'drug':{'name':'测试药甲'}}
    record.transcript('t1','trainee','测试药甲的指标是多少？',final=True)
    record.medical_checks=SimpleNamespace(verifier=SimpleNamespace(corpus=corpus))
    snapshot=await coaching_snapshot(record)
    assert snapshot['evidence']
    document['status']='retired'
    with pytest.raises(BridgeError): await validate_coaching_snapshot(record,snapshot)


def test_coach_prioritizes_mentioned_and_domestic_competitors(tmp_path, monkeypatch):
    corpus=corpus_fixture(tmp_path)
    data=json.loads((tmp_path/'corpus.json').read_text())
    for pid,region in [('foreign','US'),('domestic1','CN'),('domestic2','CN'),('mentioned','CN')]:
        data['products'].append({'id':pid,'name':pid,'brand':pid,'jurisdiction':region,
                                 'compares_with':['test-drug'],'sources':[]})
    (tmp_path/'corpus.json').write_text(json.dumps(data))
    monkeypatch.setattr(corpus,'search',lambda *args,**kwargs:[])
    context=corpus.coaching_context({'name':'测试药甲'},'请比较 mentioned')
    assert [g['product'] for g in context['gaps']]==['测试药甲','mentioned','domestic1','domestic2']
