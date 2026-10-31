import asyncio
import copy
from contextlib import contextmanager
import threading
from datetime import datetime,timedelta,timezone
from unittest.mock import AsyncMock,patch

import pytest
from fastapi import HTTPException

from conftest import LocalClient as TestClient
from medvisit.api.app import create_app
from medvisit.core.config import Settings
from medvisit.platform.calibration import Calibrator, metrics
from medvisit.platform.evaluation import EVALUATOR_VERSION
from test_bridge import settings
from test_platform import DOC


def setup_scene(client, content_ids=()):
    rubric=client.post('/api/catalog/rubric',json={'name':'表达训练','dimensions':[{'key':'expression','label':'表达','weight':100,'requires_content':False,'anchors':['混乱','跳跃','基本清楚','清楚','简洁清楚']}]}).json()
    rubric=client.post('/api/catalog/rubric/'+rubric['id']+'/publish',json={'version':rubric['version']}).json()
    scene=client.post('/api/catalog/scenario',json={'title':'收尾','product':'教学','disease':'沟通练习','objective':'核实后反馈','doctor_id':'li-xiaoying','rubric_id':rubric['id'],'content_ids':list(content_ids),'stages':['closing']}).json()
    scene=client.post('/api/catalog/scenario/'+scene['id']+'/publish',json={'version':scene['version']}).json()
    return rubric,scene


def add_samples(client,scene,label_type='expert',count=5):
    rows=[]
    for index in range(count):
        result=client.post('/api/calibration/samples',json={'title':f'合成测试标注{index}','scenario_id':scene['id'],'stage':'closing',
            'label_type':label_type,'messages':[{'id':'u1','role':'trainee','text':f'我会核实第{index}项问题后，通过授权渠道反馈。'}],'expected_scores':{'expression':4}})
        assert result.status_code==201,result.text
        rows.append(result.json())
    return rows


async def prediction(*args,**kwargs):
    return {'coach':{'assessment':{'dimensions':[{'key':'expression','score':4}],'validation_errors':[]}}},{'total_tokens':10}


def test_calibration_report_and_model_version(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        rubric,scene=setup_scene(client);rows=add_samples(client,scene)
        assert len(client.get('/api/rubrics/'+rubric['id']+'/samples').json())==5
        with patch('medvisit.agents.coach.generate_reply',side_effect=prediction):
            response=client.post('/api/rubrics/'+rubric['id']+'/calibration',json={'version':rubric['version']})
        assert response.status_code==202,response.text
        run=client.get('/api/calibration/runs/'+response.json()['id']).json()
        assert run['status']=='completed' and run['completed_count']==5
        assert run['metrics']['calibrated'] and run['metrics']['dimensions'][0]['mae']==0
        current=client.get('/api/catalog/rubric/'+rubric['id']).json()
        assert current['calibration_status']=='calibrated' and current['calibrated_evaluator_version']==EVALUATOR_VERSION
        assert current['calibrated_model']=='fake-model'
        assert 'samples' not in run
        duplicate={k:v for k,v in rows[0].items() if k in ('title','scenario_id','stage','label_type','messages','expected_scores')}
        assert client.post('/api/calibration/samples',json=duplicate).status_code==409


async def test_calibration_storage_work_stays_off_the_event_loop(tmp_path):
    config = settings(tmp_path)
    app = create_app(config)
    with TestClient(app) as client:
        rubric, scene = setup_scene(client)
        add_samples(client, scene, count=1)
        user = app.state.local_user
        service = Calibrator(app.state.platform, config)
        run = service.start(user, rubric['id'], rubric['version'])
        transaction = app.state.platform.transaction
        event_thread = threading.get_ident()
        threads = []

        def tracked_transaction(*args, **kwargs):
            threads.append(threading.get_ident())
            return transaction(*args, **kwargs)

        with patch.object(app.state.platform, 'transaction', tracked_transaction), \
             patch('medvisit.agents.coach.generate_reply', side_effect=prediction):
            await service.execute(user, run['id'])
        assert service.get(user, run['id'])['status'] == 'completed'
        assert threads and all(thread != event_thread for thread in threads)


def test_synthetic_samples_never_calibrate(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        rubric,scene=setup_scene(client);add_samples(client,scene,label_type='synthetic')
        with patch('medvisit.agents.coach.generate_reply',side_effect=prediction):
            started=client.post('/api/rubrics/'+rubric['id']+'/calibration',json={'version':rubric['version']}).json()
        run=client.get('/api/calibration/runs/'+started['id']).json()
        assert run['status']=='completed' and not run['metrics']['calibrated']
        assert run['metrics']['expert_samples']==0 and run['metrics']['synthetic_samples']==5
        assert client.get('/api/catalog/rubric/'+rubric['id']).json()['calibration_status']=='uncalibrated'


async def test_retired_source_during_last_prediction_does_not_calibrate(tmp_path):
    config = settings(tmp_path)
    app = create_app(config)
    with TestClient(app) as client:
        content = client.post('/api/catalog/content', json=DOC).json()
        path = '/api/catalog/content/' + content['id'] + '/review'
        for action in ('submit', 'approve'):
            content = client.post(path, json={'action':action, 'version':content['version'], 'reason':'测试资料'}).json()
        rubric, scene = setup_scene(client, [content['id']])
        add_samples(client, scene)
        service = Calibrator(app.state.platform, config)
        user = app.state.local_user
        run = service.start(user, rubric['id'], rubric['version'])
        calls = 0

        async def retiring_prediction(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 5:
                retired = client.post(path, json={'action':'retire', 'version':content['version'], 'reason':'测试停用'})
                assert retired.status_code == 200
            return await prediction(*args, **kwargs)

        with patch('medvisit.agents.coach.generate_reply', side_effect=retiring_prediction):
            await service.execute(user, run['id'])
        result = service.get(user, run['id'])
        assert result['status'] == 'failed'
        assert result['completed_count'] == 4 and not result['metrics']['calibrated']
        assert client.get('/api/catalog/rubric/'+rubric['id']).json()['calibration_status'] == 'uncalibrated'


@pytest.mark.parametrize('cancellations', [1, 2])
async def test_cancellation_waits_for_calibration_results_to_commit(tmp_path, cancellations):
    config = settings(tmp_path)
    app = create_app(config)
    with TestClient(app) as client:
        rubric, scene = setup_scene(client)
        add_samples(client, scene, count=1)
        service = Calibrator(app.state.platform, config)
        user = app.state.local_user
        run = service.start(user, rubric['id'], rubric['version'])
        transaction = app.state.platform.transaction
        started, release, committed = (threading.Event() for _ in range(3))

        @contextmanager
        def blocked_finish(*args, **kwargs):
            finishing = False
            with transaction(*args, **kwargs) as tx:
                audit = tx.audit
                def tracked_audit(tenant, actor, action, *args, **kwargs):
                    nonlocal finishing
                    if action == 'calibration.finish':
                        finishing = True
                        started.set()
                        assert release.wait(5)
                    return audit(tenant, actor, action, *args, **kwargs)
                tx.audit = tracked_audit
                yield tx
            if finishing:
                committed.set()

        with patch.object(app.state.platform, 'transaction', blocked_finish), \
             patch('medvisit.agents.coach.generate_reply', side_effect=prediction):
            task = asyncio.create_task(service.execute(user, run['id']))
            try:
                assert await asyncio.to_thread(started.wait, 3)
                for _ in range(cancellations):
                    task.cancel()
                    await asyncio.sleep(0)
                    await asyncio.sleep(0)
                    assert not task.done()
            finally:
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert await asyncio.to_thread(committed.wait, 3)
        result = service.get(user, run['id'])
        assert result['status'] == 'completed' and result['completed_count'] == 1


@pytest.mark.parametrize('cancellations', [1, 2])
async def test_cancellation_drains_pending_progress_before_finalizing(tmp_path, cancellations):
    config = settings(tmp_path)
    app = create_app(config)
    with TestClient(app) as client:
        rubric, scene = setup_scene(client)
        add_samples(client, scene, count=1)
        service = Calibrator(app.state.platform, config)
        user = app.state.local_user
        run = service.start(user, rubric['id'], rubric['version'])
        transaction = app.state.platform.transaction
        started, release, committed = (threading.Event() for _ in range(3))
        writes = 0
        order = []

        @contextmanager
        def delayed_progress(*args, **kwargs):
            nonlocal writes
            progress = False
            if kwargs.get('write', True):
                writes += 1
                # The first write checks the lease; delay the following progress write before it locks storage.
                progress = writes == 2
                if progress:
                    started.set()
                    assert release.wait(5)
            with transaction(*args, **kwargs) as tx:
                audit = tx.audit
                def tracked_audit(tenant, actor, action, *args, **kwargs):
                    if action == 'calibration.finish':
                        order.append('finish')
                    return audit(tenant, actor, action, *args, **kwargs)
                tx.audit = tracked_audit
                yield tx
            if progress:
                order.append('progress')
                committed.set()

        with patch.object(app.state.platform, 'transaction', delayed_progress), \
                patch('medvisit.agents.coach.generate_reply', side_effect=prediction):
            task = asyncio.create_task(service.execute(user, run['id']))
            try:
                assert await asyncio.to_thread(started.wait, 3)
                for _ in range(cancellations):
                    task.cancel()
                    await asyncio.sleep(.05)
                    assert not task.done() and not order
            finally:
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert await asyncio.to_thread(committed.wait, 3)
        assert order == ['progress', 'finish']
        result = service.get(user, run['id'])
        assert result['status'] == 'interrupted' and result['completed_count'] == 1


def test_calibration_lease_detects_interruption_and_prevents_duplicate(tmp_path):
    config=settings(tmp_path);app=create_app(config)
    with TestClient(app) as client:
        rubric,scene=setup_scene(client);add_samples(client,scene,count=1)
        user=client.app.state.local_user;service=Calibrator(app.state.platform,config)
        run=service.start(user,rubric['id'],rubric['version'])
        with pytest.raises(HTTPException) as exc:
            service.start(user,rubric['id'],rubric['version'])
        assert exc.value.status_code==409
        with app.state.platform.transaction(user['workspace']) as tx:
            tx.update(user['workspace'],'calibration_run',run['id'],{**run,'lease_until':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()},run['version'])
        assert service.get(user,run['id'])['status']=='interrupted'
        assert service.start(user,rubric['id'],rubric['version'])['id']!=run['id']


def test_metrics_require_complete_predictions_and_enough_experts():
    dimensions=[{'key':'a','label':'A'}]
    samples=[{'id':str(i),'label_type':'expert','expected_scores':{'a':4}} for i in range(5)]
    results=[{'sample_id':str(i),'assessment':{'dimensions':[{'key':'a','score':4}],'validation_errors':[]}} for i in range(5)]
    assert metrics(samples,results,dimensions)['calibrated']
    assert not metrics(samples,results[:-1],dimensions)['calibrated']
    results[0]['assessment']['validation_errors']=['fake source']
    assert not metrics(samples,results,dimensions)['calibrated']
    assert not metrics(samples[:4],results,dimensions)['calibrated']


def test_kappa_bias_and_stability_are_reported_and_can_veto_calibration():
    from medvisit.platform.calibration import weighted_kappa
    dims=[{'key':'a','label':'A'}]
    scores=[0,1,2,3,4,0,1,2,3,4]
    samples=[{'id':str(i),'label_type':'expert','expected_scores':{'a':v}} for i,v in enumerate(scores)]
    def run(values):
        return [{'sample_id':str(i),'assessment':{'dimensions':[{'key':'a','score':v}],'validation_errors':[]}} for i,v in enumerate(values)]
    perfect=metrics(samples,run(scores),dims)
    assert perfect['calibrated'] and perfect['dimensions'][0]['kappa']==1.0 and perfect['dimensions'][0]['bias']==0
    # Every score one point high: within_one still passes but MAE 1 > .5 fails; bias exposes the direction.
    high=metrics(samples,run([min(4,v+1) for v in scores]),dims)
    assert not high['calibrated'] and high['dimensions'][0]['bias']>0
    # A model that agrees on average yet flips between runs must not calibrate.
    flaky={str(i):[{'dimensions':[{'key':'a','score':(v+3)%5}],'validation_errors':[]}] for i,v in enumerate(scores)}
    unstable=metrics(samples,run(scores),dims,repeats=flaky)
    assert not unstable['calibrated'] and unstable['dimensions'][0]['stability']<.9
    assert weighted_kappa([(1,1)]) is None and weighted_kappa([(2,2),(2,2)]) is None    # no variance: undefined, not 1.0


def test_minimum_sample_floor_is_configurable():
    dims=[{'key':'a','label':'A'}]
    samples=[{'id':str(i),'label_type':'expert','expected_scores':{'a':v}} for i,v in enumerate([0,1,2,3,4,4,3,2])]
    results=[{'sample_id':str(i),'assessment':{'dimensions':[{'key':'a','score':s['expected_scores']['a']}],'validation_errors':[]}} for i,s in enumerate(samples)]
    assert metrics(samples,results,dims)['calibrated']
    assert not metrics(samples,results,dims,minimum=20)['calibrated']


def test_calibration_repeats_setting_is_bounded():
    with pytest.raises(ValueError, match='CALIBRATION_REPEATS'):
        Settings(calibration_repeats=4)
    assert Settings(calibration_repeats=0).calibration_repeats == 0


def test_repeat_runs_measure_stability_and_an_unstable_model_is_not_calibrated(tmp_path):
    calls = []
    async def flip(*args, **kwargs):
        calls.append(1)
        score = 4 if len(calls) % 2 else 0          # first run of each sample agrees with the expert, the repeat does not
        return {'coach':{'assessment':{'dimensions':[{'key':'expression','score':score}],'validation_errors':[]}}},{'total_tokens':10}
    with TestClient(create_app(settings(tmp_path, calibration_repeats=1))) as client:
        rubric,scene=setup_scene(client);add_samples(client,scene)
        with patch('medvisit.agents.coach.generate_reply',side_effect=flip):
            response=client.post('/api/rubrics/'+rubric['id']+'/calibration',json={'version':rubric['version']})
        run=client.get('/api/calibration/runs/'+response.json()['id']).json()
        status=client.get('/api/catalog/rubric/'+rubric['id']).json()['calibration_status']
    assert len(calls) == 10                          # 5 samples x (1 scored run + 1 repeat)
    row = run['metrics']['dimensions'][0]
    assert row['repeat_comparisons'] == 5 and row['stability'] == 0.0
    assert row['mae'] == 0 and not run['metrics']['calibrated']
    assert status == 'uncalibrated'
