"""Record comments, evidence-backed adjustments and same-version practice."""
from uuid import UUID
from functools import cache

from fastapi import HTTPException
from pydantic import Field, StrictInt

from .input import Input
from .catalog import require_item
from .models import STAGES, content_usable
from .training import prepare_training, snapshot
from .evaluation import normalize
from ..storage.records import activity_record, training_fingerprint
from ..core.identity import current_actor


class Citation(Input):
    document_id: str = Field(min_length=1,max_length=80)
    page: int = Field(ge=1,le=2000)
    quote: str = Field(min_length=6,max_length=500)


class Override(Input):
    key: str = Field(min_length=1,max_length=40)
    score: StrictInt | None = Field(default=None,ge=0,le=4)
    reason: str = Field(min_length=1,max_length=600)
    citations: list[Citation] = Field(default_factory=list,max_length=3)


class Review(Input):
    message_id: str | None = Field(default=None,max_length=80)
    comment: str = Field(min_length=1,max_length=2000)
    overrides: list[Override] = Field(default_factory=list,max_length=10)


class Retrain(Input):
    stage: str | None = Field(default=None,max_length=40)
    note: str = Field(default='',max_length=1000)


def distinct_valid(rows):
    seen=set();result=[]
    for row in sorted((row for row in rows if row.get('valid')),key=lambda r:r.get('ended_at') or r['started_at']):
        key=(row['owner_id'],row.get('scenario_id'),row.get('stage'),row['transcript_hash'])
        if key not in seen:
            result.append(row);seen.add(key)
    return result


class Operations:
    def __init__(self,store,records):
        self.store,self.records=store,records

    def record(self,user,record_id):
        try: record=self.records.get(UUID(record_id))
        except ValueError: record=None
        if record is None or current_actor.get() and (record.get('owner_id') != user['id'] or record.get('workspace') != user['workspace']):
            raise HTTPException(404,'记录不存在。')
        return record

    def remediation_choice(self,user,item_id):
        with self.store.transaction(user['workspace'],write=False) as tx:
            item=require_item(tx,user['workspace'],'remediation',item_id)
        if item['status']!='assigned':
            raise HTTPException(403,'补练已关闭。')
        baseline = self.record(user, item['parent_record_id'])
        current = prepare_training(self.store, user, item['scenario_id'], item['stage'])
        expected = training_fingerprint(baseline.get('training'))
        if not expected or expected != training_fingerprint(snapshot(current)):
            raise HTTPException(409, '医生、场景或资料版本已变化，不能启动同条件重练。请基于新配置开始独立演练。')
        return {**item,'remediation_id':item['id'],
                'experience':baseline.get('experience') if baseline.get('experience') in ('practice','combat') else 'practice',
                'mode':baseline.get('mode') if baseline.get('mode') in ('assisted','independent') else 'assisted'}

    def finish_remediation(self,user,record):
        item_id=record.data.get('remediation_id')
        if not item_id or not record.data.get('activity',{}).get('valid'):return
        with self.store.transaction(user['workspace']) as tx:
            item=require_item(tx,user['workspace'],'remediation',item_id)
            tx.update(user['workspace'],'remediation',item_id,{**item,'status':'completed','completed_record_id':record.data['id']},item['version'])

    def reviews(self,user,record_id):
        record = self.record(user,record_id)
        workspace = record.get('workspace') or user['workspace']
        with self.store.transaction(workspace,write=False) as tx:
            return {'reviews':[r for r in tx.list(workspace,'review') if r['record_id']==record_id],
                    'responses':[r for r in tx.list(workspace,'review_response') if r['record_id']==record_id]}

    def review(self,user,record_id,body):
        record=self.record(user,record_id)
        user = {**user, 'workspace': record.get('workspace') or user['workspace']}
        if body.message_id and not any(m['id']==body.message_id for m in record['messages']):
            raise HTTPException(422,'点评的原话不存在。')
        rubric=record.get('training',{}).get('rubric',{})
        dimensions={d['key']:d for d in rubric.get('dimensions',[])}
        captured_documents = {}
        for document in record.get('training', {}).get('documents', []):
            captured_documents.setdefault(document['id'], document)
        documents, pages = {}, {}
        normalized = cache(normalize)
        with self.store.transaction(user['workspace']) as tx:
            if len({o.key for o in body.overrides})!=len(body.overrides):
                raise HTTPException(422,'调整维度不能重复。')
            for override in body.overrides:
                if override.key not in dimensions:raise HTTPException(422,'评价维度不属于本次量表。')
                if dimensions[override.key]['requires_content'] and override.score is not None:
                    if not override.citations:raise HTTPException(422,'医学评价调整需要审核资料的原文引用。')
                for citation in override.citations:
                    if citation.document_id not in documents:
                        doc=require_item(tx,user['workspace'],'content',citation.document_id)
                        documents[citation.document_id] = doc
                        for page in doc['pages']:
                            pages.setdefault((doc['id'], page['number']), page)
                    doc=documents[citation.document_id]
                    captured=captured_documents.get(doc['id'])
                    page=pages.get((doc['id'], citation.page))
                    if not captured or captured['version']!=doc['version'] or not content_usable(doc) or not page or normalized(citation.quote) not in normalized(page['text']):
                        raise HTTPException(422,'调整引用不属于本次有效资料或原文无法核对。')
            item=tx.create(user['workspace'],'review',{'record_id':record_id,'reviewer_id':user['id'],'action':'comment',**body.model_dump(mode='json')})
            tx.audit(user['workspace'],user['id'],'review.comment','review',item['id'],{'record_id':record_id})
            return item

    def remediation_progress(self,user,item_id):
        with self.store.transaction(user['workspace'],write=False) as tx:
            item=require_item(tx,user['workspace'],'remediation',item_id)
        rows=self.records.activity(**({'workspace':user['workspace'], 'owner_id':user['id']} if current_actor.get() else {}))
        baseline=next((r for r in rows if r['id']==item['parent_record_id']),None)
        children=distinct_valid([r for r in rows if r.get('remediation_id')==item_id])
        newest=max(children,key=lambda r:r.get('ended_at') or r['started_at']) if children else None
        comparisons=[]
        reasons = []
        if not baseline or not newest:
            reasons.append('尚无完整的原记录和有效重练结果。')
        else:
            if not baseline.get('valid'):
                reasons.append('原记录未形成有效评价。')
            if not baseline.get('training_fingerprint') or baseline['training_fingerprint'] != newest.get('training_fingerprint'):
                reasons.append('医生、场景或资料版本不同，或历史版本信息不完整。')
            if baseline['stage'] != newest['stage']:
                reasons.append('训练环节不同。')
            if baseline['experience'] != newest['experience']:
                reasons.append('演练模式不同。')
            if not all(baseline['assessment'].get(k) and baseline['assessment'][k] == newest['assessment'].get(k) for k in ('rubric_fingerprint','model','evaluator_version')):
                reasons.append('量表、模型或评价器版本不同。')
        same = not reasons
        if same:
            old={d['key']:d for d in baseline['assessment']['dimensions']}
            for d in newest['assessment']['dimensions']:
                before=old.get(d['key'],{}).get('score');after=d['score']
                comparisons.append({'key':d['key'],'label':d['label'],'before':before,'after':after,
                                    'delta':after-before if before is not None and after is not None else None})
        return {**item,'attempts':len(children),'latest_record_id':newest['id'] if newest else None,
                'comparable':same,'same_stage':bool(baseline and newest and baseline['stage']==newest['stage']),
                'comparison_reasons':reasons,
                'dimensions':comparisons}

    def retrain(self,user,record_id,body):
        record=self.record(user,record_id)
        if record.get('workspace') and record['workspace'] != user['workspace']:
            raise HTTPException(409, '该记录属于其他旧工作区，不能在当前资料库中建立重练。')
        training=record.get('training')
        if not training:raise HTTPException(409,'此记录未绑定场景，不能建立同版本重练。')
        stage=body.stage or training['stage']
        if stage not in STAGES:raise HTTPException(422,'环节无效。')
        prepared=prepare_training(self.store,user,training['scenario']['id'],stage)
        expected = training_fingerprint(training)
        if not expected or expected != training_fingerprint(snapshot(prepared)):
            raise HTTPException(409, '医生、场景或资料版本已变化，不能建立同条件重练。请基于新配置开始独立演练。')
        if prepared['rubric']['id']!=training['rubric']['id']:
            raise HTTPException(409,'评价版本已改变，不能作为同版本重练。')
        dimensions={d['key']:dict(d) for d in activity_record(record)['assessment']['dimensions']}
        for review in reversed(self.reviews(user,record_id)['reviews']):
            for change in review.get('overrides',[]):
                if change['key'] in dimensions:
                    dimensions[change['key']]['score']=change['score']
        scores=[d for d in dimensions.values() if d.get('score') is not None and d['score']<4]
        focus=min(scores,key=lambda d:d['score']) if scores else None
        with self.store.transaction(user['workspace']) as tx:
            item=tx.create(user['workspace'],'remediation',{'owner_id':user['id'],'workspace':user['workspace'],'team':record.get('team',''),
                'parent_record_id':record_id,'scenario_id':prepared['scenario']['id'],'stage':stage,'rubric_id':prepared['rubric']['id'],
                'focus_key':focus['key'] if focus else None,'focus_label':focus['label'] if focus else '证据与回应结构巩固',
                'note':body.note or ('围绕原记录的薄弱点重新练习，沿用同一评价量表。' if focus else '沿用同一评价量表巩固练习；未观察项不视为缺点。'),'status':'assigned','assigned_by':user['id']})
            tx.audit(user['workspace'],user['id'],'retrain.create','remediation',item['id'])
            return item
