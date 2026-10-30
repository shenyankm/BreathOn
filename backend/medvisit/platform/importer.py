"""Atomic local JSON imports; repeated payloads reuse their original receipt."""
import hashlib
import json
from pydantic import Field
from .input import Input
from .catalog import require_item
from .models import Content


class Entry(Content):
    previous_id: str | None = Field(default=None,max_length=80)


class Batch(Input):
    documents: list[Entry] = Field(min_length=1,max_length=50)


def import_content(store,user,body):
    payload=body.model_dump(mode='json')
    digest=hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    with store.transaction(user['workspace']) as tx:
        receipt=tx.get(user['workspace'],'import_receipt',digest)
        if receipt:return {**receipt,'reused':True}
        ids=[]
        for data in payload['documents']:
            previous=data.pop('previous_id')
            old=require_item(tx,user['workspace'],'content',previous) if previous else None
            if data.get('asset_id'):require_item(tx,user['workspace'],'asset',data['asset_id'])
            item=tx.create(user['workspace'],'content',{**data,'status':'draft','created_by':user['id'],
                **({'previous_id':old['id'],'series_id':old.get('series_id',old['id'])} if old else {})})
            if not old:tx.update(user['workspace'],'content',item['id'],{**item,'series_id':item['id']},item['version'])
            ids.append(item['id'])
        receipt=tx.create(user['workspace'],'import_receipt',{'document_ids':ids,'created_by':user['id']},item_id=digest)
        tx.audit(user['workspace'],user['id'],'content.import','import_receipt',digest,{'count':len(ids)})
        return {**receipt,'reused':False}
