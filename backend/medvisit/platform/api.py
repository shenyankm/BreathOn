from typing import Literal
import asyncio
import base64
import hashlib
import json
import subprocess
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from .catalog import Catalog, require_item
from .departments import with_departments
from .models import Lesson, LessonEdit, Audience, AudienceEdit, Content, ContentEdit, Policy, PolicyEdit, PolicyRule, PolicyRuleEdit, Drug, DrugEdit, TaxonomyEdit, Doctor, DoctorEdit, Rubric, RubricEdit, Scenario, ScenarioEdit, Publish, Transition, content_usable, policy_usable
from .pdf_extract import extract_pdf
from .training import prepare_training, prepare_free_context, snapshot
from .calibration import Calibrator, CalibrationSample
from .curriculum import LessonState, SettingsEdit, curriculum, home_summary, member_settings, review_queue, set_lesson, update_settings
from .operations import Operations, Review, Retrain
from .importer import Batch, import_content
from .generation import GenerateScenario, generate_scenario
from .cases import Cases, CaseFromRecord, CaseEdit, CaseImport
from .progress import Prices, capture_prices, save_prices, personal_progress
from .sharing import TrainingTemplate, export_template, import_template
from ..core.identity import current_actor, current_role

Kind = Literal['lesson', 'audience', 'content', 'policy', 'policy_rule', 'drug', 'doctor', 'rubric', 'scenario']
CREATE_MODELS = {'lesson': Lesson, 'audience': Audience, 'content': Content, 'policy': Policy, 'policy_rule': PolicyRule, 'drug': Drug, 'doctor': Doctor, 'rubric': Rubric, 'scenario': Scenario}
EDIT_MODELS = {'lesson': LessonEdit, 'audience': AudienceEdit, 'content': ContentEdit, 'policy': PolicyEdit, 'policy_rule': PolicyRuleEdit, 'drug': DrugEdit, 'doctor': DoctorEdit, 'rubric': RubricEdit, 'scenario': ScenarioEdit}


def parse(model, body):
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc


def platform_router(store, settings, records):
    catalog = Catalog(store)
    calibrator = Calibrator(store, settings)
    operations = Operations(store, records)
    cases = Cases(store, records)
    router = APIRouter(prefix='/api')

    user = {'id': 'local', 'workspace': 'local', 'team': ''}

    def initialize():
        with store.transaction(write=False) as tx:
            setup = tx.get('', 'system', 'setup')
        if setup:
            user['workspace'] = setup['workspace']
        catalog.seed(user['workspace'], user['id'])

    def current_user():
        return {**user, 'id':current_actor.get() or user['id']}

    from .health import health_router
    router.include_router(health_router(store, current_user))
    from .management import management_router
    router.include_router(management_router(store, settings, records, current_user))

    @router.get('/progress')
    def progress(days: int = Query(default=30, ge=1, le=90), user=Depends(current_user)):
        return personal_progress(store, records, user, days)

    @router.get('/home')
    def home(user=Depends(current_user)):
        return home_summary(store, records, user)

    @router.get('/me/review-queue')
    def review_queue_get(user=Depends(current_user)):
        return review_queue(store, user)

    @router.get('/curriculum')
    def curriculum_get(user=Depends(current_user)):
        return curriculum(store, user)

    @router.put('/curriculum/lessons/{lesson_id}')
    def curriculum_set(lesson_id: str, body: LessonState, user=Depends(current_user)):
        return set_lesson(store, user, lesson_id, body)

    @router.get('/me/settings')
    def settings_get(user=Depends(current_user)):
        return member_settings(store, user)

    @router.put('/me/settings')
    def settings_put(body: SettingsEdit, user=Depends(current_user)):
        return update_settings(store, user, body)

    @router.get('/usage/prices')
    def prices_get(user=Depends(current_user)):
        return capture_prices(store, user)

    @router.put('/usage/prices')
    def prices_save(body: Prices, user=Depends(current_user)):
        return save_prices(store, user, body)

    @router.post('/scenarios/generate', status_code=201)
    async def scenario_generate(body: GenerateScenario, user=Depends(current_user)):
        return await generate_scenario(store, settings, records, user, body)

    @router.get('/scenarios/{item_id}/export')
    def scenario_export(item_id: str, user=Depends(current_user)):
        return export_template(store, user, item_id)

    @router.post('/scenarios/import', status_code=201)
    def scenario_import(body: TrainingTemplate, user=Depends(current_user)):
        return import_template(store, user, body)

    @router.post('/sessions/{item_id}/cases', status_code=201)
    def case_extract(item_id: str, body: CaseFromRecord, user=Depends(current_user)):
        return cases.from_record(user, item_id, body)

    @router.get('/cases')
    def case_list(user=Depends(current_user)):
        return cases.list(user)

    @router.post('/cases/import', status_code=201)
    def case_import(body: CaseImport, user=Depends(current_user)):
        return cases.import_case(user, body)

    @router.get('/cases/{item_id}')
    def case_get(item_id: str, user=Depends(current_user)):
        return cases.get(user, item_id)

    @router.put('/cases/{item_id}')
    def case_edit(item_id: str, body: CaseEdit, user=Depends(current_user)):
        return cases.edit(user, item_id, body)

    @router.post('/cases/{item_id}/confirm')
    def case_confirm(item_id: str, body: Publish, user=Depends(current_user)):
        return cases.confirm(user, item_id, body.version)

    @router.get('/cases/{item_id}/export')
    def case_export(item_id: str, format: Literal['json','markdown'] = 'json', user=Depends(current_user)):
        package = cases.export(user, item_id)
        if format == 'json':
            content, extension, media_type = json.dumps(package, ensure_ascii=False, indent=2), 'json', 'application/json'
        else:
            item = package['case']
            fields = {'title':'案例名称','situation':'适用情境','approach':'回应方式','rationale':'处理理由','limitations':'适用边界'}
            content = '# 沟通训练案例\n\n仅为沟通参考，导出不代表原话和医学结论已通过外部核实。\n\n'
            content += '\n\n'.join(f'## {label}\n\n{item[key]}' for key,label in fields.items())
            content += '\n\n## 原记录片段\n\n'+'\n\n'.join(('医生' if quote['role']=='doctor' else '学员')+'：'+quote['text'] for quote in item['quotes'])
            content += '\n\n## 资料引用\n\n'+'\n\n'.join(f"{source['title']} · {source['version_label']} · 第 {source['page']} 页\n\n{source['quote']}\n\n{source['source_url']}" for source in item['sources'])
            extension, media_type = 'md', 'text/markdown'
        return Response(content=content, media_type=media_type, headers={'Content-Disposition':f'attachment; filename="case-{item_id}.{extension}"', 'X-Content-Type-Options':'nosniff'})

    @router.post('/content/import', status_code=201)
    def content_import(body: Batch, user=Depends(current_user)):
        return import_content(store,user,body)


    @router.get('/sessions/{item_id}/reviews')
    def reviews(item_id: str, user=Depends(current_user)):
        return operations.reviews(user, item_id)

    @router.post('/sessions/{item_id}/reviews', status_code=201)
    def review_create(item_id: str, body: Review, user=Depends(current_user)):
        return operations.review(user, item_id, body)


    @router.post('/sessions/{item_id}/retrain', status_code=201)
    def retrain_create(item_id: str, body: Retrain, user=Depends(current_user)):
        return operations.retrain(user, item_id, body)

    @router.get('/sessions/{item_id}/remediations')
    def session_remediations(item_id: str, user=Depends(current_user)):
        record = operations.record(user,item_id)
        user = {**user, 'workspace': record.get('workspace') or user['workspace']}
        with store.transaction(user['workspace'],write=False) as tx:
            ids=[p['id'] for p in tx.list(user['workspace'],'remediation') if p['parent_record_id']==item_id]
        return [operations.remediation_progress(user,plan_id) for plan_id in ids]

    @router.get('/remediations')
    def remediations(user=Depends(current_user)):
        with store.transaction(user['workspace'], write=False) as tx:
            return tx.list(user['workspace'], 'remediation')

    @router.get('/remediations/{item_id}/next')
    def remediation_next(item_id: str, user=Depends(current_user)):
        return operations.remediation_choice(user, item_id)

    @router.get('/remediations/{item_id}/progress')
    def remediation_progress(item_id: str, user=Depends(current_user)):
        return operations.remediation_progress(user, item_id)

    @router.get('/rubrics/{rubric_id}/samples')
    def calibration_samples(rubric_id: str, user=Depends(current_user)):
        return calibrator.list_samples(user, rubric_id)

    @router.get('/rubrics/{rubric_id}/calibration/runs')
    def calibration_runs(rubric_id: str, user=Depends(current_user)):
        with store.transaction(user['workspace'], write=False) as tx:
            return [{k:v for k,v in row.items() if k != 'samples'} for row in tx.list(user['workspace'], 'calibration_run') if row['rubric_id'] == rubric_id][:20]

    @router.post('/calibration/samples', status_code=201)
    def calibration_sample(body: CalibrationSample, user=Depends(current_user)):
        return calibrator.add_sample(user, body)

    @router.post('/rubrics/{rubric_id}/calibration', status_code=202)
    def calibration_start(rubric_id: str, body: Publish, tasks: BackgroundTasks, user=Depends(current_user)):
        run = calibrator.start(user, rubric_id, body.version)
        tasks.add_task(calibrator.execute, user, run['id'])
        return {key:value for key,value in run.items() if key != 'samples'}

    @router.get('/calibration/runs/{run_id}')
    def calibration_run(run_id: str, user=Depends(current_user)):
        return calibrator.get(user, run_id)

    @router.post('/calibration/runs/{run_id}/cancel')
    def calibration_cancel(run_id: str, user=Depends(current_user)):
        return calibrator.cancel(user, run_id)

    @router.post('/content/pdf', status_code=201)
    async def content_pdf(request: Request, user=Depends(current_user)):
        if request.headers.get('content-type') != 'application/pdf':
            raise HTTPException(415, '请使用 application/pdf 上传。')
        chunks, length = [], 0
        async for chunk in request.stream():
            length += len(chunk)
            if length > 20_000_000:
                raise HTTPException(413, 'PDF超过20MB上限。')
            chunks.append(chunk)
        raw = b''.join(chunks)
        try:
            result = await asyncio.to_thread(extract_pdf, raw)
        except (ValueError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(422, '解析超时，请拆分PDF后重试。' if isinstance(exc, subprocess.TimeoutExpired) else str(exc)) from exc
        def persist():
            with store.transaction(user['workspace']) as tx:
                # shortcut: DB assets keep local/Compose backups together; use object storage for large libraries.
                asset = tx.create(user['workspace'], 'asset', {'data': base64.b64encode(raw).decode(),
                    'sha256': hashlib.sha256(raw).hexdigest(), 'size': length, 'created_by': user['id']})
                tx.audit(user['workspace'], user['id'], 'content.upload', 'asset', asset['id'])
            return {**result, 'asset_id': asset['id'], 'sha256': asset['sha256']}
        return await asyncio.to_thread(persist)

    @router.get('/catalog/{kind}/{item_id}/file')
    def content_file(kind: Literal['content', 'policy'], item_id: str, user=Depends(current_user)):
        item = catalog.get(user, kind, item_id)
        if current_role.get() != 'admin' and not (policy_usable(item) if kind == 'policy' else content_usable(item)):
            raise HTTPException(404, '记录不存在。')
        if not item.get('asset_id'):
            raise HTTPException(404, '此版本没有PDF原件。')
        with store.transaction(user['workspace'], write=False) as tx:
            asset = require_item(tx, user['workspace'], 'asset', item['asset_id'])
        try:
            raw = base64.b64decode(asset['data'], validate=True)
            if len(raw) != asset['size'] or hashlib.sha256(raw).hexdigest() != asset['sha256']:
                raise ValueError('PDF checksum mismatch')
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(409, 'PDF原件损坏或校验失败，请从备份恢复或重新上传。') from exc
        return Response(content=raw, media_type='application/pdf',
            headers={'Content-Disposition': f'attachment; filename="document-{item_id}.pdf"', 'X-Content-Type-Options': 'nosniff'})

    @router.get('/catalog/taxonomy')
    def taxonomy_list(user=Depends(current_user)):
        rows = catalog.taxonomy(user)
        if current_role.get() != 'admin':
            rows = [{**row, 'terms':[term for term in row['terms'] if term['status'] == 'active']} for row in rows]
        return rows

    @router.put('/catalog/taxonomy/{kind}')
    def taxonomy_edit(kind: Literal['category', 'disease', 'mechanism', 'dosage_form', 'region'], body: TaxonomyEdit, user=Depends(current_user)):
        return catalog.update_taxonomy(user, kind, body)

    @router.get('/catalog/{kind}')
    def catalog_list(kind: Kind, user=Depends(current_user)):
        rows = [item for item in catalog.list(user, kind) if item.get('status') != 'archived']
        if current_role.get() != 'admin':
            allowed = 'approved' if kind in ('content', 'policy') else 'published'
            rows = [item for item in rows if item.get('status') == allowed]
            if kind in ('content', 'policy'):
                rows = [item for item in rows if item['usable']]
        return rows

    @router.get('/catalog/{kind}/{item_id}')
    def catalog_get(kind: Kind, item_id: str, user=Depends(current_user)):
        item = catalog.get(user, kind, item_id)
        allowed = 'approved' if kind in ('content', 'policy') else 'published'
        if current_role.get() != 'admin' and (item.get('status') != allowed or
                kind == 'content' and not content_usable(item) or kind == 'policy' and not policy_usable(item)):
            raise HTTPException(404, '记录不存在。')
        return item

    @router.get('/practice/preview')
    def practice_preview(drug_id: str = Query(min_length=1, max_length=80), doctor_id: str = Query(min_length=1, max_length=80),
                         focus: str | None = Query(default=None, max_length=20), user=Depends(current_user)):
        return prepare_free_context(store, user, drug_id, doctor_id, focus)

    @router.get('/scenarios/{item_id}/preview')
    def scenario_preview(item_id: str, stage: str = 'full', user=Depends(current_user)):
        return snapshot(prepare_training(store, user, item_id, stage, preview=current_role.get() == 'admin'))

    @router.post('/catalog/{kind}', status_code=201)
    def catalog_create(kind: Kind, body: dict, user=Depends(current_user)):
        return with_departments(kind, catalog.create(user, kind, parse(CREATE_MODELS[kind], body)))

    @router.put('/catalog/{kind}/{item_id}')
    def catalog_edit(kind: Kind, item_id: str, body: dict, user=Depends(current_user)):
        return with_departments(kind, catalog.edit(user, kind, item_id, parse(EDIT_MODELS[kind], body)))

    @router.delete('/catalog/doctor/{item_id}')
    def doctor_delete(item_id: str, version: int = Query(ge=1), user=Depends(current_user)):
        return catalog.delete_doctor(user, item_id, version)

    @router.post('/catalog/{kind}/{item_id}/revision', status_code=201)
    def catalog_revision(kind: Kind, item_id: str, user=Depends(current_user)):
        return with_departments(kind, catalog.revision(user, kind, item_id))

    @router.post('/catalog/{kind}/{item_id}/review')
    def content_review(kind: Literal['content', 'policy'], item_id: str, body: Transition, user=Depends(current_user)):
        return catalog.review(user, item_id, body, kind)

    @router.post('/catalog/{kind}/{item_id}/publish')
    def catalog_publish(kind: Literal['doctor','drug','policy_rule','rubric','scenario','lesson'], item_id: str, body: Publish, user=Depends(current_user)):
        return with_departments(kind, catalog.publish(user, kind, item_id, body.version))

    @router.post('/catalog/drug/{item_id}/retire')
    def drug_retire(item_id: str, body: Publish, user=Depends(current_user)):
        return catalog.retire(user, 'drug', item_id, body.version)

    return router, initialize, current_user, operations
