import asyncio
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from unittest.mock import AsyncMock
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from medvisit.api.app import create_app
from medvisit.knowledge.corpus import MedicalCorpus, sentences
from medvisit.knowledge.compile import validate_facts
from medvisit.knowledge.live import LiveMedicalChecks
from medvisit.knowledge.verify import MedicalVerifier, validate_result, apply_review
from medvisit.storage.records import SessionRecord
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
    return MedicalCorpus(root)


def model_result(evidence):
    return {'statements':[{'id':'s0','status':'contradicted','reason':'Synthetic numeric mismatch',
        'correction':'测试值应为10%。','citations':[{'chunk_id':evidence[0]['id'],'quote':'测试药甲在测试人群中的指标为10%'}]}]}


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
    p.write_text('broken');assert corpus.load()['version']=='unavailable' and not corpus.search('测试药甲')


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
