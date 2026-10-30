"""Audited administrator access to training records across the shared workspace."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from ..core.identity import current_role


def admin_records_router(records, platform, current_user):
    router = APIRouter(prefix='/api/admin/sessions')

    def admin(user=Depends(current_user)):
        if current_role.get() != 'admin':
            raise HTTPException(403, '无权访问。')
        return user

    @router.get('')
    def list_sessions(user=Depends(admin)):
        rows = records.list(workspace=user['workspace'], limit=None, include_owner=True)
        with platform.transaction(user['workspace']) as tx:
            tx.audit(user['workspace'], user['id'], 'session.list', 'session', '*')
        return rows

    @router.get('/{session_id}')
    def get_session(session_id: UUID, user=Depends(admin)):
        record = records.get(session_id)
        if not record or record.get('workspace') != user['workspace']:
            raise HTTPException(404, '记录不存在。')
        with platform.transaction(user['workspace']) as tx:
            tx.audit(user['workspace'], user['id'], 'session.read', 'session', str(session_id))
        return record

    return router
