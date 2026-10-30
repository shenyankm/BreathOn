"""Versioned training catalogue; approval never comes from a language model."""
from datetime import datetime, timezone
from fastapi import HTTPException
from .models import content_usable
from .store import now
from ..agents.doctor import DOCTOR_PROFILE, OPENING

DEFAULT_ANCHORS = {
    'accuracy': ('存在关键事实错误或不安全保证', '核心事实多处不清或混淆', '主要事实正确但重要局限遗漏', '事实准确且说明主要局限', '事实、适用范围与不确定性均准确完整'),
    'evidence': ('无依据或编造来源', '引用不能支持结论', '提供来源但人群或终点关联不完整', '证据与主张对应且说明局限', '清楚区分证据层级、适用范围和不能推断之处'),
    'needs': ('忽略医生问题或拒绝', '泛泛介绍且未回应重点', '部分回应关注点', '直接回应并确认需求', '围绕需求取舍信息且尊重明确的时间或拒绝'),
    'expression': ('表达矛盾难以理解', '逻辑跳跃且关键概念混乱', '基本清楚但结构有缺口', '结构清楚、措辞审慎', '简洁连贯，信息层次清楚并自然承接'),
    'compliance': ('存在利益交换、信息泄露或明确违规承诺', '出现高风险措辞且未纠正', '措辞基本合规但核实安排不清', '识别风险并给出合规跟进', '主动界定角色、证据和授权渠道且尊重对方决定'),
}


def require_item(tx, tenant, kind, item_id):
    item = tx.get(tenant, kind, item_id)
    if item is None or item.get('status') == 'deleted':
        raise HTTPException(404, '记录不存在或不属于当前工作区。')
    return item



class Catalog:
    def __init__(self, store):
        self.store = store

    def seed(self, tenant, actor):
        with self.store.transaction(tenant) as tx:
            if not tx.get(tenant, 'doctor', 'li-xiaoying'):
                tx.create(tenant, 'doctor', {
                    'name': '李小英', 'display_name': DOCTOR_PROFILE['display_name'], 'specialty': '内分泌科',
                    'background_type': 'public', 'public_facts': DOCTOR_PROFILE['details'][0][1] + DOCTOR_PROFILE['details'][1][1],
                    'sources': [s['url'] for s in DOCTOR_PROFILE['sources']], 'population': '成人超重、肥胖及相关代谢疾病训练人群',
                    'focus': '人群适用性、肝脏与糖代谢终点、临床证据局限', 'training_style': '围绕原话，每次追问一个关键点',
                    'mood': 'neutral', 'opening': OPENING, 'status': 'published', 'created_by': actor,
                }, item_id='li-xiaoying')
            if not tx.get(tenant, 'rubric', 'academic-visit-v1'):
                names = ['医学准确性', '证据运用', '需求识别', '表达逻辑', '合规沟通']
                tx.create(tenant, 'rubric', {'name': '学术拜访评价 v1', 'status': 'draft', 'created_by': actor,
                    'dimensions': [dict(key=key, label=label, weight=20, anchors=list(anchors), requires_content=key in ('accuracy','evidence'))
                                   for (key, anchors), label in zip(DEFAULT_ANCHORS.items(), names)],
                    'calibration_status': 'uncalibrated'}, item_id='academic-visit-v1')

    def list(self, user, kind):
        with self.store.transaction(user['workspace'], write=False) as tx:
            rows = [row for row in tx.list(user['workspace'], kind) if row.get('status') != 'deleted']
        if kind == 'content':
            return [{**{k: v for k,v in r.items() if k != 'pages'}, 'usable':content_usable(r)} for r in rows]
        return rows

    def get(self, user, kind, item_id):
        with self.store.transaction(user['workspace'], write=False) as tx:
            item = require_item(tx, user['workspace'], kind, item_id)
        return item

    def create(self, user, kind, body):
        data = {**body.model_dump(mode='json'), 'status': 'draft', 'created_by': user['id']}
        if kind == 'doctor':
            data['display_name'] = data['name'] + '（训练模拟）'
        if kind == 'rubric':
            data['calibration_status'] = 'uncalibrated'
        with self.store.transaction(user['workspace']) as tx:
            if kind == 'content' and data.get('asset_id'):
                require_item(tx, user['workspace'], 'asset', data['asset_id'])
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], data, publishing=False)
            item = tx.create(user['workspace'], kind, data)
            if kind == 'content':
                item = tx.update(user['workspace'], kind, item['id'], {**item, 'series_id': item['id']}, item['version'])
            tx.audit(user['workspace'], user['id'], f'{kind}.create', kind, item['id'])
            return item

    def edit(self, user, kind, item_id, body):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if kind != 'doctor' and old['status'] not in (('draft', 'rejected') if kind == 'content' else ('draft',)):
                raise HTTPException(409, '只能编辑草稿；已发布内容请创建新版本。')
            data = body.model_dump(mode='json', exclude={'version'})
            if kind == 'content' and data.get('asset_id'):
                require_item(tx, user['workspace'], 'asset', data['asset_id'])
            if kind == 'doctor':
                data['display_name'] = data['name'] + '（训练模拟）'
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], data, publishing=False)
            updated = tx.update(user['workspace'], kind, item_id, {**old, **data, 'status': old['status'] if kind == 'doctor' else 'draft'}, body.version)
            tx.audit(user['workspace'], user['id'], f'{kind}.edit', kind, item_id)
            return updated

    def revision(self, user, kind, item_id):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if kind == 'doctor':
                raise HTTPException(409, '医生资料直接编辑保存，不创建新版本。')
            data = {k: v for k,v in old.items() if k not in ('id','version','created_at','updated_at','approved_by','approved_at','review_reason')}
            data.update(status='draft', created_by=user['id'], previous_id=old['id'], series_id=old.get('series_id',old['id']))
            if kind == 'rubric':
                data['calibration_status'] = 'uncalibrated'
            item = tx.create(user['workspace'], kind, data)
            tx.audit(user['workspace'], user['id'], f'{kind}.revision', kind, item['id'], {'previous_id': item_id})
            return item

    def delete_doctor(self, user, item_id, version):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], 'doctor', item_id)
            if any(scene['doctor_id'] == item_id for scene in tx.list(user['workspace'], 'scenario')):
                raise HTTPException(409, '医生仍被训练场景使用，请先更换场景中的医生。')
            # Keep a tombstone so startup seeding cannot recreate a deleted default doctor.
            tx.update(user['workspace'], 'doctor', item_id, {**old, 'status': 'deleted'}, version)
            tx.audit(user['workspace'], user['id'], 'doctor.delete', 'doctor', item_id)
            return {'id': item_id}

    def review(self, user, item_id, body):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], 'content', item_id)
            action, status = body.action, old['status']
            if action == 'submit':
                if status not in ('draft', 'rejected'):
                    raise HTTPException(409, '只有草稿或被退回的资料可提交。')
                next_status = 'submitted'
            elif action in ('approve', 'reject'):
                if status != 'submitted':
                    raise HTTPException(409, '只能审核已提交的资料。')
                if action == 'approve' and old.get('expires_at') and datetime.fromisoformat(old['expires_at']) <= datetime.now(timezone.utc):
                    raise HTTPException(409, '资料已过期，不能审核通过。')
                next_status = 'approved' if action == 'approve' else 'rejected'
            else:
                if status != 'approved':
                    raise HTTPException(409, '只能停用已审核资料。')
                next_status = 'retired'
            updated = {**old, 'status': next_status, 'review_reason': body.reason}
            if action == 'approve':
                updated.update(approved_by=user['id'], approved_at=now())
            item = tx.update(user['workspace'], 'content', item_id, updated, body.version)
            tx.audit(user['workspace'], user['id'], f'content.{action}', 'content', item_id, {'reason': body.reason})
            return item

    def validate_bindings(self, tx, tenant, data, publishing):
        for kind, item_id in [('doctor',data['doctor_id']),('rubric',data['rubric_id'])]:
            item = require_item(tx, tenant, kind, item_id)
            if publishing and item['status'] != 'published':
                raise HTTPException(409, '场景绑定的医生和量表必须先发布。')
        for item_id in data['content_ids']:
            item = require_item(tx, tenant, 'content', item_id)
            if publishing and not content_usable(item):
                raise HTTPException(409, '场景包含未审核、过期或停用资料。')

    def publish(self, user, kind, item_id, version):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if old['status'] != 'draft':
                raise HTTPException(409, '只能发布草稿。')
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], old, publishing=True)
            item = tx.update(user['workspace'], kind, item_id, {**old,'status':'published','published_by':user['id'],'published_at':now()}, version)
            tx.audit(user['workspace'], user['id'], f'{kind}.publish', kind, item_id)
            return item

