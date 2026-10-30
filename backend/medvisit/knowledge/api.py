import html
import json
from pathlib import Path
from tempfile import SpooledTemporaryFile
from zipfile import ZipFile, ZIP_DEFLATED

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from ..core.identity import current_role


class CheckRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(min_length=1,max_length=6000)
    context: str = Field(default='',max_length=3000)


def medical_router(corpus, verifier):
    router = APIRouter(prefix='/api/medical')

    def visible(source, approvals):
        return bool(source.get('pages')) and all((source['id'], p['number']) in approvals for p in source['pages'])

    def authorized_source(source_id, version=None):
        item = corpus.source(source_id, version)
        if not item or (current_role.get() != 'admin' and not visible(item, corpus.approval_snapshot({'sources':[item]}))):
            raise HTTPException(404,'医学依据不存在。')
        return item

    @router.get('')
    def status():
        result = corpus.status()
        if current_role.get() == 'admin':
            return result
        data = corpus.load()
        approvals = corpus.approval_snapshot(data)
        ids = {source['id'] for source in data['sources'] if visible(source, approvals)}
        derived = [{key:value for key,value in source.items() if key not in ('pages','original_path')} | {'original_available':False}
                   for source in corpus.approved_sources()]
        return {**result, 'sources':[source for source in result['sources'] if source['id'] in ids] + derived,
                'products':[], 'compiled':{}}

    @router.post('/audit')
    def audit():
        if current_role.get() != 'admin':
            raise HTTPException(403, '仅管理员可审计待审核资料。')
        return corpus.audit()

    @router.post('/check')
    async def check(body: CheckRequest):
        if not body.text.strip():
            raise HTTPException(422,'请输入待核验的原话。')
        return await verifier.check(body.text, body.context)

    @router.get('/wiki.zip')
    def export_wiki():
        if current_role.get() != 'admin':
            raise HTTPException(403, '仅管理员可导出待审核资料。')
        data = corpus.load()
        if not data['sources']:
            raise HTTPException(404,'医学依据库尚未导入。')
        wiki_root = corpus.wiki_root()
        paths = [corpus.root / source['original_path'] for source in data['sources'] if (corpus.root/source['original_path']).is_file()]
        wiki_paths = list((wiki_root/'wiki').rglob('*.md'))
        wiki_paths += [wiki_root/'purpose.md',wiki_root/'schema.md']
        if (wiki_root/'AGENTS.md').is_file(): wiki_paths.append(wiki_root/'AGENTS.md')
        allowed = []
        for path,base in [(p,corpus.root) for p in paths]+[(p,wiki_root) for p in wiki_paths]:
            resolved = path.resolve()
            if (not resolved.is_relative_to(base.resolve()) or path.is_symlink()
                    or not path.is_file()):
                raise HTTPException(409,'资料文件不完整，暂不能导出。')
            allowed.append((path,base))
        if sum(path.stat().st_size for path,_ in allowed)>400_000_000:
            raise HTTPException(413,'资料较大，请从服务器备份目录取得项目。')
        archive = SpooledTemporaryFile(max_size=8_000_000)
        try:
            with ZipFile(archive,'w',ZIP_DEFLATED) as output:
                for path,base in allowed:
                    output.write(path,str(path.relative_to(base)))
                manifest=[{key:source.get(key) for key in ('id','title','url','sha256','original_path','retrieved_at')}
                    for source in data['sources']]
                output.writestr('raw/sources/manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
            archive.seek(0)
        except BaseException:
            archive.close()
            raise
        def chunks():
            try:
                while block:=archive.read(65536):
                    yield block
            finally:
                archive.close()
        return StreamingResponse(chunks(),media_type='application/zip',
            headers={'Content-Disposition':'attachment; filename="BreathOn-medical-wiki.zip"'})

    @router.get('/sources/{source_id}')
    def source(source_id: str, version: str | None = None):
        item = authorized_source(source_id, version)
        body = ''.join(f'<section id="p{page["number"]}"><h2>第 {page["number"]} 页 / 段</h2><pre>{html.escape(page["text"])}</pre></section>' for page in item['pages'])
        notice = '已审核平台资料；自动判断仍需复核。' if source_id.startswith('platform-document-') else '自动归档，未经人工医学审核。'
        return HTMLResponse('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<style>body{max-width:900px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style>'
            f'<title>{html.escape(item["title"])}</title><h1>{html.escape(item["title"])}</h1>'
            f'<p>{notice} 时间：{html.escape(item["retrieved_at"])}</p>'
            f'<p><a href="{html.escape(item["url"],quote=True)}" rel="noreferrer">原文来源</a> · '
            +(f'<a href="{source_id}/original?version={item["sha256"]}">下载归档原件</a>' if (corpus.root/item['original_path']).is_file() else '原件未下载到此环境，请从来源链接核对')+f'</p>{body}',
            headers={'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",'X-Content-Type-Options':'nosniff'})

    @router.get('/sources/{source_id}/original')
    def original(source_id: str, version: str | None = None):
        # The archived binary is not proven identical to the reviewed platform asset.
        if current_role.get() != 'admin':
            raise HTTPException(404,'归档原件暂不可读取。')
        item = authorized_source(source_id, version)
        path = (corpus.root / item['original_path']).resolve()
        if not path.is_relative_to((corpus.root/'raw'/'sources').resolve()) or not path.is_file():
            raise HTTPException(404,'归档原件暂不可读取。')
        return FileResponse(path, media_type='application/octet-stream',filename=Path(item['original_path']).name,
            headers={'X-Content-Type-Options':'nosniff'})

    return router
