"""Versioned training catalogue; approval never comes from a language model."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from .models import Doctor, Drug, Policy, content_usable, policy_usable
from .store import now
from .departments import with_departments, require_department_match
from ..agents.doctor import DOCTOR_PROFILE, OPENING

DEFAULT_ANCHORS = {
    'accuracy': ('存在关键事实错误或不安全保证', '核心事实多处不清或混淆', '主要事实正确但重要局限遗漏', '事实准确且说明主要局限', '事实、适用范围与不确定性均准确完整'),
    'evidence': ('无依据或编造来源', '引用不能支持结论', '提供来源但人群或终点关联不完整', '证据与主张对应且说明局限', '清楚区分证据层级、适用范围和不能推断之处'),
    'needs': ('忽略医生问题或拒绝', '泛泛介绍且未回应重点', '部分回应关注点', '直接回应并确认需求', '围绕需求取舍信息且尊重明确的时间或拒绝'),
    'expression': ('表达矛盾难以理解', '逻辑跳跃且关键概念混乱', '基本清楚但结构有缺口', '结构清楚、措辞审慎', '简洁连贯，信息层次清楚并自然承接'),
    'compliance': ('存在利益交换、信息泄露或明确违规承诺', '出现高风险措辞且未纠正', '措辞基本合规但核实安排不清', '识别风险并给出合规跟进', '主动界定角色、证据和授权渠道且尊重对方决定'),
}

TAXONOMY_FIELDS = {'category': 'category', 'disease': 'diseases', 'mechanism': 'mechanism',
                   'dosage_form': 'dosage_form', 'region': 'regions'}


def drug_terms(drug, field):
    value = drug.get(field, [] if field in ('diseases', 'regions') else '')
    return value if isinstance(value, list) else [value] if value else []


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
            profiles = json.loads(Path(__file__).with_name('doctor_profiles.json').read_text())
            for row in profiles['doctors']:
                if not tx.get(tenant, 'doctor', row['id']):
                    doctor = Doctor.model_validate(row['profile'])
                    tx.create(tenant, 'doctor', {**doctor.model_dump(mode='json'),
                        'display_name':doctor.name + '（训练模拟）', 'status':'published', 'created_by':actor,
                        'imported_from':f"{profiles['agent']} {profiles['checked_at']}"}, item_id=row['id'])
            if not tx.get(tenant, 'rubric', 'academic-visit-v1'):
                names = ['医学准确性', '证据运用', '需求识别', '表达逻辑', '合规沟通']
                tx.create(tenant, 'rubric', {'name': '学术拜访评价 v1', 'status': 'draft', 'created_by': actor,
                    'dimensions': [dict(key=key, label=label, weight=20, anchors=list(anchors), requires_content=key in ('accuracy','evidence'))
                                   for (key, anchors), label in zip(DEFAULT_ANCHORS.items(), names)],
                    'calibration_status': 'uncalibrated'}, item_id='academic-visit-v1')
            seed = json.loads(Path(__file__).with_name('catalog_seed.json').read_text())
            for row in seed['drugs']:
                item_id = 'seed-drug-' + row['id']
                if not tx.get(tenant, 'drug', item_id):
                    drug = Drug(name=row['name'], brand=row['brand'], category=row['category'],
                        mechanism=row['target'], overview=row['overview'], source_url=row['document']['url'])
                    tx.create(tenant, 'drug', {**drug.model_dump(mode='json'), 'status':'draft', 'created_by':actor,
                        'imported_from':'frontend catalogue 2026-10-29'}, item_id=item_id)
            for row in seed['policies']:
                item_id = 'seed-policy-' + hashlib.sha256(row['url'].encode()).hexdigest()[:24]
                if not tx.get(tenant, 'policy', item_id):
                    policy = Policy(title=row['title'], version_label='待核验', scope=row['scope'], source_url=row['url'],
                        pages=[{'number':1, 'text':'目录摘要，非政策原文：'+row['summary']}], text_is_summary=True,
                        issuer=row['source'], level=row['level'], legal_status='unknown')
                    tx.create(tenant, 'policy', {**policy.model_dump(mode='json'), 'status':'draft', 'created_by':actor,
                        'series_id':item_id, 'imported_from':'frontend catalogue 2026-10-28'}, item_id=item_id)
            drugs = tx.list(tenant, 'drug')
            for kind, field in TAXONOMY_FIELDS.items():
                item = tx.get(tenant, 'taxonomy', kind)
                values = {value for drug in drugs for value in drug_terms(drug, field)}
                if item is None:
                    tx.create(tenant, 'taxonomy', {'kind':kind, 'terms':[{'value':value, 'status':'pending'} for value in sorted(values)]}, item_id=kind)
                else:
                    known = {term['value'] for term in item['terms']}
                    missing = values - known
                    if missing:
                        tx.update(tenant, 'taxonomy', kind, {**item, 'terms':item['terms'] + [{'value':value, 'status':'pending'} for value in sorted(missing)]}, item['version'])

    def taxonomy(self, user):
        with self.store.transaction(user['workspace'], write=False) as tx:
            return tx.list(user['workspace'], 'taxonomy')

    def update_taxonomy(self, user, kind, body):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], 'taxonomy', kind)
            terms = [term.model_dump() for term in body.terms]
            active = {term['value'] for term in terms if term['status'] == 'active'}
            removed = {term['value'] for term in old['terms'] if term['status'] == 'active'} - active
            deleted = {term['value'] for term in old['terms']} - {term['value'] for term in terms}
            field = TAXONOMY_FIELDS[kind]
            for drug in tx.list(user['workspace'], 'drug'):
                if set(drug_terms(drug, field)) & deleted:
                    raise HTTPException(409, '药品仍引用此分类，请先修改相关药品。')
                if drug.get('status') == 'published' and set(drug_terms(drug, field)) & removed:
                    raise HTTPException(409, '已发布药品仍使用此分类，请先修改或停用相关药品。')
            updated = tx.update(user['workspace'], 'taxonomy', kind, {**old, 'terms':terms}, body.version)
            tx.audit(user['workspace'], user['id'], 'taxonomy.edit', 'taxonomy', kind)
            return updated

    def validate_drug_terms(self, tx, tenant, data, old=None, *, publishing=False):
        for kind, field in TAXONOMY_FIELDS.items():
            taxonomy = require_item(tx, tenant, 'taxonomy', kind)
            active = {term['value'] for term in taxonomy['terms'] if term['status'] == 'active'}
            previous = set(drug_terms(old or {}, field)) if not publishing else set()
            if not set(drug_terms(data, field)) <= active | previous:
                raise HTTPException(422, '药品分类须选择已启用的词条；原有待核验词条可保留至审核。')

    def list(self, user, kind):
        with self.store.transaction(user['workspace'], write=False) as tx:
            rows = [row for row in tx.list(user['workspace'], kind) if row.get('status') != 'deleted']
        if kind in ('content', 'policy'):
            usable = policy_usable if kind == 'policy' else content_usable
            return [{**{k: v for k,v in r.items() if k != 'pages'}, 'usable':usable(r)} for r in rows]
        return [with_departments(kind, row) for row in rows]

    def get(self, user, kind, item_id):
        with self.store.transaction(user['workspace'], write=False) as tx:
            item = require_item(tx, user['workspace'], kind, item_id)
        return with_departments(kind, item)

    def create(self, user, kind, body):
        data = {**body.model_dump(mode='json'), 'status': 'draft', 'created_by': user['id']}
        if kind == 'doctor':
            data['display_name'] = data['name'] + '（训练模拟）'
        if kind == 'rubric':
            data['calibration_status'] = 'uncalibrated'
        with self.store.transaction(user['workspace']) as tx:
            research = None
            if kind == 'doctor' and data.get('research_job_id'):
                research = require_item(tx, user['workspace'], 'research_job', data['research_job_id'])
                if research.get('doctor_id'):
                    raise HTTPException(409, '本次画像草稿已保存，请打开已有医生角色继续编辑。')
                if research.get('kind') != 'doctor' or research.get('status') not in ('completed', 'partial') or not research.get('doctor_draft'):
                    raise HTTPException(409, '本次检索尚无可保存的医生画像草稿。')
            if research:
                data.update(research_evidence=research.get('doctor_evidence', []),
                    identity_confirmed_by=user['id'], identity_confirmed_at=now(),
                    research_evidence_review_required=any(data.get(key) != research['doctor_draft'].get(key)
                        for key in ('name', 'hospital', 'professional_title', 'specialty', 'public_facts', 'sources')))
            if kind in ('content', 'policy') and data.get('asset_id'):
                require_item(tx, user['workspace'], 'asset', data['asset_id'])
            if kind == 'drug':
                self.validate_drug_terms(tx, user['workspace'], data)
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], data, publishing=False)
            item = tx.create(user['workspace'], kind, data)
            if research:
                tx.update(user['workspace'], 'research_job', research['id'], {**research, 'doctor_id':item['id']}, research['version'])
            if kind in ('content', 'policy'):
                item = tx.update(user['workspace'], kind, item['id'], {**item, 'series_id': item['id']}, item['version'])
            tx.audit(user['workspace'], user['id'], f'{kind}.create', kind, item['id'])
            return item

    def edit(self, user, kind, item_id, body):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if old['status'] not in (('draft', 'rejected') if kind in ('content', 'policy') else ('draft',)):
                raise HTTPException(409, '只能编辑草稿；已发布内容请创建新版本。')
            data = body.model_dump(mode='json', exclude={'version'})
            if kind == 'policy' and old.get('text_is_summary') and not data.get('text_is_summary') and data['pages'] == old.get('pages'):
                raise HTTPException(409, '请先将目录摘要替换为政策原文。')
            if kind in ('content', 'policy') and data.get('asset_id'):
                require_item(tx, user['workspace'], 'asset', data['asset_id'])
            if kind == 'doctor':
                data['display_name'] = data['name'] + '（训练模拟）'
                data['research_job_id'] = old.get('research_job_id')
                if old.get('research_evidence') and any(old.get(key) != data.get(key) for key in ('name', 'hospital', 'professional_title', 'specialty', 'public_facts', 'sources')):
                    data['research_evidence_review_required'] = True
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], data, publishing=False)
            if kind == 'drug':
                self.validate_drug_terms(tx, user['workspace'], data, old)
            updated = tx.update(user['workspace'], kind, item_id, {**old, **data, 'status': 'draft'}, body.version)
            tx.audit(user['workspace'], user['id'], f'{kind}.edit', kind, item_id)
            return updated

    def revision(self, user, kind, item_id):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if kind == 'doctor' and (old['status'] != 'published' or old.get('doctor_id')):
                raise HTTPException(409, '只能为已发布的医生创建新草稿。')
            if kind == 'drug' and (old['status'] != 'published' or old.get('drug_id')):
                raise HTTPException(409, '只能为已发布的药品创建新草稿。')
            data = {k: v for k,v in old.items() if k not in ('id','version','created_at','updated_at','approved_by','approved_at','review_reason')}
            data.update(status='draft', created_by=user['id'], previous_id=old['id'], series_id=old.get('series_id',old['id']))
            if kind in ('doctor', 'drug'):
                data.update({f'{kind}_id': old['id'], 'base_version': old['version']})
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
            if old.get('research_job_id'):
                research = tx.get(user['workspace'], 'research_job', old['research_job_id'])
                if research and research.get('doctor_id') == item_id:
                    tx.update(user['workspace'], 'research_job', research['id'], {**research, 'doctor_id':None}, research['version'])
            tx.audit(user['workspace'], user['id'], 'doctor.delete', 'doctor', item_id)
            return {'id': item_id}

    def review(self, user, item_id, body, kind='content'):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
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
                if action == 'approve' and kind == 'policy' and old.get('text_is_summary'):
                    raise HTTPException(409, '目录摘要不是政策原文，请先导入原文并核对。')
                next_status = 'approved' if action == 'approve' else 'rejected'
            else:
                if status != 'approved':
                    raise HTTPException(409, '只能停用已审核资料。')
                next_status = 'retired'
            updated = {**old, 'status': next_status, 'review_reason': body.reason}
            if action == 'approve':
                updated.update(approved_by=user['id'], approved_at=now())
            item = tx.update(user['workspace'], kind, item_id, updated, body.version)
            tx.audit(user['workspace'], user['id'], f'{kind}.{action}', kind, item_id, {'reason': body.reason})
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
        for kind, item_id in [('drug', data.get('drug_id')), ('drug', data.get('competitor_id'))]:
            if item_id:
                item = require_item(tx, tenant, kind, item_id)
                if publishing and item['status'] != 'published':
                    raise HTTPException(409, '场景绑定的药品必须先发布。')
        if data.get('drug_id'):
            require_department_match(require_item(tx, tenant, 'drug', data['drug_id']),
                                     require_item(tx, tenant, 'doctor', data['doctor_id']))
        for item_id in data.get('policy_ids', []):
            item = require_item(tx, tenant, 'policy', item_id)
            if publishing and not policy_usable(item):
                raise HTTPException(409, '场景绑定的政策必须先审核。')

    def publish(self, user, kind, item_id, version):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if old['status'] != 'draft':
                raise HTTPException(409, '只能发布草稿。')
            if kind == 'scenario':
                self.validate_bindings(tx, user['workspace'], old, publishing=True)
            if kind == 'doctor':
                for evidence in old.get('fact_evidence', []):
                    source = tx.get(user['workspace'], 'content', evidence['content_id'])
                    page = next((p for p in source.get('pages', []) if p['number'] == evidence['page']), None) if source else None
                    if (not content_usable(source) or source['version'] != evidence['content_version']
                            or source.get('source_url') != evidence['source_url'] or not page
                            or evidence['quote'] not in page['text'] or evidence['quote'] not in old.get('public_facts', '')):
                        raise HTTPException(409, '医生画像引用的审核资料已变更或不可用，请重新核对。')
            if kind == 'policy_rule':
                policy = require_item(tx, user['workspace'], 'policy', old['policy_id'])
                if not policy_usable(policy) or not any(old['quote'] in page['text'] for page in policy['pages']):
                    raise HTTPException(409, '规则需要引用已审核、有效政策的原文。')
                if old['action'] == 'pause' and old['risk'] != 'high':
                    raise HTTPException(409, '只有高风险规则可以暂停训练。')
                old = {**old, 'policy_version': policy['version'], 'runtime_enforced': True}
            if kind == 'drug':
                self.validate_drug_terms(tx, user['workspace'], old, publishing=True)
                if old.get('ownership') not in ('company', 'competitor'):
                    raise HTTPException(409, '发布药品前请确认本公司产品或竞品归属。')
                for content_id in old.get('content_ids', []):
                    if not content_usable(require_item(tx, user['workspace'], 'content', content_id)):
                        raise HTTPException(409, '药品关联资料必须先审核。')
                for relation in old.get('comparisons', []):
                    if relation['drug_id'] in (item_id, old.get('drug_id')):
                        raise HTTPException(409, '药品不能与自身建立同类关系。')
                    require_item(tx, user['workspace'], 'drug', relation['drug_id'])
            identity = old.get(f'{kind}_id') if kind in ('doctor', 'drug') else None
            if identity:
                current = require_item(tx, user['workspace'], kind, identity)
                if current['version'] != old['base_version']:
                    raise HTTPException(409, '内容已更新，请重新创建草稿。')
                tx.create(user['workspace'], f'{kind}_history', {**current, f'{kind}_id': current['id'], 'source_version': current['version']})
                changes = {k: v for k, v in old.items() if k not in ('id', 'version', 'created_at', 'updated_at', f'{kind}_id', 'base_version', 'previous_id', 'series_id')}
                item = tx.update(user['workspace'], kind, current['id'], {**current, **changes, 'status':'published', 'published_by':user['id'], 'published_at':now()}, current['version'])
                tx.update(user['workspace'], kind, item_id, {**old, 'status':'archived'}, version)
                tx.audit(user['workspace'], user['id'], f'{kind}.publish', kind, current['id'], {'draft_id': item_id})
                return item
            item = tx.update(user['workspace'], kind, item_id, {**old,'status':'published','published_by':user['id'],'published_at':now()}, version)
            tx.audit(user['workspace'], user['id'], f'{kind}.publish', kind, item_id)
            return item

    def retire(self, user, kind, item_id, version):
        with self.store.transaction(user['workspace']) as tx:
            old = require_item(tx, user['workspace'], kind, item_id)
            if old['status'] != 'published':
                raise HTTPException(409, '只能停用已发布的药品。')
            item = tx.update(user['workspace'], kind, item_id, {**old, 'status':'retired'}, version)
            tx.audit(user['workspace'], user['id'], f'{kind}.retire', kind, item_id)
            return item

