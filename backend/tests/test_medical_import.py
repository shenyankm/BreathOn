"""Offline receipt/version regression for the public-label importer."""
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


async def test_competitor_reimport_retains_versions_and_failure_preserves_corpus(tmp_path,monkeypatch):
    tools=Path(__file__).resolve().parents[1]/'tools'
    monkeypatch.syspath_prepend(str(tools))
    spec=importlib.util.spec_from_file_location('competitor_import',tools/'ingest_competitors.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    manifest=tmp_path/'manifest.json'
    manifest.write_text(json.dumps([{'id':'peer','name':'Test peer','brand':'PEER','url':'https://example.org/peer',
        'compares_with':['base'],'relationship':'Synthetic test relation','jurisdiction':'US'}]))
    monkeypatch.setattr(module,'MANIFEST',manifest)
    corpus=tmp_path/'corpus.json'
    corpus.write_text(json.dumps({'format':1,'products':[{'id':'base','name':'Base','brand':'Base','sources':[]}],
                                 'sources':[],'compiled':{'base':{'facts':[],'gaps':[]}}}))
    download=AsyncMock(return_value=(b'%PDF-test-v1','https://example.org/peer',{}))
    monkeypatch.setattr(module,'download_public',download)
    monkeypatch.setattr(module,'parse_pdf',lambda raw:[{'number':1,'text':'PEER Revised: 05/2026 Synthetic text.'}])
    await module.ingest(tmp_path)
    first=json.loads(corpus.read_text())
    assert len(first['products'])==2 and first['sources'][0]['review_status']=='pending'
    await module.ingest(tmp_path)
    second=json.loads(corpus.read_text())
    assert second['sources']==first['sources'] and len(second['products'])==2
    download.return_value=(b'%PDF-test-v2','https://example.org/peer',{})
    await module.ingest(tmp_path)
    assert len(list((tmp_path/'versions/label-peer').glob('*.json')))==2
    assert len(list((tmp_path/'raw/sources/label-peer').glob('*.pdf')))==2
    before=corpus.read_bytes()
    download.side_effect=OSError('synthetic offline')
    with pytest.raises(OSError): await module.ingest(tmp_path)
    assert corpus.read_bytes()==before


async def test_demo_import_checks_identity_preserves_original_and_lints(tmp_path, monkeypatch):
    tools=Path(__file__).resolve().parents[1]/'tools'
    monkeypatch.syspath_prepend(str(tools))
    spec=importlib.util.spec_from_file_location('demo_import',tools/'ingest_demo.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    manifest=tmp_path/'manifest.json'
    manifest.write_text(json.dumps({'id':'demo','title':'Demo','scope':'CN','checked_at':'2026-10-31',
        'products':[], 'sources':[{'id':'source','title':'Test','url':'https://example.org/doc',
        'kind':'label','quality':'original','product_ids':['mazdutide'],'required_terms':['identity']}]}))
    monkeypatch.setattr(module,'MANIFEST',manifest)
    (tmp_path/'corpus.json').write_text(json.dumps({'products':[{'id':'mazdutide','name':'Test','brand':'Test','sources':[]}], 'sources':[]}))
    download=AsyncMock(return_value=(b'%PDF-v1','https://example.org/doc',{}))
    monkeypatch.setattr(module,'download_public',download)
    monkeypatch.setattr(module,'parse_pdf',lambda raw:[{'number':1,'text':'identity '+ 'synthetic body '*20}])
    first=await module.ingest(tmp_path)
    assert first['sources'][0]['review_status']=='pending'
    from medvisit.knowledge.wiki import lint_wiki
    assert not lint_wiki(tmp_path)
    await module.ingest(tmp_path)
    assert download.await_count==1
    download.return_value=(b'%PDF-unrelated','https://example.org/doc',{})
    monkeypatch.setattr(module,'parse_pdf',lambda raw:[{'number':1,'text':'unrelated '*30}])
    failed=await module.ingest(tmp_path,refresh=True)
    assert failed['sources']==first['sources']
    assert failed['demo_pack']['failures'][0]['previous_retained']
