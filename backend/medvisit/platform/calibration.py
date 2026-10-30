"""Expert-labelled calibration with durable progress and no automatic paid retries."""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
from fastapi import HTTPException
from pydantic import Field, model_validator
from typing import Literal

from .input import Input
from .catalog import require_item
from .evaluation import EVALUATOR_VERSION, rubric_fingerprint
from .store import now
from .training import check_materials, prepare_training


class SampleMessage(Input):
    id: str = Field(min_length=1,max_length=80)
    role: Literal['doctor','trainee']
    text: str = Field(min_length=1,max_length=4000)
    final: bool = True


class CalibrationSample(Input):
    title: str = Field(min_length=1,max_length=120)
    scenario_id: str = Field(min_length=1,max_length=80)
    stage: Literal['full','opening','needs','evidence','objections','safety','closing'] = 'full'
    label_type: Literal['expert','synthetic']
    messages: list[SampleMessage] = Field(min_length=1,max_length=32)
    expected_scores: dict[str,int|None] = Field(min_length=1,max_length=10)

    @model_validator(mode='before')
    @classmethod
    def strict_scores(cls, values):
        if isinstance(values,dict) and isinstance(values.get('expected_scores'),dict):
            if any(s is not None and (type(s) is not int or not 0<=s<=4) for s in values['expected_scores'].values()):
                raise ValueError('专家标注只能是0至4整数或null')
        return values

    @model_validator(mode='after')
    def captured_text(self):
        if len({m.id for m in self.messages})!=len(self.messages) or not any(m.role=='trainee' and m.final for m in self.messages):
            raise ValueError('消息id必须唯一，且必须有完整的学员原话')
        return self


def metrics(samples, results, dimensions):
    paired={r['sample_id']:r for r in results}
    expert=[s for s in samples if s['label_type']=='expert']
    rows=[]
    for dimension in dimensions:
        key=dimension['key'];pairs=[];expected_count=0
        for sample in expert:
            expected=sample['expected_scores'].get(key)
            if expected is None: continue
            expected_count+=1
            result=paired.get(sample['id'],{}).get('assessment',{})
            predicted=next((d.get('score') for d in result.get('dimensions',[]) if d['key']==key),None)
            if predicted is not None and not result.get('validation_errors'):
                pairs.append(abs(expected-predicted))
        rows.append({'key':key,'label':dimension['label'],'expected_count':expected_count,'paired_count':len(pairs),
                     'mae':round(sum(pairs)/len(pairs),3) if pairs else None,
                     'within_one':round(sum(e<=1 for e in pairs)/len(pairs),3) if pairs else None})
    calibrated=bool(rows) and len(expert)>=5 and all(r['expected_count']>=5 and r['paired_count']==r['expected_count']
        and r['mae']<=.5 and r['within_one']>=.9 for r in rows)
    return {'expert_samples':len(expert),'synthetic_samples':len(samples)-len(expert),'dimensions':rows,
            'calibrated':calibrated,'criteria':{'minimum_expert_samples_per_dimension':5,'maximum_mae':.5,'minimum_within_one':.9}}


async def _write(action):
    # Threaded writes must finish before cancellation lets shutdown close storage.
    task = asyncio.create_task(asyncio.to_thread(action))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


class Calibrator:
    def __init__(self,store,settings):
        self.store,self.settings=store,settings

    def add_sample(self,user,body):
        training=prepare_training(self.store,user,body.scenario_id,body.stage)
        keys={d['key'] for d in training['rubric']['dimensions']}
        if set(body.expected_scores)!=keys:
            raise HTTPException(422,'标注维度必须与场景绑定的量表完全一致。')
        content=[{'role':m.role,'text':m.text} for m in body.messages]
        digest=hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
        data={**body.model_dump(mode='json'),'rubric_id':training['rubric']['id'],
              'rubric_fingerprint':rubric_fingerprint(training['rubric']),'labelled_by':user['id']}
        with self.store.transaction(user['workspace']) as tx:
            item=tx.create(user['workspace'],'calibration_sample',data,item_id=training['rubric']['id']+'-'+digest[:24])
            tx.audit(user['workspace'],user['id'],'calibration.sample','calibration_sample',item['id'])
            return item

    def list_samples(self,user,rubric_id):
        with self.store.transaction(user['workspace'],write=False) as tx:
            return [s for s in tx.list(user['workspace'],'calibration_sample') if s['rubric_id']==rubric_id]

    def start(self,user,rubric_id,version):
        with self.store.transaction(user['workspace']) as tx:
            rubric=require_item(tx,user['workspace'],'rubric',rubric_id)
            if rubric['version']!=version or rubric['status']!='published':
                raise HTTPException(409,'请刷新并选择已发布的量表版本。')
            runs=tx.list(user['workspace'],'calibration_run')
            current=datetime.now(timezone.utc)
            if any(r['rubric_id']==rubric_id and r['status'] in ('running','cancel_requested') and datetime.fromisoformat(r['lease_until'])>current for r in runs):
                raise HTTPException(409,'此量表已有校准任务执行中。')
            samples=[s for s in tx.list(user['workspace'],'calibration_sample') if s['rubric_id']==rubric_id and s['rubric_fingerprint']==rubric_fingerprint(rubric)]
            samples.sort(key=lambda s:s['label_type']!='expert')
            samples=samples[:20]
            if not samples:
                raise HTTPException(409,'请先录入专家或合成样本。')
            item=tx.create(user['workspace'],'calibration_run',{
                'rubric_id':rubric_id,'rubric_fingerprint':rubric_fingerprint(rubric),'status':'running',
                'model':self.settings.deepseek_model,'evaluator_version':EVALUATOR_VERSION,'created_by':user['id'],
                'samples':samples,'results':[],'lease_until':(current+timedelta(seconds=120)).isoformat(),
                'sample_count':len(samples),'completed_count':0,'metrics':None})
            tx.audit(user['workspace'],user['id'],'calibration.start','calibration_run',item['id'])
            return item

    def get(self,user,run_id):
        with self.store.transaction(user['workspace']) as tx:
            run=require_item(tx,user['workspace'],'calibration_run',run_id)
            if run['status'] in ('running','cancel_requested') and datetime.fromisoformat(run['lease_until'])<datetime.now(timezone.utc):
                run=tx.update(user['workspace'],'calibration_run',run_id,{**run,'status':'interrupted','error':'执行进程未继续更新，任务已中断；不会自动重试。'},run['version'])
            return {k:v for k,v in run.items() if k!='samples'}

    def cancel(self,user,run_id):
        with self.store.transaction(user['workspace']) as tx:
            run=require_item(tx,user['workspace'],'calibration_run',run_id)
            if run['status']=='running':
                tx.update(user['workspace'],'calibration_run',run_id,{**run,'status':'cancel_requested'},run['version'])
                tx.audit(user['workspace'],user['id'],'calibration.cancel','calibration_run',run_id)
        return self.get(user,run_id)

    async def execute(self,user,run_id):
        from ..agents.coach import generate_reply
        # shortcut: a process-local worker; leases expose interrupted jobs after restart without replaying paid calls.
        results=[];status='completed';error=None;rubric=None
        try:
            def load():
                with self.store.transaction(user['workspace'],write=False) as tx:
                    run=require_item(tx,user['workspace'],'calibration_run',run_id)
                    return run['samples'],require_item(tx,user['workspace'],'rubric',run['rubric_id'])
            samples,rubric=await asyncio.to_thread(load)
            async with asyncio.timeout(600):
                for sample in samples:
                    current=await asyncio.to_thread(self.get,user,run_id)
                    if current['status']!='running':
                        status='cancelled' if current['status']=='cancel_requested' else current['status'];break
                    training=await asyncio.to_thread(prepare_training,self.store,user,sample['scenario_id'],sample['stage'])
                    response,usage=await generate_reply(self.settings,sample['messages'],speak=False,training=training)
                    await asyncio.to_thread(check_materials,self.store,user['workspace'],training)
                    results.append({'sample_id':sample['id'],'sample_version':sample['version'],
                                    'assessment':response['coach']['assessment'],'usage':usage})
                    def progress():
                        with self.store.transaction(user['workspace']) as tx:
                            current=require_item(tx,user['workspace'],'calibration_run',run_id)
                            tx.update(user['workspace'],'calibration_run',run_id,{**current,'results':results,
                                'completed_count':len(results),'lease_until':(datetime.now(timezone.utc)+timedelta(seconds=120)).isoformat()},current['version'])
                    await _write(progress)
        except asyncio.CancelledError:
            status='interrupted';error='服务停止，校准中断；不会自动重试。'
            raise
        except Exception:
            status='failed';error='部分样本未完成，请核对资料有效性与模型服务。'
        finally:
            def finish():
                with self.store.transaction(user['workspace']) as tx:
                    current=require_item(tx,user['workspace'],'calibration_run',run_id)
                    summary=metrics(current['samples'],results,rubric['dimensions']) if rubric else None
                    final_status='cancelled' if current['status']=='cancel_requested' else status
                    if current['status']=='interrupted':final_status='interrupted'
                    tx.update(user['workspace'],'calibration_run',run_id,{**current,'status':final_status,'error':error,
                        'metrics':summary,'results':results,'completed_count':len(results),'finished_at':now()},current['version'])
                    if final_status=='completed' and summary:
                        active=require_item(tx,user['workspace'],'rubric',current['rubric_id'])
                        tx.update(user['workspace'],'rubric',active['id'],{**active,
                            'calibration_status':'calibrated' if summary['calibrated'] else 'uncalibrated',
                            'calibration_run_id':run_id,'calibrated_model':self.settings.deepseek_model,
                            'calibrated_evaluator_version':EVALUATOR_VERSION},active['version'])
                    tx.audit(user['workspace'],user['id'],'calibration.finish','calibration_run',run_id,{'status':final_status})
            await _write(finish)
