"""Reusable communication cases retain their original dialogue and source boundaries."""
import hashlib
import json

from fastapi import HTTPException
from pydantic import Field, field_validator

from .catalog import require_item
from .input import Input
from .models import content_usable
from .operations import Operations
from ..agents.web_search import public_url
from .evaluation import normalize


class CaseText(Input):
    title: str = Field(min_length=1, max_length=160)
    situation: str = Field(min_length=1, max_length=2000)
    approach: str = Field(min_length=1, max_length=2000)
    rationale: str = Field(min_length=1, max_length=2000)
    limitations: str = Field(min_length=1, max_length=2000)


class CaseEdit(CaseText):
    version: int = Field(ge=1)


class CaseFromRecord(Input):
    message_id: str = Field(min_length=1, max_length=80)


class PortableQuote(Input):
    role: str = Field(pattern=r'^(doctor|trainee)$')
    text: str = Field(min_length=1, max_length=4000)


class PortableSource(Input):
    title: str = Field(min_length=1, max_length=180)
    version_label: str = Field(min_length=1, max_length=40)
    source_url: str = Field(default='', max_length=8192)
    page: int = Field(ge=1, le=2000)
    quote: str = Field(min_length=6, max_length=500)

    @field_validator('source_url')
    @classmethod
    def safe_source(cls, value):
        if value and not public_url(value):
            raise ValueError('案例来源必须为公开 HTTP(S) 链接')
        return value


class PortableCase(CaseText):
    quotes: list[PortableQuote] = Field(max_length=2)
    sources: list[PortableSource] = Field(max_length=12)


class CaseImport(Input):
    schema_version: int = Field(ge=1, le=1)
    case: PortableCase


class Cases:
    def __init__(self, store, records):
        self.store, self.records = store, records

    def get(self, user, item_id):
        with self.store.transaction(user['workspace'], write=False) as tx:
            return require_item(tx, user['workspace'], 'case', item_id)

    def list(self, user):
        with self.store.transaction(user['workspace'], write=False) as tx:
            return tx.list(user['workspace'], 'case')

    def from_record(self, user, record_id, body):
        record = Operations(self.store, self.records).record(user, record_id)
        if record.get('workspace') and record['workspace'] != user['workspace']:
            raise HTTPException(409, '请先导出旧工作区案例，再作为外来素材导入核对。')
        messages = record['messages']
        index = next((index for index, message in enumerate(messages) if message['id'] == body.message_id), None)
        if index is None or messages[index]['role'] != 'trainee' or not messages[index].get('final') or not messages[index]['text'].strip() or len(messages[index]['text']) > 4000:
            raise HTTPException(422, '请选择一条完整的学员原话。')
        selected = messages[index]
        doctor = next((message for message in reversed(messages[:index]) if message['role'] == 'doctor' and message.get('final')), None)
        coaching = next((item for item in reversed(record.get('coaching', [])) if item.get('final_report')), {})
        training = record.get('training') or {}
        assessment = coaching.get('assessment', {})
        relevant = [dimension for dimension in assessment.get('dimensions', [])
                    if any(quote.get('message_id') == selected['id'] for quote in dimension.get('utterances', []))]
        citations = []
        for dimension in relevant:
            for citation in dimension.get('citations', []):
                if citation not in citations and len(citations) < 12:
                    citations.append(citation)
        draft = CaseText(title=(training.get('scenario', {}).get('title') or '拜访沟通')[:150]+'：回应案例',
            situation=doctor['text'][:2000] if doctor else '根据原记录补充拜访背景与医生关注点。',
            approach=selected['text'] if len(selected['text'])<=2000 else '请结合完整原话，提炼希望复用的回应方式。',
            rationale=('\n'.join(dimension['reason'] for dimension in relevant if dimension.get('reason')) or '请结合原话填写处理理由。')[:2000],
            limitations=(coaching.get('risk') or '仅供模拟沟通训练；参考表达尚不证明实际拜访有效，不作为独立医学证据。')[:2000])
        with self.store.transaction(user['workspace']) as tx:
            item = tx.create(user['workspace'], 'case', {**draft.model_dump(), 'status':'draft', 'created_by':user['id'],
                'origin_record_id':record_id, 'origin_verified':True,
                'quotes':[{'role':message['role'], 'text':message['text']} for message in ([doctor] if doctor else [])+[selected]],
                'documents':training.get('documents', []), 'citations':citations})
            tx.audit(user['workspace'], user['id'], 'case.extract', 'case', item['id'], {'record_id':record_id})
            return item

    def edit(self, user, item_id, body):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], 'case', item_id)
            item = tx.update(user['workspace'], 'case', item_id,
                {**old, **body.model_dump(exclude={'version'}), 'status':'draft'}, body.version)
            tx.audit(user['workspace'], user['id'], 'case.edit', 'case', item_id)
            return item

    def validate_sources(self, tx, user, item):
        documents = {}
        for captured in item.get('documents', []):
            document = require_item(tx, user['workspace'], 'content', captured['id'])
            documents[document['id']] = document
            digest = hashlib.sha256(json.dumps(document['pages'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            if not content_usable(document) or document['version'] != captured['version'] or digest != captured.get('sha256'):
                raise HTTPException(409, '案例原始资料已改变、停用或过期，请重新核对有效资料后建立案例。')
        for citation in item.get('citations', []):
            document = documents.get(citation['document_id'])
            if document is None:
                document = require_item(tx, user['workspace'], 'content', citation['document_id'])
                documents[document['id']] = document
            page = next((page for page in document['pages'] if page['number'] == citation['page']), None)
            if not any(captured['id'] == document['id'] and captured['version'] == citation['document_version'] for captured in item.get('documents', [])) or not page or normalize(citation['quote']) not in normalize(page['text']):
                raise HTTPException(422, '案例引文无法与原训练资料核对。')

    def confirm(self, user, item_id, version):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], 'case', item_id)
            if old['status'] != 'draft':
                raise HTTPException(409, '案例已经确认；修改后需重新确认。')
            self.validate_sources(tx, user, old)
            item = tx.update(user['workspace'], 'case', item_id, {**old, 'status':'confirmed', 'confirmed_by':user['id']}, version)
            tx.audit(user['workspace'], user['id'], 'case.confirm', 'case', item_id)
            return item

    def for_generation(self, user, item_id):
        with self.store.transaction(user['workspace'], write=False) as tx:
            item = require_item(tx, user['workspace'], 'case', item_id)
            if item['status'] != 'confirmed':
                raise HTTPException(409, '案例需先编辑核对并确认，才能复用。')
            self.validate_sources(tx, user, item)
            return item

    def export(self, user, item_id):
        item = self.get(user, item_id)
        sources = item.get('external_sources', []) or [{key:citation.get(key, '') for key in PortableSource.model_fields} for citation in item.get('citations', [])]
        return CaseImport(schema_version=1, case=PortableCase(**{key:item[key] for key in CaseText.model_fields}, quotes=item['quotes'], sources=sources)).model_dump(mode='json')

    def import_case(self, user, body):
        data = body.case.model_dump(mode='json')
        digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.store.transaction(user['workspace']) as tx:
            existing = next((item for item in tx.list(user['workspace'], 'case') if item.get('import_sha256') == digest), None)
            if existing:
                return {**existing, 'reused':True}
            item = tx.create(user['workspace'], 'case', {**{key:data[key] for key in CaseText.model_fields},
                'quotes':data['quotes'], 'external_sources':data['sources'], 'documents':[], 'citations':[],
                'status':'draft', 'created_by':user['id'], 'origin_verified':False, 'import_sha256':digest})
            tx.audit(user['workspace'], user['id'], 'case.import', 'case', item['id'])
            return item
