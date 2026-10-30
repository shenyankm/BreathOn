from test_operations import platform
from test_storage import database_url
from medvisit.platform.importer import Batch, Entry, import_content


def test_batch_import_atomic_draft_version_and_idempotency(platform):
    client,service,_,_=platform
    doc={'title':'功能验收资料','version_label':'v1','scope':'仅用于验收','pages':[{'number':3,'text':'合成资料，不构成医学证据。'}]}
    body={'documents':[doc,{**doc,'title':'第二份','previous_id':'absent'}]}
    before=len(client.get('/api/catalog/content').json())
    assert client.post('/api/content/import',json=body).status_code==404
    assert len(client.get('/api/catalog/content').json())==before
    body={'documents':[doc]};result=client.post('/api/content/import',json=body)
    assert result.status_code==201,result.text
    receipt=result.json();assert not receipt['reused']
    assert client.post('/api/content/import',json=body).json()['document_ids']==receipt['document_ids']
    assert client.get('/api/catalog/content/'+receipt['document_ids'][0]).json()['status']=='draft'
    version=client.post('/api/content/import',json={'documents':[{**doc,'version_label':'v2','previous_id':receipt['document_ids'][0]}]}).json()
    assert client.get('/api/catalog/content/'+version['document_ids'][0]).json()['series_id']==receipt['document_ids'][0]


def test_batch_import_reuses_serialized_documents_without_mutating_input(platform, monkeypatch):
    client, _, _, _ = platform
    body = Batch(documents=[{'title':f'批量资料 {index}', 'version_label':'v1', 'scope':'性能回归',
        'pages':[{'number':1, 'text':'仅用于测试，不构成医学证据。'}]} for index in range(50)])
    original = body.model_dump(mode='json')
    dump = Entry.model_dump
    calls = []

    def count_dump(entry, *args, **kwargs):
        calls.append(entry.title)
        return dump(entry, *args, **kwargs)

    monkeypatch.setattr(Entry, 'model_dump', count_dump)
    store, user = client.app.state.platform, client.app.state.local_user
    receipt = import_content(store, user, body)
    assert calls == []
    assert body.model_dump(mode='json') == original
    assert len(receipt['document_ids']) == 50
    assert import_content(store, user, body) == {**receipt, 'reused':True}
    with store.transaction(user['workspace'], write=False) as tx:
        for item_id, source in zip(receipt['document_ids'], original['documents']):
            item = tx.get(user['workspace'], 'content', item_id)
            assert item['title'] == source['title'] and item['pages'] == source['pages']
            assert item['status'] == 'draft' and item['series_id'] == item_id

