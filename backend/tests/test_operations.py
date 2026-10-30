from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from conftest import LocalClient as TestClient, clear_test_database
from medvisit.api.app import create_app
from medvisit.platform.operations import Operations, Override
from medvisit.platform.training import prepare_training,snapshot
from medvisit.platform.evaluation import EVALUATOR_VERSION,rubric_fingerprint
from medvisit.storage.records import SessionRecord
from test_bridge import settings
from test_calibration import setup_scene
from test_storage import database_url


@pytest.fixture(params=['sqlite','postgres'])
def platform(tmp_path,request):
    config=settings(tmp_path,database_url=request.getfixturevalue('database_url')) if request.param=='postgres' else settings(tmp_path)
    if request.param=='postgres':
        clear_test_database(config.database_url)
    app=create_app(config)
    with TestClient(app) as client:
        rubric,scene=setup_scene(client)
        yield client,Operations(app.state.platform,app.state.records),rubric,scene


def save_record(client,service,scene,text,score=2,remediation_id=None):
    user=client.app.state.local_user
    training=prepare_training(service.store,user,scene['id'],'closing')
    record=SessionRecord(str(uuid4()),'independent')
    record.data.update(workspace=user['workspace'],owner_id=user['id'],team=user['team'],experience='practice',
        capture_status='completed',analysis_status='completed',training=snapshot(training))
    if remediation_id:record.data['remediation_id']=remediation_id
    record.transcript('d1','doctor','你准备如何跟进？',final=True)
    record.transcript('u1','trainee',text,final=True)
    record.data['coaching']=[{'final_report':True,'based_on':'u1','incomplete':False,'assessment':{
        'total':score*25,'status':'complete','model':'fake-model','evaluator_version':EVALUATOR_VERSION,'rubric_id':training['rubric']['id'],
        'rubric_name':training['rubric']['name'],'rubric_fingerprint':rubric_fingerprint(training['rubric']),
        'calibration_status':'uncalibrated','observed_weight':100,'validation_errors':[],
        'dimensions':[{'key':'expression','label':'表达','weight':100,'score':score}]}}]
    service.records.save(record,'completed')
    return record


def test_comments_adjustments_and_retrain_remain_scoped(platform):
    client,service,_,scene=platform
    record=save_record(client,service,scene,'我会核实这项问题后，在约定时间反馈您。')
    path='/api/sessions/'+record.data['id']
    assert client.post(path+'/reviews',json={'comment':'self'}).status_code==201
    plan=client.post(path+'/retrain',json={}).json()
    assert plan['focus_key']=='expression' and plan['rubric_id']==record.data['training']['rubric']['id']
    changed=client.post(path+'/reviews',json={'message_id':'u1','comment':'核对后调整表达评价',
        'overrides':[{'key':'expression','score':3,'reason':'原话结构完整'}]})
    assert changed.status_code==201,changed.text
    assert changed.json()['action']=='comment'
    assert client.get(path).json()['coaching'][0]['assessment']['total']==50
    assert client.post(path+'/reviews',json={'action':'approve','comment':'已移除的审批'}).status_code==422
    choice=client.get('/api/remediations/'+plan['id']+'/next').json()
    assert choice['remediation_id']==plan['id'] and choice['scenario_id']==scene['id']
    assert choice['experience']=='practice' and choice['mode']=='independent'
    assert client.get('/api/remediations').json()[0]['id']==plan['id']
    assert client.post(path+'/retrain',json={}).status_code==201


@pytest.mark.parametrize('experience,mode', [('practice','assisted'),('practice','independent'),('combat','independent')])
def test_retraining_prefills_original_experience_and_assistance(platform, experience, mode):
    client,service,_,scene=platform
    record=save_record(client,service,scene,'我会核对资料范围后，通过授权渠道跟进反馈。')
    record.data.update(experience=experience,mode=mode)
    service.records.save(record,'completed')
    plan=client.post('/api/sessions/'+record.data['id']+'/retrain',json={}).json()
    choice=client.get('/api/remediations/'+plan['id']+'/next').json()
    assert choice['experience']==experience and choice['mode']==mode
    assert choice['stage']=='closing' and choice['scenario_id']==scene['id']


def test_retraining_comparison_and_completion_preserve_model_boundary(platform):
    client,service,_,scene=platform
    record=save_record(client,service,scene,'我会核对这项问题，并在约定时间向您反馈。')
    plan=client.post('/api/sessions/'+record.data['id']+'/retrain',json={}).json()
    child=save_record(client,service,scene,'我会核对原始材料，确认授权渠道后提供准确反馈。',score=3,remediation_id=plan['id'])
    service.finish_remediation(client.app.state.local_user,child)
    result=client.get('/api/remediations/'+plan['id']+'/progress').json()
    assert result['status']=='completed' and result['comparable'] and result['dimensions'][0]['delta']==1
    assert client.get('/api/remediations/'+plan['id']+'/next').status_code==403
    child.data['coaching'][0]['assessment']['model']='different-model'
    service.records.save(child,'completed')
    result=client.get('/api/remediations/'+plan['id']+'/progress').json()
    assert not result['comparable'] and result['dimensions']==[]


@pytest.mark.parametrize('change', ['doctor', 'scenario', 'documents', 'stage', 'experience'])
def test_retraining_does_not_compare_different_conditions(platform, change):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会核对材料后按约定方式向您反馈。')
    plan = client.post('/api/sessions/'+record.data['id']+'/retrain', json={}).json()
    child = save_record(client, service, scene, '我会核对原文、适用范围，并通过授权渠道反馈。', score=3, remediation_id=plan['id'])
    if change in ('doctor', 'scenario'):
        child.data['training'][change]['version'] += 1
    elif change == 'documents':
        child.data['training']['documents'] = [{'id':'new-material','version':1,'sha256':'changed'}]
    elif change == 'stage':
        child.data['training']['stage'] = 'opening'
    else:
        child.data['experience'] = 'combat'
    service.records.save(child, 'completed')
    result = client.get('/api/remediations/'+plan['id']+'/progress').json()
    assert not result['comparable'] and result['dimensions'] == []
    assert result['comparison_reasons']


def test_doctor_change_rejects_retraining_creation_and_start(platform):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会核对材料后按约定方式向您反馈。')
    path = '/api/sessions/'+record.data['id']+'/retrain'
    plan = client.post(path, json={}).json()
    user = client.app.state.local_user
    with service.store.transaction(user['workspace']) as tx:
        doctor = tx.get(user['workspace'], 'doctor', scene['doctor_id'])
        tx.update(user['workspace'], 'doctor', doctor['id'], {**doctor, 'mood':'busy'}, doctor['version'])
    assert client.post(path, json={}).status_code == 409
    assert client.get('/api/remediations/'+plan['id']+'/next').status_code == 409


def test_legacy_activity_cache_is_recomputed_without_losing_records(platform):
    client, service, _, scene = platform
    record = save_record(client, service, scene, '我会核对材料后按约定方式向您反馈。')
    record.data['activity']['format'] = 1
    record.data['activity'].pop('training_fingerprint', None)
    if hasattr(service.records, 'directory'):
        import json
        (service.records.directory / (record.data['id']+'.json')).write_text(json.dumps(record.data))
    else:
        from psycopg.types.json import Jsonb
        with service.records.pool.connection() as connection:
            connection.execute('UPDATE sessions SET document=%s WHERE id=%s', (Jsonb(record.data), record.data['id']))
    activity = next(row for row in service.records.activity() if row['id'] == record.data['id'])
    assert activity['format'] == 2 and activity['training_fingerprint']
    assert client.get('/api/sessions/'+record.data['id']).status_code == 200


def test_other_legacy_workspace_reviews_and_retraining_do_not_use_current_catalog(platform):
    client,service,_,scene=platform
    record=save_record(client,service,scene,'我会核对这项问题，并在约定时间向您反馈。')
    record.data['workspace']='other-legacy-workspace'
    service.records.save(record,'completed')
    with service.store.transaction('other-legacy-workspace') as tx:
        tx.create('other-legacy-workspace','review',{'record_id':record.data['id'],'comment':'旧工作区点评'})
    path='/api/sessions/'+record.data['id']
    assert client.get(path+'/reviews').json()['reviews'][0]['comment']=='旧工作区点评'
    response=client.post(path+'/retrain',json={})
    assert response.status_code==409
    assert '其他旧工作区' in response.json()['detail']


def test_score_adjustment_validation_and_single_user_grading(platform):
    with pytest.raises(ValidationError):Override(key='expression',score=True,reason='not numeric')
    client,service,_,scene=platform
    record=save_record(client,service,scene,'我会核实后按约定的方式反馈给您。')
    path='/api/sessions/'+record.data['id']+'/reviews'
    assert client.post(path,json={'comment':'自己的说明'}).status_code==201
    assert client.post(path,json={'comment':'self','overrides':[{'key':'expression','score':4,'reason':'self'}]}).status_code==201
    assert client.post(path,json={'message_id':'absent','comment':'引用不存在的原话'}).status_code==422


def test_preview_draft_does_not_enable_runtime(platform):
    client,service,_,scene=platform
    draft=client.post('/api/catalog/scenario/'+scene['id']+'/revision').json()
    preview=client.get('/api/scenarios/'+draft['id']+'/preview')
    assert preview.status_code==200 and preview.json()['scenario']['id']==draft['id']
    with pytest.raises(HTTPException):prepare_training(service.store,client.app.state.local_user,draft['id'])


def test_removed_branches_have_no_routes_and_keep_old_data(platform):
    client,service,_,_=platform
    paths=client.get('/openapi.json').json()['paths']
    for prefix in ('/api/assignments','/api/certificates','/api/analytics','/api/goals','/api/leaderboard','/api/assistant'):
        assert not any(p.startswith(prefix) for p in paths)
        assert client.get(prefix).status_code==404
    with service.store.transaction('tests') as tx:
        old=tx.create('tests','course',{'title':'历史课程，保留数据'})
    assert client.get('/api/catalog/course').status_code==422
    with service.store.transaction('tests',write=False) as tx:
        assert tx.get('tests','course',old['id'])['title']=='历史课程，保留数据'
