import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import clear_test_database
from medvisit.api.app import create_app
from medvisit.platform.catalog import Catalog
from medvisit.platform.store import PlatformStore, Conflict
from medvisit.storage.records import SessionRecord
from test_bridge import ORIGIN, settings
from test_storage import database_url

DOC = {'title': '研究训练材料', 'version_label': '2026.1', 'scope': '仅供成人学术沟通训练',
       'source_url': 'https://example.org/study', 'pages': [{'number': 2, 'text': '合成教学材料，不是医学结论。'}]}
DOCTOR = {'name': '合成训练医生', 'specialty': '教学专科', 'population': '虚构训练人群',
          'focus': '核实证据局限', 'training_style': '每次追问一个问题', 'opening': '今天准备讨论什么？'}


@pytest.fixture(params=['sqlite', 'postgres'])
def client(tmp_path, request):
    config = settings(tmp_path, database_url=request.getfixturevalue('database_url')) if request.param == 'postgres' else settings(tmp_path)
    if request.param == 'postgres':
        clear_test_database(config.database_url)
    app = create_app(config)
    with TestClient(app, headers=ORIGIN) as client:
        yield client


def test_no_login_required_and_mutations_reject_untrusted_origin(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.get('/api/sessions').status_code == 200
        assert client.get('/api/catalog/doctor').status_code == 200
        assert client.post('/api/catalog/content', json=DOC).status_code == 403
        assert client.post('/api/catalog/content', json=DOC, headers={'origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/catalog/content', json=DOC, headers=ORIGIN).status_code == 201
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect('/api/realtime', headers={'origin': 'https://evil.example'}):
                pass
        assert exc.value.code == 1008
        paths = client.get('/openapi.json').json()['paths']
        assert not any(path.startswith(('/api/auth/', '/api/members', '/api/workspaces')) for path in paths)


def test_content_review_versions_and_audit(client):
    created = client.post('/api/catalog/content', json=DOC).json()
    path = '/api/catalog/content/' + created['id']
    changed = client.put(path, json={**DOC, 'version':created['version'], 'scope':'修订的适用范围'})
    assert changed.status_code == 200
    assert client.put(path, json={**DOC, 'version':created['version']}).status_code == 409
    submitted = client.post(path+'/review', json={'version':changed.json()['version'], 'action':'submit','reason':'请核对证据范围'}).json()
    approved = client.post(path+'/review', json={'version':submitted['version'], 'action':'approve','reason':'已核对合成内容'}).json()
    assert approved['status'] == 'approved' and approved['approved_by'] == 'local'
    assert client.put(path, json={**DOC,'version':approved['version']}).status_code == 409
    revision = client.post(path+'/revision').json()
    assert revision['status'] == 'draft' and revision['series_id'] == created['id']
    assert 'approved_by' not in revision
    assert client.get(path).json()['status'] == 'approved'
    retired = client.post(path+'/review', json={'version':approved['version'], 'action':'retire','reason':'材料停用'}).json()
    assert retired['status'] == 'retired'
    with client.app.state.platform.transaction(client.app.state.local_user['workspace'], write=False) as tx:
        actions = [row['action'] for row in tx.list(client.app.state.local_user['workspace'], 'audit')]
        assert {'content.create','content.edit','content.submit','content.approve','content.revision','content.retire'} <= set(actions)


def test_existing_records_are_accessible_without_login(client):
    ids = []
    for workspace, owner in [('tests', 'learner@example.test'), ('other', 'other@example.test'), (None, None)]:
        record = SessionRecord(str(uuid4()), 'assisted')
        if workspace is not None:
            record.data.update(workspace=workspace, owner_id=owner, team='')
        record.transcript('u1', 'trainee', '历史演练', final=True)
        client.app.state.records.save(record, 'completed')
        ids.append(record.data['id'])
    assert {r['id'] for r in client.get('/api/sessions').json()} == set(ids)
    for record_id in ids:
        assert client.get('/api/sessions/' + record_id).status_code == 200
        assert client.get('/api/sessions/' + record_id + '/reviews').status_code == 200


def test_doctor_updates_overwrite_published_profile_and_preserve_history(client):
    doctor = client.post('/api/catalog/doctor', json=DOCTOR).json()
    path = '/api/catalog/doctor/' + doctor['id']
    doctor = client.post(path+'/publish', json={'version':doctor['version']}).json()
    ids = {row['id'] for row in client.get('/api/catalog/doctor').json()}
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    client.post('/api/catalog/rubric/'+rubric['id']+'/publish', json={'version':rubric['version']})
    scene = client.post('/api/catalog/scenario', json={'title':'覆盖更新验证', 'product':'教学产品',
        'disease':'沟通训练', 'objective':'解释证据局限', 'doctor_id':doctor['id'],
        'rubric_id':rubric['id'], 'stages':['evidence']}).json()
    client.post('/api/catalog/scenario/'+scene['id']+'/publish', json={'version':scene['version']})
    preview = '/api/scenarios/'+scene['id']+'/preview'
    captured = client.get(preview).json()
    record = SessionRecord(str(uuid4()), 'assisted')
    record.data.update(workspace='local', owner_id='local', training=captured)
    client.app.state.records.save(record, 'completed')

    response = client.put(path, json={**DOCTOR, 'name':'更新后的训练医生', 'focus':'平衡沟通获益与风险', 'version':doctor['version']})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed['id'] == doctor['id'] and changed['version'] == doctor['version']+1
    assert changed['status'] == 'published' and changed['created_at'] == doctor['created_at']
    assert changed['display_name'] == '更新后的训练医生（训练模拟）'
    assert {row['id'] for row in client.get('/api/catalog/doctor').json()} == ids
    assert client.get(preview).json()['doctor']['focus'] == '平衡沟通获益与风险'
    assert client.get('/api/sessions/'+record.data['id']).json()['training'] == captured
    assert client.put(path, json={**DOCTOR, 'version':doctor['version']}).status_code == 409
    assert client.get(path).json() == changed
    assert client.post(path+'/revision').status_code == 409
    assert {row['id'] for row in client.get('/api/catalog/doctor').json()} == ids


def test_doctor_deletion_checks_version_and_stays_deleted_after_seeding(client):
    path = '/api/catalog/doctor/li-xiaoying'
    doctor = client.get(path).json()
    query = path+'?version='+str(doctor['version'])
    assert client.delete(query, headers={'origin':'https://evil.example'}).status_code == 403
    assert client.delete(path).status_code == 422
    assert client.delete(path+'?version=0').status_code == 422
    assert client.delete(path+'?version='+str(doctor['version']+1)).status_code == 409
    assert client.get(path).json() == doctor
    assert client.delete(query).status_code == 200
    assert client.get(path).status_code == 404
    assert all(row['id'] != doctor['id'] for row in client.get('/api/catalog/doctor').json())
    assert client.put(path, json={**DOCTOR, 'version':doctor['version']}).status_code == 404
    assert client.post(path+'/revision').status_code == 404
    assert client.post(path+'/publish', json={'version':doctor['version']}).status_code == 404
    user = client.app.state.local_user
    Catalog(client.app.state.platform).seed(user['workspace'], user['id'])
    assert client.get(path).status_code == 404
    with client.app.state.platform.transaction(user['workspace'], write=False) as tx:
        assert any(row['action'] == 'doctor.delete' for row in tx.list(user['workspace'], 'audit'))


def test_doctor_deletion_rejects_existing_scenario_bindings(client):
    doctor = client.get('/api/catalog/doctor/li-xiaoying').json()
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    scene = client.post('/api/catalog/scenario', json={'title':'删除引用验证', 'product':'教学产品',
        'disease':'沟通训练', 'objective':'解释证据局限', 'doctor_id':doctor['id'],
        'rubric_id':rubric['id'], 'stages':['evidence']}).json()
    path = '/api/catalog/doctor/'+doctor['id']
    query = path+'?version='+str(doctor['version'])
    assert client.delete(query).status_code == 409
    client.post('/api/catalog/rubric/'+rubric['id']+'/publish', json={'version':rubric['version']})
    assert client.post('/api/catalog/scenario/'+scene['id']+'/publish', json={'version':scene['version']}).status_code == 200
    assert client.delete(query).status_code == 409
    assert client.get(path).json() == doctor
    assert client.get('/api/scenarios/'+scene['id']+'/preview').json()['doctor']['id'] == doctor['id']


def test_existing_workspace_catalog_is_reused_without_deleting_users(tmp_path):
    config = settings(tmp_path)
    store = PlatformStore(config.records / 'platform.sqlite3')
    store.open()
    with store.transaction() as tx:
        tx.create('', 'system', {'workspace': 'old-workspace'}, item_id='setup')
        tx.create('old-workspace', 'doctor', {'name': '旧场景医生', 'status': 'draft'}, item_id='old-doctor')
        tx.create('old-workspace', 'user', {'name': '旧用户'}, item_id='old-user')
    with TestClient(create_app(config), headers=ORIGIN) as client:
        assert client.get('/api/catalog/doctor/old-doctor').json()['name'] == '旧场景医生'
        with client.app.state.platform.transaction('old-workspace', write=False) as tx:
            assert tx.get('old-workspace', 'user', 'old-user')['name'] == '旧用户'


def test_catalog_publication_and_stale_content(client):
    rubric = client.get('/api/catalog/rubric/academic-visit-v1').json()
    assert client.post('/api/catalog/rubric/'+rubric['id']+'/publish',json={'version':rubric['version']}).status_code == 200
    doc = client.post('/api/catalog/content',json=DOC).json()
    scene = {'title':'研究介绍专项', 'product':'教学产品','disease':'成人体重管理','objective':'介绍证据局限',
             'doctor_id':'li-xiaoying','rubric_id':rubric['id'],'content_ids':[doc['id']], 'stages':['evidence']}
    response = client.post('/api/catalog/scenario',json=scene)
    assert response.status_code == 201, response.text
    scene = response.json(); path='/api/catalog/scenario/'+scene['id']
    assert client.post(path+'/publish',json={'version':scene['version']}).status_code == 409
    scene['content_ids']=[]
    update = {k:v for k,v in scene.items() if k not in ('id','status','created_at','updated_at','created_by')}
    scene = client.put(path,json=update).json()
    assert client.post(path+'/publish',json={'version':scene['version']}).status_code == 200
    assert client.put(path,json=update).status_code == 409
    assert client.post(path+'/revision').json()['status'] == 'draft'
    assert client.post('/api/catalog/content',json={**DOC, 'pages':[DOC['pages'][0],DOC['pages'][0]]}).status_code == 422
    assert client.post('/api/catalog/content',json={**DOC, 'source_url':'http://127.0.0.1/private'}).status_code == 422
    expiry=(datetime.now(timezone.utc)-timedelta(days=1)).isoformat()
    expired=client.post('/api/catalog/content',json={**DOC,'expires_at':expiry}).json()
    expired_path='/api/catalog/content/'+expired['id']+'/review'
    pending=client.post(expired_path,json={'version':expired['version'],'action':'submit','reason':'提交'}).json()
    assert client.post(expired_path,json={'version':pending['version'],'action':'approve','reason':'审核'}).status_code == 409


def test_transaction_rollback_and_concurrent_writes(tmp_path):
    store=PlatformStore(tmp_path/'platform.sqlite3');store.open()
    with store.transaction('a') as tx:
        item=tx.create('a','doctor',{'name':'draft'})
    def update(name):
        try:
            with store.transaction('a') as tx:
                tx.update('a','doctor',item['id'],{'name':name},item['version'])
            return True
        except Conflict: return False
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(update,['first','second'])) == [False,True]
    with pytest.raises(RuntimeError):
        with store.transaction('a') as tx:
            tx.create('a','doctor',{'name':'rollback'},item_id='rollback')
            raise RuntimeError('abort')
    with store.transaction('a',write=False) as tx:
        assert tx.get('a','doctor','rollback') is None
    assert tmp_path.joinpath('platform.sqlite3').stat().st_mode & 0o777 == 0o600


def pdf_fixture(text=b'Training evidence for software QA only.'):
    stream=b'BT /F1 12 Tf 50 750 Td ('+text+b') Tj ET'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
             b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
             b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
             b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
    result=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(result));result+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    xref=len(result)
    result+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
    result+=b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])
    return result+f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


def test_pdf_import_original_download_and_access(client):
    import hashlib
    raw=pdf_fixture()
    response=client.post('/api/content/pdf',content=raw,headers={'content-type':'application/pdf'})
    assert response.status_code==201,response.text
    extracted=response.json()
    assert extracted['pages'][0]['number']==1
    assert 'Training evidence' in extracted['pages'][0]['text']
    assert extracted['sha256']==hashlib.sha256(raw).hexdigest()
    saved=client.post('/api/catalog/content',json={**DOC,'pages':extracted['pages'],'asset_id':extracted['asset_id']}).json()
    download='/api/catalog/content/'+saved['id']+'/file'
    response=client.get(download)
    assert response.content==raw and response.headers['x-content-type-options']=='nosniff'
    assert client.post('/api/content/pdf',content=b'bad',headers={'content-type':'application/pdf'}).status_code==422
    assert client.post('/api/content/pdf',content=pdf_fixture(b''),headers={'content-type':'application/pdf'}).status_code==422


def test_pdf_bounds_blank_and_truncated():
    from medvisit.platform.pdf_extract import extract_pdf
    for raw in [b'not a PDF', b'%PDF-'+b'x'*20_000_000, pdf_fixture(b''), pdf_fixture(b'x'*20001), b'%PDF-1.4\ntruncated']:
        with pytest.raises(ValueError):
            extract_pdf(raw)


