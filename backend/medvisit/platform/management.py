"""Workspace controls and version-bound publication approvals."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from .input import Input
from .store import now
from ..core.identity import current_role

ReviewMode = Literal['admin', 'two_admins', 'medical_compliance']


class ReviewRules(Input):
    drug: ReviewMode = 'admin'
    doctor: ReviewMode = 'admin'
    content: ReviewMode = 'admin'
    scenario: ReviewMode = 'admin'
    lesson: ReviewMode = 'admin'


class WorkspaceSettings(Input):
    version: int = Field(ge=0)
    doctor_recommendation: bool = True
    training_scoring: bool = True
    health_sharing: bool = False
    review_rules: ReviewRules = Field(default_factory=ReviewRules)
    medical_reviewers: list[str] = Field(default_factory=list, max_length=100)
    compliance_reviewers: list[str] = Field(default_factory=list, max_length=100)


def workspace_settings(tx, tenant):
    row = tx.get(tenant, 'workspace_settings', 'admin')
    return {key:row[key] for key in WorkspaceSettings.model_fields} if row else WorkspaceSettings(version=0).model_dump()


def service_enabled(store, tenant, key):
    with store.transaction(tenant, write=False) as tx:
        return workspace_settings(tx, tenant)[key]


def approval_state(tx, tenant, kind, item):
    config = workspace_settings(tx, tenant)
    mode = config['review_rules'].get(kind, 'admin')
    key = f"{kind}:{item['id']}:{item['version']}:{config['version']}"
    entry = tx.get(tenant, 'publication_approval', key) or {'votes': []}
    votes = entry['votes']
    approved = [v for v in votes if v.get('decision', 'approve') == 'approve']
    rejected = any(v.get('decision') == 'reject' for v in votes)
    allowed = lambda vote, role: vote['role'] == role and vote['actor'] in config[f'{role}_reviewers']
    ready = not rejected and (mode == 'admin' or (mode == 'two_admins' and len({v['actor'] for v in approved}) >= 2) or (
        mode == 'medical_compliance' and any(allowed(a, 'medical') and allowed(b, 'compliance') and a['actor'] != b['actor'] for a in approved for b in approved)))
    return {'key': key, 'mode': mode, 'ready': ready, 'votes': votes, 'settings_version': config['version']}


def require_approval(tx, tenant, kind, item):
    state = approval_state(tx, tenant, kind, item)
    if not state['ready']:
        raise HTTPException(409, '本版本尚未满足发布审核规则，请先完成双人或医学/合规审核。')


class Approval(Input):
    version: int = Field(ge=1)
    settings_version: int = Field(ge=0)
    decision: Literal['approve', 'reject'] = 'approve'
    role: Literal['admin', 'medical', 'compliance']
    reason: str = Field(min_length=1, max_length=2000)


def management_router(store, settings, records, current_user):
    router = APIRouter(prefix='/admin')

    def admin(user=Depends(current_user)):
        if current_role.get() != 'admin':
            raise HTTPException(403, '仅管理员可访问。')
        return user

    def accounts(user):
        return sorted(settings.admin_users or ([settings.admin_username] if settings.auth_required else [user['id']]))

    @router.get('/settings')
    def get_settings(user=Depends(admin)):
        with store.transaction(user['workspace'], write=False) as tx:
            return {**workspace_settings(tx, user['workspace']), 'administrators': accounts(user)}

    @router.put('/settings')
    def save_settings(body: WorkspaceSettings, user=Depends(admin)):
        available = accounts(user)
        if any(name not in available for name in body.medical_reviewers + body.compliance_reviewers):
            raise HTTPException(422, '审核人必须为已配置的管理员账号。')
        modes = body.review_rules.model_dump().values()
        if 'two_admins' in modes and len(available) < 2:
            raise HTTPException(422, '双人审核需要至少两个管理员账号。')
        if 'medical_compliance' in modes and not any(a != b for a in body.medical_reviewers for b in body.compliance_reviewers):
            raise HTTPException(422, '医学与合规审核需分配不同的管理员。')
        with store.transaction(user['workspace']) as tx:
            old = workspace_settings(tx, user['workspace'])
            if old['version'] != body.version:
                raise HTTPException(409, '设置已更新，请刷新后重试。')
            data = body.model_dump(exclude={'version'})
            saved = tx.update(user['workspace'], 'workspace_settings', 'admin', data, body.version) if old['version'] else tx.create(user['workspace'], 'workspace_settings', data, item_id='admin')
            tx.audit(user['workspace'], user['id'], 'settings.update', 'workspace_settings', 'admin', {'version': saved['version']})
        return {**{key:saved[key] for key in WorkspaceSettings.model_fields}, 'administrators': available}

    @router.get('/versions')
    def versions(user=Depends(admin)):
        with store.transaction(user['workspace'], write=False) as tx:
            return [{'kind': kind, **{key: row.get(key) for key in ('id','name','title','display_name','version','version_label','status','updated_at','created_by','published_by','approved_by')}}
                    for kind in ('content','drug','doctor','rubric','scenario','policy','lesson') for row in tx.list(user['workspace'], kind) if row.get('status') not in ('deleted','archived')]

    @router.get('/catalog/{kind}/{item_id}/history')
    def history(kind: Literal['drug','doctor','content','policy','rubric','scenario','lesson'], item_id: str, user=Depends(admin)):
        from .catalog import require_item
        with store.transaction(user['workspace'], write=False) as tx:
            item = require_item(tx, user['workspace'], kind, item_id)
            series = item.get('series_id', item['id'])
            rows = [r for r in tx.list(user['workspace'], kind) if r['id'] == item_id or r.get('series_id', r['id']) == series or r.get(f'{kind}_id') == item_id]
            rows += [r for r in tx.list(user['workspace'], f'{kind}_history') if r.get(f'{kind}_id') == item_id]
            return rows

    @router.get('/catalog/{kind}/{item_id}/approval')
    def approval_get(kind: Literal['drug','doctor','content','scenario','lesson'], item_id: str, user=Depends(admin)):
        from .catalog import require_item
        with store.transaction(user['workspace'], write=False) as tx:
            return approval_state(tx, user['workspace'], kind, require_item(tx, user['workspace'], kind, item_id))

    @router.post('/catalog/{kind}/{item_id}/approval')
    def approve(kind: Literal['drug','doctor','content','scenario','lesson'], item_id: str, body: Approval, user=Depends(admin)):
        from .catalog import require_item
        with store.transaction(user['workspace']) as tx:
            item = require_item(tx, user['workspace'], kind, item_id)
            config = workspace_settings(tx, user['workspace'])
            if item['version'] != body.version or config['version'] != body.settings_version or item['status'] not in ('draft','submitted'):
                raise HTTPException(409, '内容或审核设置已更新，请刷新后重试。')
            if body.role != 'admin' and user['id'] not in config[f'{body.role}_reviewers']:
                raise HTTPException(403, '当前账号未分配此审核职责。')
            state = approval_state(tx, user['workspace'], kind, item)
            old = tx.get(user['workspace'], 'publication_approval', state['key'])
            votes = [v for v in state['votes'] if v['actor'] != user['id']]
            votes.append({'actor': user['id'], 'role': body.role, 'reason': body.reason, 'decision':body.decision, 'at': now()})
            if old:
                tx.update(user['workspace'], 'publication_approval', state['key'], {'votes': votes}, old['version'])
            else:
                tx.create(user['workspace'], 'publication_approval', {'votes': votes}, item_id=state['key'])
            tx.audit(user['workspace'], user['id'], 'publication.approve', kind, item_id, {'version':body.version, 'role':body.role})
            return approval_state(tx, user['workspace'], kind, item)

    @router.get('/audience-metrics')
    def metrics(user=Depends(admin)):
        rows = records.activity(workspace=user['workspace'])
        valid = [r for r in rows if r.get('valid') and isinstance((r.get('assessment') or {}).get('total'), (int,float))]
        dimensions = {}
        for row in valid:
            for d in row['assessment'].get('dimensions', []):
                if isinstance(d.get('score'), (int,float)):
                    bucket = dimensions.setdefault(d['key'], {'label':d['label'], 'values':[]})
                    bucket['values'].append(d['score'])
        with store.transaction(user['workspace']) as tx:
            tx.audit(user['workspace'], user['id'], 'audience.metrics', 'session', '*')
        return {'sessions':len(rows), 'participants':len({r['owner_id'] for r in rows if r.get('owner_id')}), 'scored_sessions':len(valid),
                'average_score':round(sum(r['assessment']['total'] for r in valid)/len(valid),1) if valid else None,
                'dimensions':[{'key':k,'label':v['label'],'average':round(sum(v['values'])/len(v['values']),2),'count':len(v['values'])} for k,v in dimensions.items()],
                'updated_at':now(), 'scope':'当前工作区全部有效评分记录；维度满分 4 分，不代表医学能力认证'}

    return router
