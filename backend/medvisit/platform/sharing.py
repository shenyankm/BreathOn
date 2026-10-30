"""Portable training configurations import atomically as unreviewed drafts."""
import hashlib
import json
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import Field, ValidationError, model_validator

from .input import Input
from .models import Content, Doctor, Rubric, Scenario
from .training import prepare_training


class TemplateDocument(Content):
    key: str = Field(min_length=1, max_length=80)
    asset_id: Literal[None] = None


class TrainingTemplate(Input):
    schema_version: Literal[1]
    doctor: Doctor
    rubric: Rubric
    documents: list[TemplateDocument] = Field(max_length=12)
    scenario: Scenario

    @model_validator(mode='after')
    def bindings_valid(self):
        keys = [document.key for document in self.documents]
        if len(keys) != len(set(keys)) or set(keys) != set(self.scenario.content_ids):
            raise ValueError('场景资料绑定必须与模板中的资料一一对应')
        if len(self.model_dump_json().encode()) > 7_500_000:
            raise ValueError('场景模板超过7.5MB，请减少绑定资料')
        return self


def export_template(store, user, scene_id):
    training = prepare_training(store, user, scene_id, preview=True)
    def fields(model, item):
        return {key:item[key] for key in model.model_fields if key in item}
    scene = {**fields(Scenario, training['scenario']), 'doctor_id':training['doctor']['id'],
             'rubric_id':training['rubric']['id'], 'content_ids':[document['id'] for document in training['documents']]}
    try:
        return TrainingTemplate(schema_version=1, doctor=Doctor(**fields(Doctor, training['doctor'])),
            rubric=Rubric(**fields(Rubric, training['rubric'])), scenario=Scenario(**scene),
            documents=[TemplateDocument(**{**fields(Content, document), 'asset_id':None}, key=document['id']) for document in training['documents']]).model_dump(mode='json')
    except ValidationError as exc:
        raise HTTPException(422, '场景内容不符合分享格式或超过7.5MB，请减少资料后重试。') from exc


def import_template(store, user, body):
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    with store.transaction(user['workspace']) as tx:
        receipt = tx.get(user['workspace'], 'template_receipt', digest)
        if receipt:
            return {**receipt, 'reused':True}
        doctor = tx.create(user['workspace'], 'doctor', {**body.doctor.model_dump(mode='json'),
            'display_name':body.doctor.name+'（训练模拟）','status':'draft','created_by':user['id'],'imported':True})
        rubric = tx.create(user['workspace'], 'rubric', {**body.rubric.model_dump(mode='json'),
            'status':'draft','calibration_status':'uncalibrated','created_by':user['id'],'imported':True})
        documents = {}
        for document in body.documents:
            item_id = str(uuid4())
            item = tx.create(user['workspace'], 'content', {**document.model_dump(mode='json', exclude={'key'}),
                'status':'draft','created_by':user['id'],'series_id':item_id,'imported':True}, item_id=item_id)
            documents[document.key] = item['id']
        scene = tx.create(user['workspace'], 'scenario', {**body.scenario.model_dump(mode='json'),
            'doctor_id':doctor['id'],'rubric_id':rubric['id'],'content_ids':[documents[key] for key in body.scenario.content_ids],
            'status':'draft','created_by':user['id'],'imported':True})
        receipt = tx.create(user['workspace'], 'template_receipt', {'scenario_id':scene['id'],'doctor_id':doctor['id'],
            'rubric_id':rubric['id'],'document_ids':list(documents.values()),'created_by':user['id']}, item_id=digest)
        tx.audit(user['workspace'], user['id'], 'scenario.import', 'scenario', scene['id'])
        return {**receipt, 'reused':False}
