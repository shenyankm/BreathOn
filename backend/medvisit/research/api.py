from typing import Literal
from uuid import UUID
import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from .agents import PROFILES
from .archive import read_source
from .models import DoctorResearchRequest, DoctorDraftRequest, PolicyDraftRequest, ResearchRequest, WatchRequest


def research_router(service):
    router = APIRouter(prefix='/api/research')

    @router.get('')
    def research_state():
        jobs = service.list('research_job')[:20]
        return {'profiles':[{'kind':kind, **profile} for kind, profile in PROFILES.items()],
            'jobs':[service.get_job(job['id']) if job['status'] == 'running' else job for job in jobs],
            'sources':service.list('research_source'),
            'watches':service.list('research_watch'),
            'configured':bool(service.settings.deepseek_api_key and service.settings.deepseek_search_enabled)}

    @router.post('/jobs', status_code=201)
    async def start_research(body: ResearchRequest):
        return await service.start(body)

    @router.post('/doctor-jobs', status_code=201)
    async def research_doctor(body: DoctorResearchRequest):
        return await service.start(body)

    @router.get('/jobs/{job_id}')
    def research_job(job_id: UUID):
        return service.get_job(str(job_id))

    @router.post('/jobs/{job_id}/doctor-draft', status_code=201)
    def doctor_draft(job_id: UUID, body: DoctorDraftRequest):
        return service.doctor_draft(str(job_id), body)

    @router.post('/jobs/{job_id}/policy-draft', status_code=201)
    def policy_draft(job_id: UUID, body: PolicyDraftRequest):
        return service.policy_draft(str(job_id), body)

    @router.post('/policy-file', status_code=201)
    async def policy_file(request: Request, title: str):
        return await asyncio.to_thread(service.policy_file, title, await request.body())

    @router.get('/policy-file/{item_id}/original')
    def policy_file_original(item_id: UUID):
        item, data = service.policy_file_original(str(item_id))
        return Response(data, media_type='application/octet-stream', headers={
            'Content-Disposition':f'attachment; filename="policy-{item_id}.{item["format"]}"',
            'X-Content-Type-Options':'nosniff'})

    @router.post('/jobs/{job_id}/cancel')
    async def cancel_research(job_id: UUID):
        return await service.cancel(str(job_id))

    @router.put('/jobs/{job_id}/watch')
    def watch_research(job_id: UUID, body: WatchRequest):
        return service.set_watch(str(job_id), body.enabled)

    @router.get('/sources/{source_id}/{version}/{format}')
    def archived_source(source_id: str, version: str, format: Literal['html', 'original']):
        with service.store.transaction(write=False) as tx:
            source = tx.get(service.workspace, 'research_source', source_id)
        if not source or not any(item['raw_sha256'] == version for item in source['versions']):
            raise HTTPException(404, '归档版本不存在。')
        try:
            metadata, _ = read_source(service.archives, source_id, version)
        except (ValueError, OSError):
            raise HTTPException(404, '归档文件暂不可读取。')
        folder = service.archives / source_id / version
        headers = {'Content-Security-Policy':"sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
            'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'}
        if format == 'html':
            return FileResponse(folder / 'reader.html', media_type='text/html; charset=utf-8', headers=headers)
        return FileResponse(folder / metadata['original_file'], media_type='application/octet-stream',
            filename=f'{source_id}-{version[:12]}.{metadata["kind"]}', headers=headers)

    return router
