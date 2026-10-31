"""Explicitly consented, manually entered observations; no device or efficacy inference."""
from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, field_validator
from .input import Input
from .management import workspace_settings
from .store import now
from ..core.identity import current_role


class Observation(Input):
    metric: str = Field(min_length=1, max_length=100)
    value: float = Field(allow_inf_nan=False, ge=0, le=1000000)
    unit: str = Field(min_length=1, max_length=40)
    observed_at: datetime
    conditions: str = Field(min_length=1, max_length=1000)
    limitations: str = Field(min_length=1, max_length=1000)

    @field_validator('observed_at')
    @classmethod
    def past(cls, value):
        if value.tzinfo is None or value > datetime.now(timezone.utc):
            raise ValueError('观察时间须带时区且不得晚于当前时间')
        return value


class Consent(Input):
    version: int = Field(ge=1)
    consent: Literal[True]


class Version(Input):
    version: int = Field(ge=1)


class HealthReview(Version):
    decision: Literal['approve', 'reject']
    reason: str = Field(min_length=1, max_length=2000)


def health_router(store, current_user):
    router = APIRouter()

    def admin(user=Depends(current_user)):
        if current_role.get() != 'admin':
            raise HTTPException(403, '仅管理员可审核。')
        return user

    def own(tx, user, item_id):
        row = tx.get(user['workspace'], 'health_observation', item_id)
        if not row or row['owner_id'] != user['id']:
            raise HTTPException(404, '观察记录不存在。')
        return row

    @router.get('/health/observations')
    def mine(user=Depends(current_user)):
        with store.transaction(user['workspace'], write=False) as tx:
            return [row for row in tx.list(user['workspace'], 'health_observation') if row['owner_id'] == user['id']]

    @router.post('/health/observations', status_code=201)
    def create(body: Observation, user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            row = tx.create(user['workspace'], 'health_observation', {**body.model_dump(mode='json'), 'owner_id':user['id'], 'status':'private', 'consent':False, 'source':'manual'})
            tx.audit(user['workspace'], user['id'], 'health.create', 'health_observation', row['id'])
            return row

    @router.post('/health/observations/{item_id}/consent')
    def consent(item_id: str, body: Consent, user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            old = own(tx, user, item_id)
            if not workspace_settings(tx, user['workspace'])['health_sharing']:
                raise HTTPException(409, '工作区尚未开启共享，个人记录仍可保存和撤回。')
            if old['status'] not in ('private','revoked','rejected'):
                raise HTTPException(409, '记录已提交，请刷新查看状态。')
            row = tx.update(user['workspace'], 'health_observation', item_id, {**old, 'consent':True,'consented_at':now(),'status':'submitted','reviewed_by':None,'review_reason':None}, body.version)
            tx.audit(user['workspace'], user['id'], 'health.consent', 'health_observation', item_id)
            return row

    @router.post('/health/observations/{item_id}/revoke')
    def revoke(item_id: str, body: Version, user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            old = own(tx, user, item_id)
            # Withdrawal wins over a concurrent review; only the owner can reduce consent.
            row = tx.update(user['workspace'], 'health_observation', item_id, {**old,'consent':False,'status':'revoked','revoked_at':now()}, old['version'])
            tx.audit(user['workspace'], user['id'], 'health.revoke', 'health_observation', item_id)
            return row

    @router.get('/admin/health/observations')
    def queue(user=Depends(admin)):
        with store.transaction(user['workspace']) as tx:
            tx.audit(user['workspace'], user['id'], 'health.review_list', 'health_observation', '*')
            return [row for row in tx.list(user['workspace'], 'health_observation') if row['consent'] and row['status'] in ('submitted','approved')]

    @router.post('/admin/health/observations/{item_id}/review')
    def review(item_id: str, body: HealthReview, user=Depends(admin)):
        with store.transaction(user['workspace']) as tx:
            old = tx.get(user['workspace'], 'health_observation', item_id)
            if not old or not old['consent'] or old['status'] != 'submitted':
                raise HTTPException(409, '记录已变更或授权已撤回，请刷新。')
            if old['owner_id'] == user['id']:
                raise HTTPException(403, '请由另一位管理员审核本人提交的记录。')
            row = tx.update(user['workspace'], 'health_observation', item_id, {**old, 'status':'approved' if body.decision == 'approve' else 'rejected', 'reviewed_by':user['id'], 'reviewed_at':now(), 'review_reason':body.reason}, body.version)
            tx.audit(user['workspace'], user['id'], 'health.'+body.decision, 'health_observation', item_id)
            return row

    @router.get('/health/shared')
    def shared(user=Depends(current_user)):
        with store.transaction(user['workspace']) as tx:
            enabled = workspace_settings(tx, user['workspace'])['health_sharing']
            rows = tx.list(user['workspace'], 'health_observation') if enabled else []
            tx.audit(user['workspace'], user['id'], 'health.shared_list', 'health_observation', '*')
            return {'enabled':enabled, 'items':[{key:row.get(key) for key in ('id','metric','value','unit','observed_at','conditions','limitations','source','reviewed_at')}
                    for row in rows if row['consent'] and row['status'] == 'approved']}

    return router
